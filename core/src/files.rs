//! The files the build reads, as the host gives them: by name, in the
//! module's shared memory, so every engine thread sees each one the host
//! has given without a copy or a call.
//!
//! A name not given yet is asked for once (`phitex.want`, posted to the
//! host's thread 0, which never blocks: it resolves the name by Shelf's
//! index, fetches the pack if it must, and answers with `ph_provide`),
//! and the thread that asked waits for the answer on a condition
//! variable. Other threads asking for the same name wait for the same
//! answer. An absent file is an answer too, kept like a present one: TeX
//! probes many names that are nowhere, and each is asked once.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, PoisonError};

/// A file: its path as the build reports it, and its bytes.
pub type File = Arc<(String, Vec<u8>)>;

enum Entry {
    /// Asked for; the host has not answered yet.
    Asked,
    /// The host's answer (none: the file is nowhere).
    Given(Option<File>),
}

#[derive(Default)]
pub struct Files {
    by_name: Mutex<HashMap<String, Entry>>,
    answered: Condvar,
}

impl Files {
    /// The file `name`, asking the host (`want`) and waiting for it when it
    /// has not given it.
    pub fn get(&self, name: &str, want: impl FnOnce(&str)) -> Option<File> {
        let mut m = self.by_name.lock().unwrap_or_else(PoisonError::into_inner);
        if !m.contains_key(name) {
            m.insert(name.to_owned(), Entry::Asked);
            want(name);
        }
        loop {
            if let Some(Entry::Given(f)) = m.get(name) {
                return f.clone();
            }
            m = self.answered.wait(m).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The host's answer for `name` (none: it is nowhere), given before it
    /// was asked for (the project's own files) or after.
    pub fn provide(&self, name: &str, file: Option<(String, Vec<u8>)>) {
        let mut m = self.by_name.lock().unwrap_or_else(PoisonError::into_inner);
        m.insert(name.to_owned(), Entry::Given(file.map(Arc::new)));
        self.answered.notify_all();
    }
}
