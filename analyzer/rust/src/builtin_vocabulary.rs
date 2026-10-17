//! The `Telo.Builtins` document — the built-in vocabulary of one telo release,
//! read and never declared, run or imported. Mirrors the part of
//! `../../nodejs/src/builtin-vocabulary.ts` a kernel refuses with — the kind, and
//! the two sentences that say what such a document is — and the release an
//! archive is the vocabulary of, which a CLI prints as its identity.

use serde::Deserialize;

/// The kind of the archive's root document.
pub const BUILTIN_VOCABULARY_KIND: &str = "Telo.Builtins";

/// What a `Telo.Builtins` document is, said wherever one is refused as a module.
pub const BUILTIN_VOCABULARY_NOT_A_MODULE: &str = "Telo.Builtins is the published built-in vocabulary of a telo release; it is read, never declared, run or imported.";

/// The refusal of an import whose target is the built-in vocabulary. `version`
/// is the archive's own `metadata.version`.
pub fn builtin_vocabulary_import_message(source: &str, version: Option<&str>) -> String {
    let release = match version {
        Some(version) if !version.is_empty() => format!("telo {version}"),
        _ => "a telo release".to_string(),
    };
    format!(
        "'{source}' is the built-in vocabulary of {release}; its kinds need no import — remove this `imports:` entry and write them as `Telo.<Kind>`."
    )
}

/// The release `archive` is the vocabulary of — its root's `metadata.version`,
/// `X` or `X+unreleased`. The `version` of the Node reader's
/// `readBuiltinVocabulary`, refused in its words.
pub fn builtin_vocabulary_version(archive: &str) -> Result<String, String> {
    let root = match serde_yaml::Deserializer::from_str(archive).next() {
        Some(document) => serde_yaml::Value::deserialize(document)
            .map_err(|err| format!("document 1 does not parse: {err}"))?,
        None => serde_yaml::Value::Null,
    };
    if root.get("kind").and_then(serde_yaml::Value::as_str) != Some(BUILTIN_VOCABULARY_KIND) {
        return Err(format!(
            "the first document is not `kind: {BUILTIN_VOCABULARY_KIND}`."
        ));
    }
    match root
        .get("metadata")
        .and_then(|metadata| metadata.get("version"))
        .and_then(serde_yaml::Value::as_str)
    {
        Some(version) if !version.is_empty() => Ok(version.to_string()),
        _ => Err(
            "the root declares no `metadata.version`: an archive is the vocabulary of one release."
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn generated(relative: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|err| {
            panic!(
                "{} is not generated ({err}): run `node scripts/generate-telo-version.mjs && \
                 node scripts/render-builtin-vocabulary.mjs` (or `pnpm install`) first.",
                path.display()
            )
        })
    }

    #[test]
    fn reads_the_rendered_archive_as_the_identity_the_node_kernel_reports() {
        let archive = generated("../nodejs/src/builtin-vocabulary/builtins.yaml");
        // `TELO_RUNTIME_VERSION`, what `Kernel.Starting` carries, written by the
        // same generator beside the archive.
        let identity = generated("../../kernel/nodejs/src/telo-runtime-version.ts");
        let expected = identity
            .lines()
            .find_map(|line| line.strip_prefix("export const TELO_RUNTIME_VERSION = \""))
            .and_then(|rest| rest.strip_suffix("\";"))
            .expect("the generated identity constant");
        assert_eq!(builtin_vocabulary_version(&archive), Ok(expected.to_string()));
    }

    #[test]
    fn refuses_a_root_that_is_not_the_vocabulary() {
        assert_eq!(
            builtin_vocabulary_version("kind: Telo.Library\nmetadata:\n  name: Telo\n  version: 1.0.0\n"),
            Err("the first document is not `kind: Telo.Builtins`.".to_string())
        );
    }

    #[test]
    fn refuses_a_root_declaring_no_version() {
        assert_eq!(
            builtin_vocabulary_version("kind: Telo.Builtins\nmetadata:\n  name: Telo\n"),
            Err(
                "the root declares no `metadata.version`: an archive is the vocabulary of one release."
                    .to_string()
            )
        );
    }
}
