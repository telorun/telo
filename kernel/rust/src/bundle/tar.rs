//! Reading a layer's gzipped tar. Mirrors `../../../nodejs/src/bundle/tar.ts`.
//!
//! Read side only: `makeTarGz` frames layers for `telo publish`, and this kernel
//! publishes nothing. Entries decode straight to [`PayloadFile`]s, the step the
//! Node transports run after `readTarGz` (`toPayloadFiles`).

use std::io::Read;

use flate2::read::GzDecoder;
use tar::{Archive, EntryType};

use crate::bundle::files_integrity::PayloadFile;

/// Decompress and untar `bytes` into their regular-file and symbolic-link
/// entries; any other entry type is skipped, as the Node reader skips it.
pub fn read_tar_gz(bytes: &[u8]) -> std::io::Result<Vec<PayloadFile>> {
    let mut archive = Archive::new(GzDecoder::new(bytes));
    let mut files = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind != EntryType::Regular && kind != EntryType::Symlink {
            continue;
        }
        let name = utf8(entry.path_bytes().into_owned(), "entry name")?;
        if kind == EntryType::Symlink {
            let link = match entry.link_name_bytes() {
                Some(link) => utf8(link.into_owned(), "link target")?,
                None => String::new(),
            };
            files.push(PayloadFile::Link { name, link });
            continue;
        }
        let executable = entry.header().mode()? & 0o111 != 0;
        let mut content = Vec::new();
        entry.read_to_end(&mut content)?;
        files.push(PayloadFile::Regular {
            name,
            content,
            executable,
        });
    }
    Ok(files)
}

/// A name that is not UTF-8 cannot match the index or a candidate's `path=`,
/// both of which are YAML text, so it is refused rather than mangled.
fn utf8(bytes: Vec<u8>, what: &str) -> std::io::Result<String> {
    String::from_utf8(bytes).map_err(|err| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("tar {what} is not UTF-8: {err}"),
        )
    })
}
