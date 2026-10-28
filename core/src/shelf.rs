//! Shelf's index (schema 3) and the rule a name resolves to a file by, as
//! kpathsea does it per engine; and Shelf's packs. The same rule as
//! common/src/resolve.ts and Shelf's build.py state (until this module is
//! the one place it lives: PhiTeX's phitex-shelf, which native `phitex`
//! will use as an opt-in).
//!
//! The index has every file by its texmf path
//! (`tex/latex/fontspec/fontspec.sty`), a row `path TAB pack TAB deps...`:
//! its pack, then for each engine `release.json`'s `deps` names, the packs
//! its loading reads (comma-separated; hints only: a missing one costs a
//! round trip, never a wrong file). `release.json`'s `search` gives, per
//! engine and kpathsea format, the ordered path prefixes (TeX Live's
//! texmf.cnf). The rule:
//!
//! - a name with a `/` is a path: TeX Live's absolute prefix dropped, the
//!   rest looked up as is;
//! - else its basename's paths: the first prefix of the engine's list for
//!   the format that holds any wins (at any depth under it), and within
//!   one prefix the lexicographically smallest path; none under any
//!   prefix: not found (kpathsea would not find it either);
//! - a format the release has no list for (or an engine it does not
//!   name): the smallest path of all with that basename.

use std::collections::HashMap;

use serde_json::Value;

/// TeX Live's tree, as a native build names the files it reads.
pub const TL: &str = "/usr/share/texmf-dist/";

struct Row {
    pack: Box<str>,
    /// Per engine of `Index::engines`, the packs its loading reads.
    deps: Box<[Box<str>]>,
}

pub struct Index {
    rows: HashMap<Box<str>, Row>,
    /// Basename to its paths, sorted.
    by_base: HashMap<Box<str>, Vec<Box<str>>>,
    /// Engine to kpathsea format to path prefixes, in search order.
    search: HashMap<String, HashMap<String, Vec<String>>>,
    engines: Vec<String>,
}

/// Shelf's engine name for a frontend's (`pdflatex`, `xelatex`, ...).
#[must_use]
pub fn engine(e: &str) -> &'static str {
    match e {
        "xelatex" | "xetex" => "xetex",
        "lualatex" | "luatex" => "luatex",
        _ => "pdftex",
    }
}

/// The kpathsea format of a file by its name's extension (the engine asks
/// by name only).
#[must_use]
pub fn format_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase();
    match ext.as_str() {
        "tfm" => "tfm",
        "vf" => "vf",
        "pfb" | "pfa" => "type1",
        "enc" => "enc",
        "map" => "map",
        "otf" => "opentype",
        "ttf" | "ttc" => "truetype",
        "bst" | "csf" => "bst",
        "bib" => "bib",
        "ist" => "ist",
        "tec" => "misc",
        _ => "tex",
    }
}

impl Index {
    /// The index from its TSV and the release's `release.json`.
    #[must_use]
    pub fn new(tsv: &str, release: &Value) -> Index {
        let mut rows = HashMap::new();
        let mut by_base: HashMap<Box<str>, Vec<Box<str>>> = HashMap::new();
        for line in tsv.lines() {
            let mut cols = line.split('\t');
            let (Some(path), Some(pack)) = (cols.next(), cols.next()) else {
                continue;
            };
            // (a row has a path and a pack)
            if path.is_empty() || pack.is_empty() {
                continue;
            }
            let base = path.rsplit_once('/').map_or(path, |(_, b)| b);
            by_base.entry(base.into()).or_default().push(path.into());
            rows.insert(
                path.into(),
                Row {
                    pack: pack.into(),
                    deps: cols.map(Into::into).collect(),
                },
            );
        }
        for paths in by_base.values_mut() {
            paths.sort_unstable();
        }
        let search = serde_json::from_value(release["search"].clone()).unwrap_or_default();
        let engines = serde_json::from_value(release["deps"].clone()).unwrap_or_default();
        Index {
            rows,
            by_base,
            search,
            engines,
        }
    }

    /// `name`'s texmf path for `engine` (Shelf's name) and kpathsea format
    /// `format`, or none.
    #[must_use]
    pub fn resolve(&self, name: &str, format: &str, engine: &str) -> Option<&str> {
        if name.contains('/') {
            let p = name.strip_prefix(TL).unwrap_or_else(|| name.strip_prefix("./").unwrap_or(name));
            return self.rows.get_key_value(p).map(|(k, _)| &**k);
        }
        let paths = self.by_base.get(name)?;
        let Some(prefixes) = self.search.get(engine).and_then(|f| f.get(format)) else {
            return paths.first().map(|p| &**p);
        };
        prefixes.iter().find_map(|pre| {
            let pre = pre.trim_end_matches('/');
            paths
                .iter()
                .find(|p| p.strip_prefix(pre).is_some_and(|r| r.starts_with('/')))
                .map(|p| &**p)
        })
    }

