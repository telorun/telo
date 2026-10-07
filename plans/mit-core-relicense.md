# MIT for what authors link and write, Sustainable Use for what runs it

## Problem

Everything in the repository is under one Sustainable Use License: a single root `LICENSE`, `"license": "SEE LICENSE IN LICENSE"` in every npm package, `license: LicenseRef-SustainableUse` in 209 module manifests, and no license field in any Rust crate. The license already permits using, modifying, distributing and selling the software; its one restriction (clause 1) is offering it to third parties as a managed service where the software's own functionality is the primary value. That restriction exists to protect hosted Telo editing and running, but it also travels with the code a module or controller author links against, and with the modules, starters, examples and doc snippets an author copies, forks and publishes from. Two costs follow: a custom license text fails automated license scanning and needs legal review even where the use is permitted, and anyone building a platform on the SDK or the standard library must argue that Telo is not the "primary value" of what they offer.

## Solution

**One rule: no MIT package depends on a Sustainable Use package.** MIT covers what an author links against, what an author writes, and the first-party apps built purely from those; everything that loads, checks, edits or runs a manifest stays under Sustainable Use.

| MIT | Sustainable Use (unchanged) |
|---|---|
| `@telorun/cel`, `@telorun/sdk`, `@telorun/templating` and every Rust crate beneath `cel/`, `sdk/` and `templating/` (including `telorun-sdk`, `telorun-sdk-core`, `telorun-abi`) | `@telorun/analyzer`, `kernel`, `cli` and their Rust twins |
| `@telorun/glob`, `@telorun/editor-protocol` | `@telorun/ide-support`, `language-server`, `language-host`, `ide/vscode` |
| every module under `modules/` | `@telorun/runner-core`, `debug-wire`, `debug-ui`, `apps/docker-runner`, `apps/k8s-runner` |
| `blueprints/`, `starters/`, `examples/`, `docs/`, `benchmarks/` | `apps/studio`, `apps/authoring-agent`, `pages` |
| `apps/hub`, `apps/hub-web`, `apps/plan-approval`, `apps/plan-approval-runner`, `apps/plan-approval-runner-protocol`, `apps/plan-approval-web` | |

No package boundary moves: the MIT set already depends only on itself. `pages` renders `docs/` and stays restricted, which is the permitted direction. The hub's integration tests launch the `telo` binary as a command; running a restricted program is not a dependency on it.

A **module root** below means a directory `telo release` versions as a module — every standard-library module, each generated Tesseract language module, and each blueprint — plus every application and library manifest of the MIT apps (`apps/hub`, `apps/plan-approval*`, including `apps/plan-approval/demo` and `apps/plan-approval/plans`). Test and fixture manifests are not module roots.

**License files and declarations.**

- Root `LICENSE` stays the Sustainable Use text, unedited. Each MIT directory — `cel/`, `sdk/`, `templating/`, `packages/glob/`, `packages/editor-protocol/`, `modules/`, `blueprints/`, `starters/`, `examples/`, `docs/`, `benchmarks/`, `apps/hub`, `apps/hub-web` and each `apps/plan-approval*` directory — carries its own checked-in `LICENSE` with the MIT text, copyright CodeNet Sp. z o.o. The root `README.md` License section lists the MIT directories and says everything else falls under the root license.
- Every module root also carries that `LICENSE` itself, because a published artifact is cut from the module root and the directory-level file is outside it. The Tesseract generator emits the file for its 122 modules.
- `telo publish` and `telo package` carry a module root's `LICENSE` into the artifact with no `files:` entry, in a layer every host materializes. `kernel/specs/module-artifact.md` and the module release guide say so.
- MIT npm packages declare `"license": "MIT"` and pack their own directory's `LICENSE`; Sustainable Use packages keep `"license": "SEE LICENSE IN LICENSE"` and keep copying the root file at pack time.
- Every Rust crate declares a license: `license = "MIT"` beneath an MIT directory, the root license file everywhere else.
- The module doc of every module root declares `license: MIT`: the standard-library modules and the five `apps/plan-approval*` manifests change their value, the 6 blueprints and the hub's manifests gain the field, and the Tesseract generator emits it. The field states the license of the module's own files; a third-party file staged through `sources:` keeps its upstream license, carried by that entry's `notices`. Manifests in restricted directories keep `LicenseRef-SustainableUse`.
- Docs that name the license are corrected: the docs site footer, the teams page, the low-code comparison guide and the VS Code extension README say the SDK, the expression engine, the standard library and the hub are MIT, and the runtime, tooling, studio and runners are under Sustainable Use.
- The root guide states the rule and the MIT directory list.

**Enforcement.** `pnpm run check:licenses`, run in CI, fails when:

- a package declaring `MIT` has a dependency, dev dependency, peer dependency or `teloInlines` entry on a workspace package that does not;
- a Rust crate declaring `MIT` has a path dependency on a crate that does not, or any crate declares no license;
- an MIT directory has no `LICENSE` of its own, or a package beneath one declares anything other than `MIT`;
- a module root has no `LICENSE`, or its module doc declares no license or anything other than `MIT`. Only the module doc of a module root is read.

**Release bookkeeping.** One changeset for the version line (`cel`, `sdk` and `templating` are members, so the whole line releases); one each for `glob` and `editor-protocol`. One `Added` release fragment naming every module root that `telo release` versions, written with `telo release add`.

**Verify.**

- `pnpm run check:licenses` passes, and fails when `@telorun/sdk` is given a dependency on `@telorun/analyzer`.
- `npm pack` of each MIT package contains the MIT text and reports `MIT`; of `@telorun/kernel`, the Sustainable Use text.
- `pnpm run check:licenses` fails when a module's `license:` field is removed, and when its `LICENSE` is deleted; a test manifest with no license does not fail it.
- A standard-library module and a blueprint, published and pulled into an empty directory, each contain the MIT text with the copyright line.
- A published module's controller layer contains no code from a Sustainable Use package.
- `cargo metadata` reports a license for every crate in the workspace.
- `pnpm run test` passes.
- After the module release, the hub's `get_module` reports `MIT` for a standard-library module.

## Decisions

- **The runtime stays restricted, so hosted running stays protected.** With the kernel and CLI under Sustainable Use, a hosted runner cannot be assembled from MIT code alone. Embedding and redistributing the runtime inside a product stays permitted, as it is today; the cost is that the runtime keeps a custom license text a scanner or legal team must review.
- **The hub is MIT, so discovery is not protected.** Anyone may run a competing discovery hub as a service. The restriction protects editing and running only.
- **The analyzer and the editor packages stay restricted.** MIT cannot be withdrawn from a released version, so the line starts narrow; the rule already permits widening it to the analyzer later, since the kernel depends on it and not the reverse.
- **The version line is mixed-license.** Membership is decided by binding to one telo generation, not by license; three members are MIT and five are not.
- **Root `LICENSE` stays Sustainable Use** rather than MIT with restricted directories: most of the repository is restricted, and the Sustainable Use text stays unedited instead of gaining a scoping sentence.
- **Starter and example manifests declare no license.** A starter becomes the author's own application, and a `license:` field in it would declare the license of their app for them; the directory `LICENSE` covers the copy.
- **Each module root carries its own `LICENSE`** rather than publish injecting the repository's text: an artifact then matches its source directory, and a module forked out of the repository keeps its notice.
- **Published versions are left as they are.** MIT applies from the next release of each package and module.
- **CodeNet relicenses as copyright holder** of everything moving to MIT.
