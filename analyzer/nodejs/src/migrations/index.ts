/** The migration mechanism's surface — what a consumer OUTSIDE this directory
 *  may hold.
 *
 *  Deliberately narrow. The matcher, the patch planner and the two appliers are
 *  one mechanism with one entry point per job (`migrateManifests` for the
 *  loader, `migrateFileText` for `telo migrate`, `remapMigratedPaths` for a
 *  diagnostic consumer); re-exporting their internals would make the plan/apply
 *  split, the effect vocabulary and the text-edit shape semver-bound API with
 *  no caller, and freeze the one part most likely to change as the operation
 *  vocabulary grows.
 *
 *  The entry-set trio (`CORE_MIGRATIONS`, `parseMigrationEntry`,
 *  `MigrationEntry`) is here because `LoaderInitOptions.migrations` is a
 *  composition-root seam: a host aggregating module-shipped entries beside the
 *  core ones needs to read one and to name the set it is extending. */

export { migrateFileText, migrateManifests, NO_MIGRATIONS } from "./driver.js";
export type { FileMigrations } from "./driver.js";
export { parseMigrationEntry } from "./entry-data.js";
export { remapMigratedPaths } from "./provenance.js";
export { CORE_MIGRATIONS } from "./registry.js";
export type { MigrationEntry, MigrationRewrite } from "./types.js";
