---
description: "Normative: a packaged Telo executable — the carrier, where its payload rides and how it is found, the payload index, the desktop outputs (macOS bundle, Windows GUI executable), how a start becomes the application or the telo CLI (TELO_APP_CLI), where the payload unpacks (TELO_APP_DIR), and the executable as a manifest source."
---

# Packaged application

Normative. What a packaged executable is and how a `telo` treats one. `telo package` writes
it; every `telo` that runs, reads or describes one implements this exactly. The Node
reference is the CLI's `src/package/` (`app-trailer.ts`, `app-payload.ts`, `app-unpack.ts`),
`src/manifest-input.ts`, `src/app-cli-switch.ts` and `src/standalone/entry.ts`. The Rust
CLI implements §4 rules 1–3 only: it is not a carrier and reads no payload, so it neither
packages, starts, nor accepts a packaged executable as a manifest source.

## 1. The carrier

1. A packaged executable is a **carrier** — a released single-file `telo` for one platform —
   with an application's **payload** inside it. The carrier is the telo that packaged the
   application, at that telo's own version.
2. An executable that already carries a payload is never a carrier: packaging from one uses
   the release asset of its version, and a build that is not a release refuses.

## 2. Where the payload rides

1. The payload is followed by a **trailer** of 52 bytes, little-endian:

   | Offset | Size | Field |
   |---|---|---|
   | 0 | 4 | format version, `1` |
   | 4 | 8 | payload length in bytes |
   | 12 | 32 | sha256 of the payload |
   | 44 | 8 | the magic `TELOAPP1` (ASCII) |

   The payload is the `length` bytes immediately before the trailer. No absolute offset is
   recorded.
2. On ELF and PE the payload and trailer are appended to the carrier, so the trailer ends
   the file (placement `appended`). On Mach-O they are the contents of the section
   `TELO_APP_PAYLOAD` of the segment `TELO_APP`, so the trailer ends that section; the
   binary is re-signed after (`macho-segment`). In a Windows desktop app (§3 rule 5) they are
   the data of the first language of the PE resource of type `RT_RCDATA` (10) named
   `TELO_APP_PAYLOAD`, so the trailer ends that resource (`pe-resource`): signing appends a
   certificate table after the image, which a trailer ending the file would not survive.
3. A reader looks at the last 52 bytes of the file first; only when they do not end in the
   magic, at the `TELO_APP,TELO_APP_PAYLOAD` section of a 64-bit little-endian Mach-O; and
   only when the file is not a Mach-O, at the `RT_RCDATA` / `TELO_APP_PAYLOAD` resource of a
   PE image, found through its resource directory. A file with none carries no payload.
   Finding a trailer is enough to call the file a packaged executable; reading the payload
   verifies it.
4. A payload whose sha256 differs from the trailer's is refused as truncated or modified. A
   format version the reader does not know is refused naming both versions. A trailer
   claiming more bytes than the file — or, as a resource, than its resource — holds is
   refused.

## 3. The payload

1. The payload is one gzipped tar, framed with every header field pinned but the entry's
   name, contents, kind and link target, so one closure always produces the same bytes.
2. It holds `telo-app.json` (the **index**) at its root, the application's own files under
   `app/`, and the warmed cache tree under `cache/`. A child application — one started by a
   resource whose kind declares `x-telo-application-source` — is part of the closure,
   transitively: its manifest, files, import closure and built local modules are carried and
   judged exactly as the entry's, its relative `source:` keeps resolving inside `app/`, its
   modules are listed in the index's `modules`, and it loads against the sealed `cache/`. Every entry and every link target stays
   inside the directory it is unpacked into, or the payload is refused.
3. The index is JSON:

   | Field | Meaning |
   |---|---|
   | `format` | `1` |
   | `app` | `{ name, version? }` — the entry module's `metadata` |
   | `entry` | the entry manifest, payload-relative (`app/telo.yaml`) |
   | `platform` | `{ os, arch, libc?, abi? }` the payload was warmed for |
   | `telo` | the version of the telo that packaged it |
   | `analysisKey` | the analysis key (rule 4) |
   | `desktopHost` | `{ identifier }`, present exactly when the root declares a `Telo.DesktopHost` need (§3 rule 5); absent from every other index, which is otherwise unchanged |
   | `modules` | `{ source, name?, version?, delivery: local \| artifact }` per module |

