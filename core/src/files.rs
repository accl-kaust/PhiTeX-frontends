//! The files the build reads, in the module's shared memory, so every
//! engine thread sees each one without a copy or a call. Two sources:
//!
//! - **By name**, from the host: the project's own files (given before the
//!   build asks), the extension's bundled texmf/ (the LaTeX kernel), and,
//!   without Shelf's index, anything (the host resolves the name itself).
//! - **Shelf's packs**, through phitex-shelf ([`shelf::Files`], one an
//!   engine): a name resolved by Shelf's index and the engine's search
//!   order, its pack and the packs its loading reads fetched (each once,
//!   checked against the release's pack table), a name the index lacks
//!   absent at once. The packs' source is the host ([`HostPacks`]): every
//!   pack a file needs asked of it at once, the thread waiting for them.
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
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};

use phitex_shelf::{self as shelf, Fetch, Index, PackSource};

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

/// The host, as the files ask it.
pub trait Host: Send + Sync {
    /// A file by name (`phitex.want`): answered by `ph_provide`.
    fn want(&self, name: &str);
    /// Shelf's pack `id` (`phitex.fetch`): answered by `ph_pack`.
    fn fetch(&self, pack: &str);
}

/// What a pack's fetch is told (the session's progress: `Meter::fetch`).
pub type FetchHook = Arc<dyn Fn(&Fetch<'_>) + Send + Sync>;

#[derive(Default)]
struct State {
    by_name: HashMap<String, Entry>,
    /// The host's files by the path it gave (the project's, as `./name`).
    by_given_path: HashMap<String, Arc<Vec<u8>>>,
    index: Option<Arc<Index>>,
    /// The extension's bundled texmf/: these names the host's, not Shelf's.
    bundled: HashSet<String>,
    /// Shelf's files, one an engine (made at its first use).
    shelves: HashMap<&'static str, Arc<shelf::Files>>,
    /// Packs asked of the host and not taken yet.
    asked: HashSet<String>,
    /// The host's answers, waiting to be taken: the bytes as served, or why not.
    arrived: HashMap<String, Result<Vec<u8>, String>>,
}

#[derive(Default)]
pub struct Files {
    state: Mutex<State>,
    answered: Condvar,
    /// Where packs are asked for (`set_host`).
    host: OnceLock<&'static dyn Host>,
    /// Who hears of each pack (the open document's progress).
    hook: Mutex<Option<FetchHook>>,
}

impl Files {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait<'a>(&self, g: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        self.answered.wait(g).unwrap_or_else(PoisonError::into_inner)
    }

    /// Where files and packs are asked for: once, before any build.
    pub fn set_host(&self, host: &'static dyn Host) {
        let _ = self.host.set(host);
    }

    /// Shelf's index (none: names go to the host), and the names the
    /// extension bundles. The engines' Shelf files made anew on it.
    pub fn set_index(&self, index: Option<Index>, bundled: HashSet<String>) {
        let mut s = self.lock();
        s.index = index.map(Arc::new);
        s.bundled = bundled;
        s.shelves.clear();
    }

    /// Each pack's fetch told to `hook` from now on (the document opened).
    pub fn on_fetch(&self, hook: Option<FetchHook>) {
        *self.hook.lock().unwrap_or_else(PoisonError::into_inner) = hook;
    }

    /// Shelf's files for `engine`, made at its first use; none without an index.
    fn shelf(self: &Arc<Self>, engine: &'static str) -> Option<Arc<shelf::Files>> {
        let mut s = self.lock();
        let ix = s.index.clone()?;
        Some(
            s.shelves
                .entry(engine)
                .or_insert_with(|| {
                    let f = shelf::Files::new(ix, Arc::new(HostPacks(self.clone())), engine);
                    let me = Arc::downgrade(self);
                    f.on_fetch(Box::new(move |e| {
                        let hook = me.upgrade().and_then(|m| m.hook.lock().unwrap_or_else(PoisonError::into_inner).clone());
                        if let Some(h) = hook {
                            h(e);
                        }
                    }));
                    Arc::new(f)
                })
                .clone(),
        )
    }

    /// Where `name` is for `engine` (the path the engine reports), waiting
    /// for the host if it must be asked; none: nowhere.
    pub fn locate(self: &Arc<Self>, name: &str, engine: &'static str) -> Option<String> {
        self.find(name, engine).map(|(p, _)| p)
    }

    /// The bytes at `path`, as [`Files::locate`] gave it (none: not given).
    pub fn read(&self, path: &str) -> Option<Arc<Vec<u8>>> {
        if path.starts_with(shelf::TL) {
            let shelves: Vec<_> = self.lock().shelves.values().cloned().collect();
            return shelves.iter().find_map(|f| f.read(path));
        }
        let s = self.lock();
        let plain = path.strip_prefix("./").unwrap_or(path);
        if let Some(b) = s.by_given_path.get(plain) {
            return Some(b.clone());
        }
        match s.by_name.get(plain) {
            Some(Entry::Given(Some((_, b)))) => Some(b.clone()),
            _ => None,
        }
    }

    /// Whether `name` is the host's (given, or bundled outside an engine's
    /// own tree), not Shelf's.
    fn hosts(s: &State, ix: &Index, name: &str, engine: &str) -> bool {
        if matches!(s.by_name.get(name), Some(Entry::Given(_))) {
            return true;
        }
        let path = ix.resolve(name, shelf::format_of(name), engine);
        // (an engine's own tree, xelatex's or lualatex's: Shelf's, over the bundled kernel's
        // file of that name, which is pdfLaTeX's)
        let engine_tree = path.is_some_and(|p| ["tex/xelatex/", "tex/xetex/", "tex/lualatex/", "tex/luatex/"].iter().any(|t| p.starts_with(t)));
        !name.contains('/') && s.bundled.contains(name) && !engine_tree
    }

    fn find(self: &Arc<Self>, name: &str, engine: &'static str) -> Option<Kept> {
        let s = self.lock();
        if let Some(Entry::Given(f)) = s.by_name.get(name) {
            return f.clone();
        }
        let Some(ix) = s.index.clone() else {
            return self.by_name(s, name);
        };
        if Self::hosts(&s, &ix, name, engine) {
            return self.by_name(s, name);
        }
        drop(s);
        let (path, bytes) = self.shelf(engine)?.find(name)?;
        Some((path, bytes))
    }

    /// `name`'s content key without fetching it (Shelf's: its pack and
    /// path), for a warm start's check; none: the host's.
    pub fn key(self: &Arc<Self>, name: &str, engine: &'static str) -> Option<(String, Vec<u8>)> {
        let s = self.lock();
        let ix = s.index.clone()?;
        if Self::hosts(&s, &ix, name, engine) {
            return None;
        }
        drop(s);
        self.shelf(engine)?.key(name)
    }

    fn by_name(&self, mut s: MutexGuard<'_, State>, name: &str) -> Option<Kept> {
        if !s.by_name.contains_key(name) {
            s.by_name.insert(name.to_owned(), Entry::Asked);
            if let Some(h) = self.host.get() {
                h.want(name);
            }
        }
        loop {
            if let Some(Entry::Given(f)) = s.by_name.get(name) {
                return f.clone();
            }
            s = self.wait(s);
        }
    }

    /// The host's answer for `name` (none: nowhere).
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

    /// The host's answer for pack `id`: its bytes as Shelf serves them, or
    /// none (it could not be had).
    pub fn pack(&self, id: &str, raw: Option<&[u8]>) {
        let mut s = self.lock();
        s.arrived.insert(id.to_owned(), raw.map(<[u8]>::to_vec).ok_or_else(|| format!("the pack {id} could not be had")));
        drop(s);
        self.answered.notify_all();
    }
}

/// Shelf's packs from the host: every pack asked at once (`phitex.fetch`),
/// then waited for (`ph_pack`), so a package and what it loads cost one
/// round trip.
struct HostPacks(Arc<Files>);

impl PackSource for HostPacks {
    fn pack(&self, id: &str) -> Result<Vec<u8>, String> {
        self.packs(&[id]).pop().unwrap_or_else(|| Err(format!("the pack {id} could not be had")))
    }

    fn packs(&self, ids: &[&str]) -> Vec<Result<Vec<u8>, String>> {
        let f = &self.0;
        let mut s = f.lock();
        for id in ids {
            if !s.asked.contains(*id) && !s.arrived.contains_key(*id) {
                s.asked.insert((*id).to_owned());
                if let Some(h) = f.host.get() {
                    h.fetch(id);
                }
            }
        }
        while !ids.iter().all(|id| s.arrived.contains_key(*id)) {
            s = f.wait(s);
        }
        ids.iter()
            .map(|id| {
                s.asked.remove(*id);
                s.arrived.remove(*id).unwrap_or_else(|| Err(format!("the pack {id} could not be had")))
            })
            .collect()
    }
}
