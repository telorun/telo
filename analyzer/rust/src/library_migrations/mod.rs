//! Library-authored manifest migrations — a library's `migrations:` block, read off its
//! module document. Mirrors the reader and the matcher of
//! `../../../nodejs/src/library-migrations/`. The consumer stage that applies them is not
//! twinned: [`unapplied_refusal`] is what this build does instead.

pub mod declaration;
pub mod r#match;
pub mod unapplied_refusal;

pub use declaration::{read_library_migrations, LibraryMigration, MigrationRule, MigrationSeverity};
pub use r#match::{migration_match_holds, MigrationMatch};
pub use unapplied_refusal::{unapplied_library_migrations, UnappliedLibraryMigration};
