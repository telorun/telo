//! Manifest migrations — a legacy spelling published artifacts still carry, rewritten to
//! the current one at load. Mirrors `../../../nodejs/src/migrations/index.ts`.
//!
//! The entries are data under `analyzer/migrations/`, embedded here as the Node half reads
//! them; the driver runs once per file after parse and before anything else reads the
//! tree. Node's `yaml-edit.ts` and `migrateFileText` — `telo migrate`'s file repair — have
//! no twin: no Rust reader writes YAML back, so the command is the Node CLI's alone.

pub mod driver;
pub mod entry_data;
pub mod r#match;
pub mod patch;
pub mod provenance;
pub mod registry;
pub mod report;
pub mod types;

pub use driver::{migrate_manifests, FileMigrations};
pub use entry_data::parse_migration_entry;
pub use provenance::remap_migrated_paths;
pub use registry::core_migrations;
pub use types::{MigrationEntry, MigrationEntryError, MigrationRewrite};
