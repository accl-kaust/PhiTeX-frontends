//! The files the build reads, in the module's shared memory, so every
//! engine thread sees each one without a copy or a call. Two sources:
//!
//! - **By name**, from the host: the project's own files (given before the
//!   build asks), the extension's bundled texmf/ (the LaTeX kernel), and,
//!   without Shelf's index, anything (the host resolves the name itself).
//! - **Shelf's packs**: a name is resolved here, by Shelf's index and the
//!   engine's search order ([`crate::shelf`]); a name the index lacks is
//!   absent at once and never leaves the machine. The path's pack and the
//!   packs its loading reads are asked of the host by id, and every file of
//!   each is kept by path, so a package and what it loads cost one round.
//!
//! Whatever is asked of the host (`phitex.want` a name, `phitex.fetch` a
//! pack) is asked once, from the thread that needs it, which waits on a
//! condition variable until the host's thread 0 answers (`ph_provide`,
//! `ph_pack`). Absent is an answer too, kept like a present file: TeX
//! probes many names that are nowhere.
//!
//! The session (phitex-live) asks in two steps, as kpathsea and a read:
//! where a name is ([`Files::locate`], which waits as above) and the bytes
//! at that path ([`Files::read`], from memory: what was located was
//! given), each file shared, copied only into the engine's hands.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use crate::shelf::{self, Index};

/// A file as the engine takes it: the path it reports, and the bytes.
pub type Found = (String, Vec<u8>);

/// A file kept: its path, and its bytes, shared.
type Kept = (String, Arc<Vec<u8>>);

enum Entry {
    /// Asked for; the host has not answered yet.
    Asked,
    /// The host's answer (none: the file is nowhere).
    Given(Option<Kept>),
}

enum Pack {
    Asked,
    /// Its files are in `by_path` (or it could not be had).
    Done,
}

#[derive(Default)]
struct State {
    by_name: HashMap<String, Entry>,
    /// The host's files by the path it gave (without `./`).
    by_given_path: HashMap<String, Arc<Vec<u8>>>,
    /// Shelf's files by texmf path, from the packs fetched.
    by_path: HashMap<String, Arc<Vec<u8>>>,
    packs: HashMap<String, Pack>,
    index: Option<Arc<Index>>,
    /// The extension's bundled texmf/ (flat, by name): asked of the host by
    /// name, ahead of Shelf, unless the engine's own tree has the name
    /// first (tex/xelatex, ...).
    bundled: HashSet<String>,
}

/// What the files ask the host for.
pub trait Host: Send + Sync {
    /// A file by name: answered with [`Files::provide`].
    fn want(&self, name: &str);
    /// A Shelf pack by id: answered with [`Files::pack`].
    fn fetch(&self, pack: &str);
}

#[derive(Default)]
pub struct Files {
    state: Mutex<State>,
    answered: Condvar,
}