    /// The packs to fetch for `path` with `engine`: its own, then what its
    /// loading reads.
    #[must_use]
    pub fn packs(&self, path: &str, engine: &str) -> Vec<&str> {
        let Some(row) = self.rows.get(path) else {
            return Vec::new();
        };
        let deps = self
            .engines
            .iter()
            .position(|e| e == engine)
            .and_then(|k| row.deps.get(k))
            .map_or("", |d| &**d);
        std::iter::once(&*row.pack)
            .chain(deps.split(',').filter(|d| !d.is_empty()))
            .collect()
    }
}

/// A pack's files: gzip of `u32 n, (u32 len, path, u32 len, bytes) x n`,
/// little-endian; none if it is not one.
#[must_use]
pub fn unpack(gz: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
    let b = gunzip(gz)?;
    let u32_at = |at: usize| -> Option<usize> {
        let w: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
        usize::try_from(u32::from_le_bytes(w)).ok()
    };
    let n = u32_at(0)?;
    let mut at = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let k = u32_at(at)?;
        let name = String::from_utf8(b.get(at + 4..at + 4 + k)?.to_vec()).ok()?;
        at += 4 + k;
        let l = u32_at(at)?;
        out.push((name, b.get(at + 4..at + 4 + l)?.to_vec()));
        at += 4 + l;
    }
    Some(out)
}

/// A gzip member's data (RFC 1952), inflated by PhiTeX's own inflate.
fn gunzip(gz: &[u8]) -> Option<Vec<u8>> {
    const FHCRC: u8 = 2;
    const FEXTRA: u8 = 4;
    const FNAME: u8 = 8;
    const FCOMMENT: u8 = 16;
    if gz.get(..3)? != [0x1f, 0x8b, 8] {
        return None;
    }
    let flags = gz[3];
    let mut at = 10;
    if flags & FEXTRA != 0 {
        let n = usize::from(u16::from_le_bytes(gz.get(at..at + 2)?.try_into().ok()?));
        at += 2 + n;
    }
    for f in [FNAME, FCOMMENT] {
        if flags & f != 0 {
            at += gz.get(at..)?.iter().position(|&c| c == 0)? + 1;
        }
    }
    if flags & FHCRC != 0 {
        at += 2;
    }
    let mut out = Vec::new();
    phitex_codecs::inflate::inflate_raw(gz.get(at..)?, &mut out).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        let tsv = "tex/latex/base/article.cls\tbase-1\t\t\n\
                   tex/xelatex/xunicode/xunicode.sty\txu-1\t\t\n\
                   tex/latex/xunicode/xunicode.sty\txu-2\t\t\n\
                   tex/latex/amsmath/amsmath.sty\tamsmath-1\tamsfonts-1,base-1\t\n\
                   fonts/tfm/public/cm/cmr10.tfm\tcm-1\t\t\n";
        let release = serde_json::json!({
            "deps": ["pdftex", "xetex"],
            "search": {
                "pdftex": {"tex": ["tex/latex", "tex/generic", "tex"], "tfm": ["fonts/tfm"]},
                "xetex": {"tex": ["tex/xelatex", "tex/latex", "tex"]}
            }
        });
        Index::new(tsv, &release)
    }

    #[test]
    fn resolves_by_the_engines_search_order() {
        let ix = index();
        assert_eq!(ix.resolve("xunicode.sty", "tex", "xetex"), Some("tex/xelatex/xunicode/xunicode.sty"));
        assert_eq!(ix.resolve("xunicode.sty", "tex", "pdftex"), Some("tex/latex/xunicode/xunicode.sty"));
        assert_eq!(ix.resolve("cmr10.tfm", "tfm", "pdftex"), Some("fonts/tfm/public/cm/cmr10.tfm"));
        // (no list for the format: the smallest path)
        assert_eq!(ix.resolve("cmr10.tfm", "tfm", "xetex"), Some("fonts/tfm/public/cm/cmr10.tfm"));
        // (a path, TeX Live's prefix dropped)
        assert_eq!(ix.resolve("/usr/share/texmf-dist/tex/latex/base/article.cls", "tex", "pdftex"), Some("tex/latex/base/article.cls"));
        assert_eq!(ix.resolve("nowhere.sty", "tex", "pdftex"), None);
        // (a tfm under a tex prefix is not found by kpathsea's tfm search)
        assert_eq!(ix.resolve("article.cls", "tfm", "pdftex"), None);
    }

    #[test]
    fn packs_are_its_own_then_its_deps() {
        let ix = index();
        assert_eq!(ix.packs("tex/latex/amsmath/amsmath.sty", "pdftex"), ["amsmath-1", "amsfonts-1", "base-1"]);
        assert_eq!(ix.packs("tex/latex/amsmath/amsmath.sty", "xetex"), ["amsmath-1"]);
        assert!(ix.packs("tex/nothing.sty", "pdftex").is_empty());
    }

    #[test]
    fn format_by_extension() {
        assert_eq!(format_of("cmr10.TFM"), "tfm");
        assert_eq!(format_of("article.cls"), "tex");
        assert_eq!(format_of("plain.bst"), "bst");
    }
}
