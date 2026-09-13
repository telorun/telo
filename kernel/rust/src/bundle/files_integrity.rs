//! A layer's file set and its content digest. Mirrors
//! `../../../nodejs/src/bundle/files-integrity.ts`.
//!
//! Read side only. `readPayloadFile` and `injectLayerIndex` serve publishing, and
//! the pinned entry a release digests a cold tree with never reaches a kernel, so
//! none of them has a counterpart here.

use telo_analyzer::sources::integrity::sha256_base64url;
use telo_analyzer::DEFAULT_MANIFEST_FILENAME;

/// One entry of a payload layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayloadFile {
    /// A regular file; `executable` when it ships with an execute bit set.
    Regular {
        /// POSIX-relative path inside the layer.
        name: String,
        content: Vec<u8>,
        executable: bool,
    },
    /// A symbolic link; `link` is the target exactly as the link stores it.
    Link { name: String, link: String },
}

impl PayloadFile {
    pub fn name(&self) -> &str {
        match self {
            PayloadFile::Regular { name, .. } | PayloadFile::Link { name, .. } => name,
        }
    }
}

/// The `integrity` of one layer (spec §3.3): SHA-256 over the sorted lines of
/// every entry, `telo.yaml` excluded, rendered `sha256-<base64url>`.
///
/// - regular file: `<path>\0<sha256(content)>`
/// - executable file: `<path>\0<sha256(content)>\0x`
/// - symbolic link: `<path>\0l\0<target>`
pub fn compute_files_integrity(files: &[PayloadFile]) -> String {
    let mut lines: Vec<String> = files
        .iter()
        .filter(|file| file.name() != DEFAULT_MANIFEST_FILENAME)
        .map(|file| match file {
            PayloadFile::Link { name, link } => format!("{name}\0l\0{link}"),
            PayloadFile::Regular {
                name,
                content,
                executable,
            } => {
                let digest = sha256_base64url(content);
                if *executable {
                    format!("{name}\0{digest}\0x")
                } else {
                    format!("{name}\0{digest}")
                }
            }
        })
        .collect();
    // By UTF-16 code unit, which is how the Node half's `Array.prototype.sort`
    // orders strings; byte order disagrees with it for a path outside the BMP.
    lines.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    format!("sha256-{}", sha256_base64url(lines.join("\n").as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The `filesIntegrity` cases of the shared vector file, which
    /// `kernel/nodejs/tests/files-integrity-vectors.test.ts` runs too.
    #[test]
    fn agrees_with_the_shared_integrity_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../analyzer/artifact-axes/layer-index-vectors.json"
        ))
        .expect("vector file is JSON");
        for case in vectors["filesIntegrity"].as_array().expect("filesIntegrity cases") {
            let files: Vec<PayloadFile> = case["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| {
                    let name = file["name"].as_str().unwrap().to_string();
                    match file.get("link") {
                        Some(link) => PayloadFile::Link {
                            name,
                            link: link.as_str().unwrap().to_string(),
                        },
                        None => PayloadFile::Regular {
                            name,
                            content: file["content"].as_str().unwrap().as_bytes().to_vec(),
                            executable: file.get("executable") == Some(&Value::Bool(true)),
                        },
                    }
                })
                .collect();
            assert_eq!(
                compute_files_integrity(&files),
                case["integrity"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
