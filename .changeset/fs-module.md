---
"@telorun/fs": minor
---

Add the fs module: local filesystem access via Node `fs/promises` — `Fs.File` (read), `Fs.FileWrite` (write), `Fs.FileEdit` (in-place string replacement), `Fs.DirectoryListing` (list), `Fs.DirectoryCreation` (mkdir), and `Fs.FileRemoval` (remove). Each carries an optional `cwd` invoke paths resolve against; UTF-8 by default with a base64 escape hatch for binary.
