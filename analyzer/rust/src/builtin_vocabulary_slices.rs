//! Selecting entries out of the built-in vocabulary archive by name — what
//! `telo builtins <name>…` prints, in both CLIs.
//! Mirrors `../../nodejs/src/builtin-vocabulary-slices.ts`.
//!
//! It slices the archive's bytes and never re-serializes, which rests on the
//! renderer's fixed layout (`kernel/specs/builtin-vocabulary.md` § Layout):
//! documents joined by a `---` line, the root first; a section of the root at
//! column 0, each of its entries at column 2 with every line of its body indented
//! further; every later document starting `kind:`, then `metadata:` with `name:`
//! first. Both halves are held to the expectation the renderer records as it
//! emits the archive, so they print the same bytes for every name.

use std::collections::HashMap;

/// What an entry is, by the section of the archive holding it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryClass {
    Kind,
    Fragment,
    ValueType,
    ZoneAttribute,
    Format,
}

impl EntryClass {
    pub fn label(self) -> &'static str {
        match self {
            EntryClass::Kind => "kind",
            EntryClass::Fragment => "fragment",
            EntryClass::ValueType => "value type",
            EntryClass::ZoneAttribute => "zone attribute",
            EntryClass::Format => "format",
        }
    }

    fn of_section(section: &str) -> Option<Self> {
        match section {
            "$defs" => Some(EntryClass::Fragment),
            "valueTypes" => Some(EntryClass::ValueType),
            "zoneAttributes" => Some(EntryClass::ZoneAttribute),
            "formats" => Some(EntryClass::Format),
            _ => None,
        }
    }
}

/// The order classes are listed in when a name is unknown.
const CLASS_ORDER: [EntryClass; 5] = [
    EntryClass::Kind,
    EntryClass::Fragment,
    EntryClass::ValueType,
    EntryClass::ZoneAttribute,
    EntryClass::Format,
];

/// One selectable entry: the names selecting it and the text printed for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltinVocabularyEntry {
    pub class: EntryClass,
    /// A kind by its name with and without `Telo.`, anything else by its name.
    pub names: Vec<String>,
    /// A kind's whole document, or the section line and the entry's block.
    pub text: String,
}

const DOCUMENT_SEPARATOR: &str = "---";

fn malformed(detail: impl AsRef<str>) -> String {
    format!(
        "The built-in vocabulary archive is malformed: {}",
        detail.as_ref()
    )
}

