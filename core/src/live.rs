//! The machine phitex-live's session runs on here ([`phitex_live::host`]):
//! the files Shelf's and the host's ([`Shelf`], over [`crate::files`]), the
//! outputs kept in memory for the host to read ([`Memory`]); the store is
//! [`crate::store`]. Nothing is read from or written to a disk: there is
//! none.
//!
//! What a native host gives and this one does not (the defaults): XeTeX's
//! fonts (`Host::xetex`: a `FontSource` over Shelf's `fonts/opentype`,
//! `fonts/truetype` and a font index made from them, not built yet),
//! xdvipdfmx and dvipdfmx (an XeTeX job's XDV and a DVI made a PDF: none
//! in this module), a failure's report file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use phitex_live::host::{Host, Sink};
use phitex_live::session::Job;

use crate::files::{self, Files};

/// The files the build reads: Shelf's packs and the host's files
/// ([`Files`]), resolved for `engine` (Shelf's engine name); `\write18`'s
/// allowed commands posted to the host where it has a runner.
pub struct Shelf {
    pub files: Arc<Files>,
    pub engine: &'static str,
    /// What the files ask the host for.
    pub asks: &'static dyn files::Host,
    pub shell: Option<Arc<dyn phitex_tex::ShellHook>>,
}

impl Host for Shelf {
    fn locate(&self, name: &str) -> Option<PathBuf> {
        self.files.locate(name, self.engine, self.asks).map(PathBuf::from)
    }

    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        self.files.read(&path.to_string_lossy()).map(|b| b.to_vec())
    }

    /// Shelf's files keyed by their pack and path, none read: a warm start
    /// checks the format against them without fetching them
    /// ([`Files::key`]).
    fn content_key(&self) -> Option<phitex_tex::ContentKey> {
        let (f, e) = (self.files.clone(), self.engine);
        Some(Arc::new(move |name: &str| f.key(name, e)))
    }

    /// BibTeX's and makeindex's files, as kpathsea finds them in their
    /// formats (the format's suffix added where the name has none): the
    /// project's, else Shelf's.
    fn tool_finder(&self) -> Option<phitex_tex::ToolFinder> {
        let (f, e, asks) = (self.files.clone(), self.engine, self.asks);
        Some(Arc::new(move |search: phitex_tex::ToolSearch, name: &str| {
            let ext = match search {
                phitex_tex::ToolSearch::BibStyle => ".bst",
                phitex_tex::ToolSearch::BibData => ".bib",
                phitex_tex::ToolSearch::IndexStyle => ".ist",
            };
            let name = if name.ends_with(ext) { name.to_owned() } else { format!("{name}{ext}") };
            let p = f.locate(&name, e, asks)?;
            let b = f.read(&p)?;
            Some((p, b.to_vec()))
        }))
    }

    fn shell_hook(&self, _job: &Job) -> Option<Arc<dyn phitex_tex::ShellHook>> {
        self.shell.clone()
    }
}

/// The outputs, by name, in memory: the main output shared with the
/// engine's bytes (not copied), the rest as written. Read by the host
/// (`ph_file`) from its thread 0.
#[derive(Default)]
pub struct Memory(Mutex<HashMap<String, Arc<Vec<u8>>>>);

impl Memory {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<Vec<u8>>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// File `name` as last written (none: not written).
    pub fn file(&self, name: &str) -> Option<Arc<Vec<u8>>> {
        self.lock().get(name.strip_prefix("./").unwrap_or(name)).cloned()
    }
}

impl Sink for Memory {
    fn begin(&self) -> Result<(), String> {
        Ok(())
    }

    fn put(&self, name: &str, bytes: &[u8], _hash: u64) -> Result<PathBuf, String> {
        self.lock().insert(name.to_owned(), Arc::new(bytes.to_vec()));
        Ok(PathBuf::from(name))
    }

    fn put_main(&self, name: &str, bytes: &Arc<Vec<u8>>, _hash: u64) -> Result<PathBuf, String> {
        self.lock().insert(name.to_owned(), bytes.clone());
        Ok(PathBuf::from(name))
    }

    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.put(name, bytes, 0).map(|_| ())
    }

    fn remove(&self, name: &str) {
        self.lock().remove(name);
    }

    fn get(&self, name: &str) -> Option<Vec<u8>> {
        self.file(name).map(|b| b.to_vec())
    }

    fn path(&self, name: &str) -> PathBuf {
        PathBuf::from(name)
    }
}
