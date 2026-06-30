// Public surface of @telorun/fs. Controllers load via the per-kind subpath
// exports (`#file`, `#file-edit`, …); this `.` entry exposes the shared path
// and error primitives so a future filesystem driver or another module can
// build on the same cwd-resolution and error contract — mirroring how
// @telorun/shell exports its host helpers/types for driver reuse.
export { requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";
export type { FsManifest } from "./fs-support.js";
