# Changelog

## 0.14.0 - 2026-10-10
### Added
* Fs.FileWrite takes a stream of bytes as content, beside text and bytes, and an optional maxBytes (an integer of at least 0; omitted is no limit) that applies to every form. A stream is written as it arrives to a sibling file named .<basename>.<random>.tmp and renamed over the target once it ends, so no reader sees part of it: an existing regular file keeps its permission bits, a symbolic link is written through, and a target that is not a regular file (a FIFO, a device, a socket) is written in place. Text and bytes are written in place as before. Content over maxBytes fails with the declared code ERR_FILE_TOO_LARGE: for text and bytes before the file is opened, with data path, maxBytes and size; for a stream on the chunk that crosses the bound, with data path and maxBytes, the staging file removed and the target keeping its previous content or staying absent. A failure of the stream's source is rethrown as it was raised, with the staging file removed. Because the code is now declared, a route whose handler is an Fs.FileWrite and whose catches list has no catch-all must cover ERR_FILE_TOO_LARGE. A computed content value that is none of the three forms is still refused with ERR_INPUT_INVALID. New docs page: file-write.md.

## 0.13.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.12.0 - 2026-10-03
### Added
* Bounded, paged and digest-reporting reads. Fs.File's output gains sha256 (hex digest of the file's bytes, the value a tree snapshot reports as hash) and its input gains maxBytes: a larger file fails with ERR_FILE_TOO_LARGE before its content is read. Fs.DirectoryListing gains limit and cursor inputs and a nextCursor output (absent when the listing is complete), and returns entries sorted by path; a call with limit lists and measures its page plus one look-ahead entry and nothing past it. Fs.TreeSnapshot's file entries gain size and its output gains missing, the requested paths at which nothing exists. Path order, for both kinds, is the whole path compared by Unicode code point (UTF-8 byte order). Breaking: Fs.TreeSnapshot's path input is replaced by paths, a list of file or directory roots (omitted still means cwd), so a call passing path is refused; a root that does not exist is reported in missing instead of failing the call; and every Fs.DirectoryListing, paged or not, now orders entries by whole path, so a recursive listing returns a.txt before a/1.txt.

## 0.11.0 - 2026-09-22
### Added
* Breaking: every kind's `cwd` is a Telo.HostPath: an absolute directory. Write a directory that ships with the module as `!module-path ./dir`, and one on the host from a variable declared x-telo-type: Telo.HostPath. A relative literal is refused (HOST_PATH_RELATIVE); omitting `cwd` still means the working directory. Requires telo >=0.98.0.

## 0.10.1 - 2026-09-17
### Fixed
* Writing content that is neither text nor bytes no longer claims bytes cannot be written inline in a manifest: the refusal names the ways raw bytes arrive - a producing resource or a file embedded with !include-bytes - and encoding: base64 for binary spelled out as text.

## 0.10.0 - 2026-08-27
### Added
* `DirectoryListing` takes an `exclude` list — base names omitted at any depth, an excluded directory neither listed nor descended, the semantics `TreeSnapshot` already had. A recursive listing of a real tree is unreadable without one: caches and vendor directories (`.telo`, `node_modules`, `.git`) drown the entries a caller asked for.
### Fixed
* An optional invoke `path` now accepts the empty string as a spelling of its default: `DirectoryListing` and `TreeSnapshot` declared `minLength: 1` on a field that is optional and means `cwd`, so a caller passing "" for the root — an LLM tool call above all — was rejected by the contract check even though the controller already resolved it to `cwd`.

## 0.9.2 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.
* Paths emitted into manifest data use `/` separators on every host. `Fs.DirectoryListing`'s `entries[].path`, `Fs.TreeSnapshot`'s `files[].path` and `Test.Suite`'s test labels were built with `path.relative` and left unnormalized, so on Windows they came back as `a\b.txt` — a CEL filter like `f.path == 'a/b.txt'` matched on Linux and silently found nothing there. Inputs are unchanged and still accept either separator.

## 0.9.0 - 2026-08-11
### Added
* Filesystem operations log what they touched: writes at debug with path and size, Fs.FileRemoval at info with the path, and Fs.TreeSync with one info carrying the number of paths deleted (each path individually at debug, since a routine delta legitimately carries hundreds). A deletion is the one operation with nothing left behind to inspect afterwards — TreeSync's is recursive and force:true, so a mistyped path takes a tree and a path that never existed reports success either way. File contents are never logged.## 0.8.0 - 2026-08-09
### Added
* Fs.FileWrite and Fs.TreeSync accept raw bytes as content, alongside the existing utf8 and base64 string forms. A Uint8Array handed over by a byte-producing resource — a generated image, a decoded payload — is now written as it is, with no base64 round trip and no JS.Script hop in between. encoding does not apply to raw bytes and is ignored for them.## 0.7.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.6.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.5.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.4.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.4.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.3.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.2.1 - 2026-07-06
### Fixed
* Quote description strings containing a colon-space inside backticks (e.g. `encoding: base64`) so the registry's strict YAML parser accepts the manifest on publish.## 0.2.0 - 2026-07-06
### Added
* Update controller @telorun/fs to 0.2.0.## 0.1.0 - 2026-06-30
### Added
* Update controller @telorun/fs to 0.1.0.## 0.0.0
