# @telorun/fs

## 0.2.0

### Minor Changes

- 06c675b: Add two generic tree primitives. `Fs.TreeSnapshot` (`{ path?, exclude? }` → `{ files: [{ path, hash }] }`) is a recursive content-hash walk — sha256 hex per file, a reliable change detector where `DirectoryListing`'s size is not — with base-name `exclude` for vendor/build dirs. `Fs.TreeSync` (`{ write?: [{ path, content, encoding? }], delete?: [path] }` → `{ written, deleted }`) applies an explicit change set: writes each file (creating parents), removes each deleted path, and never implicitly deletes files absent from the set, so one call serves both a full seed and a partial delta. Together they compose into two-way tree sync (snapshot both sides, diff, push the difference).

## 0.1.0

### Minor Changes

- 80dc409: Add the fs module: local filesystem access via Node `fs/promises` — `Fs.File` (read), `Fs.FileWrite` (write), `Fs.FileEdit` (in-place string replacement), `Fs.DirectoryListing` (list), `Fs.DirectoryCreation` (mkdir), and `Fs.FileRemoval` (remove). Each carries an optional `cwd` invoke paths resolve against; UTF-8 by default with a base64 escape hatch for binary.
