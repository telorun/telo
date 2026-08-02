//! Pure: text in, structured load result out. No I/O, no caches.
//! Mirrors `../../nodejs/src/parse-loaded-file.ts`.

use serde::Deserialize;
use serde_yaml::Value as Yaml;
use telo_templating::yaml_to_json;

use crate::loaded_types::{LoadedFile, ParseError};
use crate::types::ResourceManifest;

pub fn parse_loaded_file(source: &str, requested_url: &str, text: &str) -> LoadedFile {
    let mut manifests: Vec<Option<ResourceManifest>> = Vec::new();
    let mut parse_errors: Vec<ParseError> = Vec::new();

    for (document_index, document) in serde_yaml::Deserializer::from_str(text).enumerate() {
        match Yaml::deserialize(document) {
            Ok(Yaml::Null) => manifests.push(None),
            Ok(value) => match yaml_to_json(value) {
                Ok(json) => manifests.push(Some(json)),
                Err(err) => {
                    manifests.push(None);
                    parse_errors.push(ParseError {
                        document_index,
                        message: err.message,
                    });
                }
            },
            Err(err) => {
                manifests.push(None);
                parse_errors.push(ParseError {
                    document_index,
                    message: err.to_string(),
                });
            }
        }
    }

    LoadedFile {
        source: source.to_string(),
        requested_url: requested_url.to_string(),
        text: text.to_string(),
        manifests,
        parse_errors,
    }
}