impl Files {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait<'a>(&self, g: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        self.answered.wait(g).unwrap_or_else(PoisonError::into_inner)
    }

    /// Shelf's index from now on (none: names go to the host).
    pub fn set_index(&self, index: Option<Index>, bundled: HashSet<String>) {
        let mut s = self.lock();
        s.index = index.map(Arc::new);
        s.bundled = bundled;
    }

    /// Where the file `name` is for `engine` (Shelf's name): the path the
    /// engine reports (`/usr/share/texmf-dist/...` for Shelf's, the host's
    /// for its own), waiting for the host when it must.
    pub fn locate(&self, name: &str, engine: &str, host: &dyn Host) -> Option<String> {
        self.find(name, engine, host).map(|(p, _)| p)
    }

    /// The bytes of the file at `path`, as [`Files::locate`] gave it (or a
    /// name the host gave, the project's: `main.tex`); none: not here.
    pub fn read(&self, path: &str) -> Option<Arc<Vec<u8>>> {
        let s = self.lock();
        if let Some(rel) = path.strip_prefix(shelf::TL) {
            return s.by_path.get(rel).cloned();
        }
        let plain = path.strip_prefix("./").unwrap_or(path);
        if let Some(b) = s.by_given_path.get(plain) {
            return Some(b.clone());
        }
        match s.by_name.get(plain) {
            Some(Entry::Given(Some((_, b)))) => Some(b.clone()),
            _ => None,
        }
    }

    /// The file `name` for `engine` (Shelf's name), waiting for the host
    /// when it must.
    fn find(&self, name: &str, engine: &str, host: &dyn Host) -> Option<Kept> {
        let mut s = self.lock();
        if let Some(Entry::Given(f)) = s.by_name.get(name) {
            return f.clone();
        }
        let Some(ix) = s.index.clone() else {
            return self.by_name(s, name, host);
        };
        let path = ix.resolve(name, shelf::format_of(name), engine);
        let engine_tree = path.is_some_and(|p| ["tex/xelatex/", "tex/xetex/", "tex/lualatex/", "tex/luatex/"].iter().any(|t| p.starts_with(t)));
        if !name.contains('/') && s.bundled.contains(name) && !engine_tree {
            return self.by_name(s, name, host);
        }
        let path = path?;
        let packs = ix.packs(path, engine);
        let own = (*packs.first()?).to_owned();
        for id in packs {
            if !s.packs.contains_key(id) {
                s.packs.insert(id.to_owned(), Pack::Asked);
                host.fetch(id);
            }
        }
        loop {
            if let Some(b) = s.by_path.get(path) {
                return Some((format!("{}{path}", shelf::TL), b.clone()));
            }
            if matches!(s.packs.get(&own), Some(Pack::Done)) {
                return None;
            }
            s = self.wait(s);
        }
    }

    /// The path and content key of the file `name` would be for `engine`
    /// (Options::content_key), from Shelf's index alone, nothing fetched: a
    /// Shelf file's path as [`Files::get`] gives it, its key the id of its
    /// pack (which names the pack's content) and its texmf path. None for
    /// any other (the project's, the bundled texmf/'s), which the engine
    /// finds and hashes.
    pub fn key(&self, name: &str, engine: &str) -> Option<(String, Vec<u8>)> {
        let s = self.lock();
        let ix = s.index.clone()?;
        let rel = ix.resolve(name, shelf::format_of(name), engine)?;
        let engine_tree = ["tex/xelatex/", "tex/xetex/", "tex/lualatex/", "tex/luatex/"].iter().any(|t| rel.starts_with(t));
        if matches!(s.by_name.get(name), Some(Entry::Given(_))) || (!name.contains('/') && s.bundled.contains(name) && !engine_tree) {
            return None;
        }
        let pack = ix.pack_of(rel)?;
        Some((format!("{}{rel}", shelf::TL), [pack.as_bytes(), b"\0", rel.as_bytes()].concat()))
    }

    fn by_name(&self, mut s: MutexGuard<'_, State>, name: &str, host: &dyn Host) -> Option<Kept> {
        if !s.by_name.contains_key(name) {
            s.by_name.insert(name.to_owned(), Entry::Asked);
            host.want(name);
        }
        loop {
            if let Some(Entry::Given(f)) = s.by_name.get(name) {
                return f.clone();
            }
            s = self.wait(s);
        }
    }

    /// The host's answer for `name` (none: it is nowhere), given before it
    /// was asked for (the project's own files) or after.
    pub fn provide(&self, name: &str, file: Option<Found>) {
        let file = file.map(|(p, b)| (p, Arc::new(b)));
        let mut s = self.lock();
        if let Some((p, b)) = &file {
            s.by_given_path.insert(p.strip_prefix("./").unwrap_or(p).to_owned(), b.clone());
        }
        s.by_name.insert(name.to_owned(), Entry::Given(file));
        drop(s);
        self.answered.notify_all();
    }

    /// The host's answer for pack `id`: gunzipped, or none (it could not be
    /// had: its files are absent).
    pub fn pack(&self, id: &str, raw: Option<&[u8]>) {
        let files = raw.and_then(shelf::unpack).unwrap_or_default();
        let mut s = self.lock();
        for (path, bytes) in files {
            s.by_path.entry(path).or_insert_with(|| Arc::new(bytes));
        }
        s.packs.insert(id.to_owned(), Pack::Done);
        drop(s);
        self.answered.notify_all();
    }
}
