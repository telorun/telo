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
    read_entries(GzDecoder::new(bytes))
}

/// [`read_tar_gz`], refusing an archive that decompresses to more than
/// `max_bytes` — for an archive whose origin is not trusted to be small.
pub fn read_tar_gz_bounded(bytes: &[u8], max_bytes: u64) -> std::io::Result<Vec<PayloadFile>> {
    let mut tar = Vec::new();
    GzDecoder::new(bytes).take(max_bytes + 1).read_to_end(&mut tar)?;
    if tar.len() as u64 > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("it decompresses to more than the {max_bytes}-byte limit"),
        ));
    }
    read_entries(tar.as_slice())
}

fn read_entries(reader: impl Read) -> std::io::Result<Vec<PayloadFile>> {
    let mut archive = Archive::new(reader);
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
