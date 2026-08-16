// Public surface of @telorun/fs. Controllers load via the per-kind subpath
// exports (`#file`, `#file-edit`, …); this `.` entry exposes the shared path
// and error primitives so a future filesystem driver or another module can
// build on the same cwd-resolution and error contract — mirroring how
// @telorun/shell exports its host helpers/types for driver reuse.
export { requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";
export type { FsManifest } from "./fs-support.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as DirectoryCreationController from "./directory-creation-controller.js";
export * as DirectoryListingController from "./directory-listing-controller.js";
export * as FileController from "./file-controller.js";
export * as FileEditController from "./file-edit-controller.js";
export * as FileRemovalController from "./file-removal-controller.js";
export * as FileWriteController from "./file-write-controller.js";
export * as TreeSnapshotController from "./tree-snapshot-controller.js";
export * as TreeSyncController from "./tree-sync-controller.js";