4. The **analysis key** is the sha256, as lowercase hex, of one line per payload entry —
   every entry except those under `cache/analysis/`, `cache/validators/` and
   `cache/yaml-parses/` — sorted by entry name, each `<name>\0<digest>\n`, where `<digest>`
   is the sha256 hex of the entry's bytes, or `link:<target>` for a link. The analysis
   verdict under `cache/analysis/` is filed and signed under it rather than under the
   unpacked tree's paths.

5. A **desktop app** is an application whose root declares a `Telo.DesktopHost` need, read
   from the need table. Packaging one refuses an `icon` that is not a PNG, or not square, or
   under 1024 px a side, with `ERR_DESKTOP_ICON_INVALID` (`<icon as written> must be square
   and at least 1024 px (it is <w> × <h>)`) before anything is written, and a helper that
   cannot be obtained with `ERR_DESKTOP_HOST_UNAVAILABLE`. The helper for the packaged
   platform is the environment's `TELO_HOST_DESKTOP_HELPER` or a source checkout's build when
   that platform is the packaging machine's, the release's asset otherwise. What is written
   depends on the platform:

   | Platform | Output for `--out <path>` | Payload | Helper |
   |---|---|---|---|
   | linux | `<path>`, the carrier | `appended` | the payload entry `helper/telo-desktop-host` |
   | darwin | the application bundle `<path>.app` (kept when `<path>` ends in `.app`) | `macho-segment`, in `Contents/MacOS/<name>` | `Contents/MacOS/telo-desktop-host`, beside the carrier; not in the payload |
   | windows | `<path>.exe`, a GUI-subsystem executable | `pe-resource` | the payload entry `helper/telo-desktop-host.exe` |

   - **darwin.** `<name>` is the `productName` with `/`, `:` and control characters
     replaced by `-` and surrounding space and leading dots removed, or the root's
     `metadata.name` when nothing remains. `Contents/Info.plist` is an XML property list
     holding `CFBundleExecutable` (`<name>`), `CFBundleIdentifier` (`identifier`),
     `CFBundleName` and `CFBundleDisplayName` (`productName`), `CFBundlePackageType`
     `APPL`, `CFBundleInfoDictionaryVersion` `6.0`, `CFBundleShortVersionString` and
     `CFBundleVersion` (the up to three leading integers of the root's `metadata.version`,
     both absent without one), `CFBundleIconFile` `AppIcon` (with an `icon`),
     `LSMinimumSystemVersion` `14.0`, `NSHighResolutionCapable` true, and `LSUIElement`
     true when `showInDock` is false. `Contents/PkgInfo` is `APPL????`. With an `icon`,
     `Contents/Resources/AppIcon.icns` holds it as PNG entries `icp4` (16 px), `icp5` and
     `ic11` (32), `ic12` (64), `ic07` (128), `ic13` and `ic08` (256), `ic14` and `ic09`
     (512) and `ic10` (1024), each reduced from the icon by area averaging, `ic10` the
     icon's own bytes when it is exactly 1024 px. Both executables are mode `0755`, the
     helper and then the bundle are signed ad hoc, and packaging requires a macOS host.
   - **windows.** The carrier's `IMAGE_OPTIONAL_HEADER.Subsystem` is `2` (Windows GUI) and
     its checksum is recomputed. Every resource the carrier holds is kept except the
     version, the icons when the need names an `icon`, and a previous payload. Added, all
     but the payload in language `0x0409`: with an `icon`, `RT_ICON` ids 1–6 (256 px as a
     PNG, 64, 48, 32, 24 and 16 px as 32-bit bitmaps) and `RT_GROUP_ICON` id 1 naming them;
     `RT_VERSION` id 1, whose string table `040904B0` holds `ProductName` and
     `FileDescription` (`productName`) and, with a `metadata.version`, `ProductVersion` and
     `FileVersion` (as written) — no `CompanyName` — and whose fixed version is its leading
     integers; and the payload (§2 rule 2, language `0`). The resource tree is rewritten in
     place when its section ends the image and as a new last section otherwise; no other
     section's bytes or addresses move, except that headers with no room for one more
     section header grow by one file-alignment unit, moving every section's file offset by
     that much. A carrier's certificate table is dropped, since the edit invalidates it.

   A start passes the packaged app's own helper — the unpacked payload entry, or on darwin
   `telo-desktop-host` beside the running executable — which `TELO_HOST_DESKTOP_HELPER`
   still overrides.

## 4. A start: the application or the CLI

1. `TELO_APP_CLI` selects what a start of a packaged executable is: `1` means the telo CLI,
   unset or empty means the application. Any other value is a refusal of the invocation:
   before any manifest is read, the start writes nothing to stdout, names the variable and
   `1` on stderr, and exits with status 2 — in every distribution.
