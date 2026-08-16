---
"@telorun/kernel": patch
"@telorun/cli": patch
---

Two places converted a `file://` URL to a filesystem path by hand rather than
through `fileURLToPath`, and both failed on Windows.

The napi controller loader sliced the seven-character `file://` prefix off the
declaring manifest's URL. A file URL's path is not a filesystem path: on Windows
`file:///D:/a/telo/telo.yaml` sliced that way leaves `/D:/a/telo/telo.yaml`, whose
leading slash makes `path.resolve` graft the current drive on and produce
`D:\D:\a\telo\…`, so every `pkg:cargo` controller resolved to a crate directory
that does not exist. It also left percent-escapes undecoded on every platform, so
a manifest under a directory with a space resolved to a path that is not there.

The CLI's diagnostic formatter called `fileURLToPath` unguarded when shortening a
manifest source for display. That function throws rather than returning null, and
on Windows it throws for any file URL without a drive letter — so
`file:///app/telo.yaml`, perfectly ordinary from a Linux-authored manifest or a
container path, replaced the diagnostic being reported with an
`ERR_INVALID_FILE_URL_PATH` from the code reporting it. A `file://` URL that names
no path on this host now renders as the URL, which is what the `http(s)://` branch
beside it already did.
