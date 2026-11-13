//! The shape of the `release:` block of `telo-workspace.yaml`, declared as
//! data: walked by the lenient reader, offered by an editor's completion.
//! Each registered adapter declares the keys its own ecosystem reads in an
//! anchor's settings and under `release.ecosystems` (`keys`).

use std::sync::LazyLock;

use crate::adapter::EcosystemAdapter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyType {
    String,
    Boolean,
    StringList,
    EntryList,
    Directory,
    Ecosystems,
    Ecosystem,
    VersionLocation,
    Payload,
    VersionFiles,
    BumpLevel,
    Groups,
}

impl KeyType {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyType::String => "string",
            KeyType::Boolean => "boolean",
            KeyType::StringList => "string[]",
            KeyType::EntryList => "entry[]",
            KeyType::Directory => "directory",
            KeyType::Ecosystems => "ecosystems",
            KeyType::Ecosystem => "ecosystem",
            KeyType::VersionLocation => "version-location",
            KeyType::Payload => "payload",
            KeyType::VersionFiles => "version-files",
            KeyType::BumpLevel => "bump-level",
            KeyType::Groups => "groups",
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceKeySchema {
    pub ty: KeyType,
    pub description: &'static str,
    pub examples: &'static [&'static str],
    /// For `entry[]`: what one entry is.
    pub entry: Option<WorkspaceEntrySchema>,
}

/// One entry of an `entry[]` list: a bare string stands for `key` alone.
#[derive(Debug, Clone)]
pub struct WorkspaceEntrySchema {
    pub key: &'static str,
    pub properties: Vec<(&'static str, WorkspaceKeySchema)>,
}

pub type KeySchemas = Vec<(&'static str, WorkspaceKeySchema)>;

pub fn has_key(keys: &[(&'static str, WorkspaceKeySchema)], name: &str) -> bool {
    keys.iter().any(|(key, _)| *key == name)
}

pub fn key_names(keys: &[(&'static str, WorkspaceKeySchema)]) -> Vec<&'static str> {
    keys.iter().map(|(key, _)| *key).collect()
}

pub struct WorkspaceBlockSchema {
    pub description: &'static str,
    pub properties: &'static KeySchemas,
    /// Per ecosystem the host serves, the keys it reads.
    pub ecosystems: Vec<(String, KeySchemas)>,
}

const fn key(ty: KeyType, description: &'static str, examples: &'static [&'static str]) -> WorkspaceKeySchema {
    WorkspaceKeySchema { ty, description, examples, entry: None }
}

fn ignore() -> WorkspaceKeySchema {
    key(
        KeyType::StringList,
        "Paths under a unit whose changes ask for no changelog fragment. Unit-relative, gitignore-style. Declaring it replaces the built-in default; [] ignores nothing.",
        &["**/tests/**", "**/docs/**", "**/plans/**", "**/README.md", "**/CHANGELOG.md"],
    )
}

fn max_bump() -> WorkspaceKeySchema {
    key(
        KeyType::BumpLevel,
        "The highest bump a release may make — patch, minor or major (the default). A plan needing more is refused.",
        &["patch", "minor", "major"],
    )
}

/// Keys every `release.units` entry may carry, whatever its ecosystems.
pub static UNIT_ENTRY_KEYS: LazyLock<KeySchemas> = LazyLock::new(|| {
    vec![
        ("path", key(KeyType::String, "The unit's directory, or a gitignore-style pattern of them, workspace-relative. Last match wins; a leading ! excludes. A unit's key is its path.", &[])),
        ("ecosystem", key(KeyType::Ecosystem, "The ecosystems the unit ships through: a name, a list of names, or a map of name to the anchor directory inside the unit holding that ecosystem's package — a directory, a list of them, or a map of directory to that anchor's settings. A name alone anchors at the unit's own directory. Absent: the unit declares its own version and payload.", &["npm", "cargo", "docker", "helm"])),
        ("version", key(KeyType::VersionLocation, "Where the unit's version lives: a unit-relative file a handler reads (package.json, Cargo.toml, a plain version file), or { file, pointer } into JSON, YAML or TOML. Required unless exactly one anchor's ecosystem keeps a version.", &[])),
        ("payload", key(KeyType::Payload, "A declared file set beside the ecosystems' own: unit-relative patterns, or { command } printing unit-relative paths. Required when no anchor contributes a layer.", &[])),
        ("metafile", key(KeyType::String, "A bundler metafile, unit-relative, whose inputs from other units are inline edges.", &[])),
        ("versionFiles", key(KeyType::VersionFiles, "Further files carrying the unit's version, written with it: unit-relative patterns, or { path, pointer }.", &[])),
        ("ignore", ignore()),
        ("maxBump", max_bump()),
    ]
});

/// The release block's own keys.
pub static RELEASE_BLOCK_KEYS: LazyLock<KeySchemas> = LazyLock::new(|| {
    vec![
        (
            "units",
            WorkspaceKeySchema {
                entry: Some(WorkspaceEntrySchema { key: "path", properties: UNIT_ENTRY_KEYS.clone() }),
                ..key(KeyType::EntryList, "The release units: each a directory with one version, one changelog and one fragment target, however many packages it ships. A bare string is an entry with no ecosystem keys.", &["packages/*"])
            },
        ),
        ("ecosystems", key(KeyType::Ecosystems, "Per ecosystem, the settings every anchor of it takes unless the anchor's own settings name the key: { <ecosystem>: { <key>: <value> } }.", &[])),
        ("groups", key(KeyType::Groups, "Named groups of unit keys sharing one version: every member releases at the highest level any member needs.", &[])),
        ("ignore", ignore()),
        ("maxBump", max_bump()),
    ]
});

/// The release block as one host sees it: the core keys plus each ecosystem's.
pub fn release_block_schema(adapters: &[std::sync::Arc<dyn EcosystemAdapter>]) -> WorkspaceBlockSchema {
    WorkspaceBlockSchema {
        description: "How releases are planned: the units, per-ecosystem settings, the groups sharing a version, and the highest bump allowed.",
        properties: &RELEASE_BLOCK_KEYS,
        ecosystems: adapters.iter().map(|adapter| (adapter.ecosystem().to_string(), adapter.keys())).collect(),
    }
}

/// Built-in when `release.ignore` is absent.
pub const DEFAULT_RELEASE_IGNORE: &[&str] = &["**/tests/**", "**/docs/**", "**/plans/**", "**/README.md", "**/CHANGELOG.md"];