2. Every `telo` start — whatever its distribution, and whether or not it carries a payload —
   reads `TELO_APP_CLI` and removes it from its own environment before anything else reads
   it, so no kernel, controller or process it starts sees it.
3. On a `telo` with no payload the variable does nothing else: a start with `TELO_APP_CLI=1`
   is a start without it.
4. A start of a packaged executable as its application, `<binary> <args>`, is exactly
   `TELO_APP_CLI=1 <binary> run <binary> <args>`: every argument is the application's
   (`kernel/specs/application-arguments.md`), the payload unpacks into the same directory
   (§5), the payload's `cache/` is the cache, the run is keyed by the index's
   `analysisKey`, env files are read from the working directory, and the exit code and
   signal handling are `telo run`'s. A desktop app (§3 rule 5) reads them from the per-user
   application directory of its `identifier` instead (`$XDG_DATA_HOME/<identifier>` or
   `~/.local/share/<identifier>`, `~/Library/Application Support/<identifier>`,
   `%LOCALAPPDATA%\<identifier>`), created if missing; once it is hosting itself its working
   directory is that directory too and `TELO_HOST_STATE_DIR` is `<that directory>/state`
   unless the environment names one. An app whose host the environment supplies keeps the
   working directory it started in.
5. As the CLI, a packaged executable is the telo it carries, with every command and option
   that telo has. A `telo` that re-runs its own executable as the CLI — `telo runner`
   starting an application — sets `TELO_APP_CLI=1` on the child when that executable
   carries a payload, and not when it runs another release's binary.
6. `TELO_APP_INFO` is retired. A packaged executable starting as its application with
   `TELO_APP_INFO` set to anything but whitespace refuses the invocation as rule 1 does —
   before any manifest is read, nothing on stdout, exit status 2 — and starts nothing,
   naming `TELO_APP_CLI=1 <binary> package inspect <binary>`, which prints the index with
   the payload's size, digest and placement (§2 rule 2). `package inspect` also takes an
   application bundle's directory, reading the executable its `CFBundleExecutable` names.
7. There is no other environment variable selecting an option of the CLI.

## 5. Where the payload unpacks

1. The unpack root is `<TELO_APP_DIR>/apps` when `TELO_APP_DIR` is set, else
   `<user cache>/apps` (`$XDG_CACHE_HOME/telo` or `~/.cache/telo` on Linux,
   `~/Library/Caches/telo` on macOS, `%LOCALAPPDATA%\telo` on Windows), else
   `<temporary directory>/telo-apps` — the first one this process can write. With none,
   the start refuses naming `TELO_APP_DIR`.
2. The payload unpacks into `<root>/<app.name>-<first 16 hex digits of its sha256>`,
   private to the user (`0700`). It is written beside that path and renamed into place,
   with the file `.telo-app-ready` written last; a directory holding it is complete and is
   reused rather than unpacked again.
3. A process using a tree holds it with the empty file `live/<pid>` inside it, written
   before the tree becomes visible and removed when the process exits.
4. A **run** reclaims the application's other trees (`<root>/<app.name>-*`) that no live
   process holds; a pid that names no process holds nothing. Reading an executable as a
   manifest source (§6) reclaims nothing.
5. `TELO_CACHE_DIR` does not apply to a packaged executable: its payload is its only cache
   (§6 rule 4).

## 6. A packaged executable as a manifest source

1. Every command that takes a manifest accepts a packaged executable in its place — `run`,
   `check`, `describe`, `needs report`, `env template`, `cel functions`. The executable is
   recognised by §2 rule 3, its payload unpacked by §5 into the directory a run would use,
   and the command loads the unpacked entry against the payload's `cache/`.
2. Nothing the payload carries is executed by reading it: a command that does not run the
   application answers as it does for the unpacked entry, byte for byte.
3. Where a command reads or writes the application's env files — a run's env files and its
   `--debug` log `.telo.debug.jsonl`, `env template --write` — it is the working
   directory, as for §4 rule 4.
4. The payload's `cache/` is a **sealed** cache root. A command loads a packaged executable
   through a loader of its own whose only cache is that root: no other root serves the
   executable's modules, and the root serves no other input of the same command. A module
   the root holds is read as it is — never revalidated against its origin, so no request is
   made for it, a mutable `oci://…@<tag>` import included — and nothing is ever removed
   from the root. A module the root does not hold is resolved through the transports as for
   any manifest. A command that does not run the application writes nothing into the root;
   a run of it (§4 rule 4) loads against the same root and may add to it.
