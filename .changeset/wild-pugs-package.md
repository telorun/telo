---
"@telorun/cli": minor
"@telorun/kernel": minor
---

`telo package` — ship an application as one executable

`telo package <manifest> --out <file> [--platform os/arch[/libc]]` writes the
released `telo` binary for that platform with the application inside it: the
manifest, every local file its graph reaches, and the whole resolved import
closure, already warmed. The result runs on a machine with no Node.js, no telo
and no network. Every argument belongs to the application; `telo package inspect
<file>` and `TELO_APP_INFO=1` report what a binary carries. Packaging a darwin
platform requires a macOS host. `docs/guides/packaging-an-app.md` has the rest.

A packaged app carries the telo that packaged it, and that is enforced: only a
released telo may download a carrier, because a working copy and the release of
the same version number are different code. From a source checkout, build that
checkout's own binary (`pnpm --filter @telorun/cli build:standalone`) and package
with it.

Two things a packaged app needs that everything else gets too:

- **`telo install` REFUSES an incomplete warm for a platform you NAME.** A layer
  it could not materialize — a failed fetch, or one constraining an axis the
  target leaves undetermined — was a warning on the grounds that `telo run`
  fetches lazily. That is false for a baked image and for a payload, whose warmed
  tree is the only cache they have, so the skip surfaced as a boot failure on
  another machine. **An image build passing `--platform` without `--abi` over a
  closure with abi-constrained native layers now fails where it used to warn**;
  pass `--abi <family>-<version>`. A bare `telo install` is unchanged in spirit:
  the target is this machine, its ABI is now used rather than discarded, and a
  gap is a warning.
- **`Kernel.load` takes an `analysisKey`**, which changes how the analysis
  verdict is FILED and how the files it covers are IDENTIFIED — under the key,
  and relocatably (a remote module by its pinned ref, a local one relative to the
  entry) rather than by absolute paths that do not survive a tree being used
  somewhere other than where it was built. The signature still covers every
  file's content, so a relocated cache hits while an edited one re-validates.