/// A key or scalar as the renderer writes it: plain, or a JSON string.
fn decode_scalar(text: &str) -> Result<String, String> {
    if !text.starts_with('"') {
        return Ok(text.to_string());
    }
    serde_json::from_str::<String>(text)
        .map_err(|_| malformed(format!("'{text}' is neither a plain scalar nor a JSON string.")))
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// `<head>:` with nothing after the colon, the head returned.
fn block_head(line: &str) -> Option<&str> {
    line.strip_suffix(':').filter(|head| !head.is_empty())
}

fn joined(lines: &[&str]) -> String {
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// Every selectable entry of `archive`, in archive order. Fails when the bytes
/// are not in the renderer's layout.
pub fn builtin_vocabulary_entries(archive: &str) -> Result<Vec<BuiltinVocabularyEntry>, String> {
    let body = archive
        .strip_suffix('\n')
        .ok_or_else(|| malformed("it does not end with a newline."))?;
    let mut documents: Vec<Vec<&str>> = vec![Vec::new()];
    for line in body.split('\n') {
        if line == DOCUMENT_SEPARATOR {
            documents.push(Vec::new());
        } else {
            documents.last_mut().expect("never empty").push(line);
        }
    }

    let mut entries = Vec::new();
    let (root, kinds) = documents.split_first().expect("never empty");
    let mut section: Option<String> = None;
    let mut section_line = "";
    let mut i = 0;
    while i < root.len() {
        let line = root[i];
        if indent_of(line) == 0 {
            section = match block_head(line) {
                Some(head) => Some(decode_scalar(head)?),
                None => None,
            };
            section_line = line;
            i += 1;
            continue;
        }
        let class = section.as_deref().and_then(EntryClass::of_section);
        let Some(class) = class.filter(|_| indent_of(line) == 2) else {
            i += 1;
            continue;
        };
        let head = block_head(&line[2..])
            .filter(|head| !head.starts_with(' '))
            .ok_or_else(|| {
                malformed(format!(
                    "the {} entry line '{line}' does not open a block.",
                    section.as_deref().unwrap_or_default()
                ))
            })?;
        let mut end = i + 1;
        while end < root.len() && indent_of(root[end]) > 2 {
            end += 1;
        }
        if end == i + 1 {
            return Err(malformed(format!(
                "the {} entry '{head}' has an empty block.",
                section.as_deref().unwrap_or_default()
            )));
        }
        let mut lines = vec![section_line];
        lines.extend_from_slice(&root[i..end]);
        entries.push(BuiltinVocabularyEntry {
            class,
            names: vec![decode_scalar(head)?],
            text: joined(&lines),
        });
        i = end;
    }

    for lines in kinds {
        if !lines.first().is_some_and(|line| line.starts_with("kind: ")) {
            return Err(malformed("a document does not start with `kind:`."));
        }
        let name = lines
            .iter()
            .position(|line| *line == "metadata:")
            .and_then(|at| lines.get(at + 1))
            .and_then(|line| line.strip_prefix("  name: "))
            .ok_or_else(|| malformed("a document's `metadata:` does not start with `name:`."))?;
        let name = decode_scalar(name)?;
        entries.push(BuiltinVocabularyEntry {
            class: EntryClass::Kind,
            names: vec![name.clone(), format!("Telo.{name}")],
            text: joined(lines),
        });
    }
    Ok(entries)
}

/// The names there are, by class — what an unknown name is answered with.
pub fn describe_builtin_names(entries: &[BuiltinVocabularyEntry]) -> String {
    let mut lines = Vec::new();
    for class in CLASS_ORDER {
        let names: Vec<&str> = entries
            .iter()
            .filter(|entry| entry.class == class)
            .map(|entry| entry.names[0].as_str())
            .collect();
        if names.is_empty() {
            continue;
        }
        let label = match class {
            EntryClass::Kind => "kinds (with or without 'Telo.')".to_string(),
            other => format!("{}s", other.label()),
        };
        lines.push(format!("  {label}: {}", names.join(", ")));
    }
    lines.join("\n")
}

/// Why a selection printed nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum SelectionError {
    /// Names selecting nothing, and the message listing the names there are.
    Unknown { unknown: Vec<String>, message: String },
    /// The archive is not in the renderer's layout.
    Malformed(String),
}

/// The text `telo builtins <names…>` prints: each name's entry, in argument
/// order, joined by `---` lines.
pub fn select_builtins(archive: &str, names: &[String]) -> Result<String, SelectionError> {
    let entries = builtin_vocabulary_entries(archive).map_err(SelectionError::Malformed)?;
    let mut by_name: HashMap<&str, &BuiltinVocabularyEntry> = HashMap::new();
    for entry in &entries {
        for name in &entry.names {
            by_name.insert(name, entry);
        }
    }
    let unknown: Vec<String> = names
        .iter()
        .filter(|name| !by_name.contains_key(name.as_str()))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        let quoted: Vec<String> = unknown.iter().map(|name| format!("'{name}'")).collect();
        let message = format!(
            "No built-in is named {}. The names are:\n{}",
            quoted.join(", "),
            describe_builtin_names(&entries)
        );
        return Err(SelectionError::Unknown { unknown, message });
    }
    Ok(names
        .iter()
        .map(|name| by_name[name.as_str()].text.as_str())
        .collect::<Vec<_>>()
        .join(&format!("{DOCUMENT_SEPARATOR}\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The renderer's output, read where `scripts/render-builtin-vocabulary.mjs`
    /// writes it — rendered before cargo runs, like the archive the CLI embeds.
    fn rendered(file: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../nodejs").join(file);
        std::fs::read_to_string(&path).unwrap_or_else(|err| {
            panic!(
                "{} is not rendered ({err}): run `node scripts/generate-telo-version.mjs && \
                 node scripts/render-builtin-vocabulary.mjs` (or `pnpm install`) first.",
                path.display()
            )
        })
    }

    fn expected() -> Vec<(Vec<String>, String, String)> {
        let recorded: serde_json::Value =
            serde_json::from_str(&rendered("builtin-vocabulary-slices.json")).expect("JSON");
        recorded["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| {
                (
                    entry["names"]
                        .as_array()
                        .expect("names")
                        .iter()
                        .map(|name| name.as_str().expect("name").to_string())
                        .collect(),
                    entry["class"].as_str().expect("class").to_string(),
                    entry["text"].as_str().expect("text").to_string(),
                )
            })
            .collect()
    }

    /// The conformance half the Node test mirrors: for every name the renderer
    /// recorded, the exact bytes it emitted for that entry.
    #[test]
    fn prints_for_every_name_the_text_the_renderer_emitted() {
        let archive = rendered("src/builtin-vocabulary/builtins.yaml");
        let entries = builtin_vocabulary_entries(&archive).expect("the archive slices");
        let expected = expected();
        assert_eq!(entries.len(), expected.len());
        for (entry, (names, class, text)) in entries.iter().zip(&expected) {
            assert_eq!(&entry.names, names);
            assert_eq!(entry.class.label(), class);
            for name in names {
                assert_eq!(
                    select_builtins(&archive, std::slice::from_ref(name)).as_ref(),
                    Ok(text),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn joins_several_entries_with_a_separator_in_argument_order() {
        let archive = rendered("src/builtin-vocabulary/builtins.yaml");
        let expected = expected();
        let text = |name: &str| {
            expected
                .iter()
                .find(|(names, _, _)| names.iter().any(|n| n == name))
                .map(|(_, _, text)| text.clone())
                .expect("recorded")
        };
        assert_eq!(
            select_builtins(&archive, &["Step".into(), "Telo.Application".into()]),
            Ok(format!("{}---\n{}", text("Step"), text("Application")))
        );
    }

    #[test]
    fn answers_an_unknown_name_with_every_unknown_one_and_the_names_there_are() {
        let archive = rendered("src/builtin-vocabulary/builtins.yaml");
        let Err(SelectionError::Unknown { unknown, message }) = select_builtins(
            &archive,
            &["Application".into(), "Aplication".into(), "Stp".into()],
        ) else {
            panic!("an unknown name selects nothing");
        };
        assert_eq!(unknown, vec!["Aplication".to_string(), "Stp".to_string()]);
        let lines: Vec<&str> = message.lines().collect();
        assert_eq!(lines[0], "No built-in is named 'Aplication', 'Stp'. The names are:");
        assert!(lines[1].starts_with("  kinds (with or without 'Telo.'): Abstract, Application,"));
        assert_eq!(lines[5], "  formats: css-selector, language-tag, message-pattern, re2-pattern");
    }
}
