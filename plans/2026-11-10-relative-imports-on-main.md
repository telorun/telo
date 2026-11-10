---
status: done
priority: high
depends-on: []
packages: [cli, ci, scripts, studio, docs, examples, starters, blueprints, apps]
---

# Relative imports in every branch, pinned only in published tags

## Before

- The in-repo consumers — every manifest under `examples/`, `starters/`, `apps/`, `blueprints/`, their tests and fixtures included — import released modules by pinned `oci://` reference on main, and by relative path only while a change to the module is unreleased. `Record release` repins main with `telo upgrade --pin-local` after every release.
- A pinned consumer is checked against the old published module. A module change that breaks a consumer therefore passes on main and on the release branch, and fails only when the consumer is repinned — after the module is published. PR #784: `ui-react@0.12.0` moved `filters.show` / `filters.summary` under `placement`, and the `todo` starter failed only in the `Sync imports` PR, which was merged red.
- A release opens three PRs on its branch: the Version PR, the Module Release PR (after the final) and the `Sync imports` PR (after modules publish), plus the record PR on main.
- `v<x.y.z>` is tagged before the line's modules publish, so its starters carry the previous release's pins. Studio bakes `VITE_TELO_STARTERS_URL` to its own `v` tag. App images (`hub`, `authoring-agent`) are built from a commit whose pins are one release behind.
- `--pin-local` reads as "pin to local versions", which it is not.
- The plan-approval apps (`apps/plan-approval`, `apps/plan-approval-runner`, `apps/plan-approval-runner-protocol`, `apps/plan-approval-web`) now live outside this repository, but their copies here are still built, licensed, excluded from the release workspace and run by CI.

## After

### plan-approval leaves the repository

- The four `apps/plan-approval*` directories are deleted, before the conversion below, so it touches none of them.
- Every reference goes with them: the `pnpm-workspace.yaml` entry and its lockfile entries, the three exclusions in `telo-workspace.yaml`, the plan-approval suite steps and their comments in `test.yml`, the package-test selection's mention, and the MIT directory lists in `scripts/check-licenses.mjs`, the root `README.md` and the root guide.
- `@telorun/plan-approval-web` is private, so the change carries an empty changeset.

### Every branch imports the working copy

- On main and on every `release/*` branch, every import of a release-workspace module in a manifest under `examples/`, `starters/`, `apps/` and `blueprints/` — tests and fixtures included — is a relative path. Imports of modules outside the workspace stay pinned.
- The static checks on main and on `release/*` run `telo release imports --as=relative --check` over the four roots, refusing a pinned import of a workspace module and naming it.
- Every check, suite and `telo changed` selection runs the consumers against the working copy as committed: a module change that breaks a consumer fails the PR that makes it. On every line cut after this change, a `git cherry-pick -x` from main applies to the branch without import-line conflicts.
- `Record release` no longer repins. It still copies versions, changelogs and ledger entries, deletes released changesets and fragments, and measures floors.
- `apps/*` and `blueprints/*` are release-workspace modules, so their relative imports become import edges: every release that bumps a module one of them imports bumps it too, and rebuilds the app's image and chart. That is what `Sync imports` already caused one release later; it now happens in the same release.
- The conversion is one change on main: `telo release imports --as=relative` over the four roots, plus the fixes it surfaces (the `todo` starter's `filters` at least), with a fragment for every app and blueprint whose files change.

### `telo release imports`

`telo release imports <paths..> --as=published|relative [--check] [--dry-run] [--registry <base>] [-o json]`

- Rewrites imports of modules of the release workspace, in the manifests named on the command line only. Imports of other modules are untouched, as is a target below the importing manifest's directory (a nested library, which ships inside the importer) and an image module.
- An import of the module a manifest sits inside — a module's own test or fixture, a blueprint's `example/` — is always relative: `--as=published` leaves it relative, `--as=relative` writes it relative, and `--check` reports it pinned.
- `--as=published` rewrites a relative import to `<destination>@<version>#<pin>`, the pin read from the registry for the version in the tree — never derived from the working copy. A module the release plan still bumps, and a version the registry does not have, stay relative with the reason printed; the command exits 1 when any import is left relative.
- `--as=relative` rewrites a pinned import whose repository is a workspace module's publish destination to the relative path from the manifest's directory to the module's directory, written `../…/<dir>` with no trailing `/telo.yaml`. The version in the reference is not consulted.
- `--check` writes nothing and exits 1, listing every import whose form differs from what the command would write.
- `--as` is required; a missing or unknown value is a usage error (exit 2).
- `telo upgrade --pin-local` stays for one release as a deprecated alias of `telo release imports --as=published` on the same manifests, printing the replacement; no workflow calls it. `telo upgrade` otherwise bumps only imports of modules outside the workspace, and stays a command a person runs on main.
- `pnpm run imports -- --as=<published|relative> [--check]` runs the command over every manifest with an `imports:` block in the four roots.
- `cli/rust` owes the command, as it owes `telo release floor`.

### A module publishes its imports by the target's assigned destination

- Apps and blueprints are released modules at other directory depths and registry bases than the modules they import, so a relative import leaving the importer's root no longer canonicalizes to the right ref by path arithmetic (`apps/hub` publishes to `ghcr.io/telorun/hub`, so `../../modules/sql` would become `ghcr.io/modules/sql`).
- When an import of a workspace module leaves the importer's own directory, the ref `telo publish` writes into the published manifest, the release plan's import graph and `telo release imports --as=published` is the target module's assigned destination plus its version and pin: `<assigned destination>@<version>#<pin>`, written with the transport that owns that destination. One destination resolver, fed by the workspace marker's registry cascade, answers it for all of them. Path arithmetic remains only for a library nested inside the importer's root, whose relative spelling ships in the artifact.
- `IMPORT_DESTINATION_CONFLICT` is retired. `IMPORT_TARGET_NOT_RELEASED` (error, at plan time) replaces its one remaining meaning: a workspace module imports by relative path a manifest outside its own directory that the workspace does not release on its own, such as a library nested inside another module. `DESTINATION_COLLISION` and `WORKSPACE_MODULE_NESTED` are unchanged.
- `telo publish` of a module inside a release workspace takes its destination from the same resolver and refuses a positional destination that differs from the module's assignment (`destination_mismatch`, a new code in the closed publish-failure set). Outside a workspace it derives as today and `sibling_not_published` still guards it.
- A sibling pin derived from locally built bytes is compared, at a non-dry-run publish, with the hash of the `telo.yaml` the registry serves for it; a mismatch is `import_pin_mismatch`.
- The workspace marker is unchanged: blueprints keep `registry: oci://ghcr.io/telorun/blueprints`.

### One release PR

- `chore(release): version`, from `changeset-release/release/<x.y>`, is the only PR a release opens on its branch. The branch's Publish run builds it — with its own step pushed by `TELO_BOT_TOKEN`, not `changesets/action`'s PR mode, which opens nothing without changesets — whenever the branch has something to release: pending changesets, module drift, or both. In order, it versions the npm packages from the pending changesets (rewriting `>=unreleased`), runs `telo release apply`, and stamps chart versions.
- Its body is generated from the changesets and the module release plan, degrading in stages under GitHub's 65536-character limit as the module PR body does today.
- `changesets/action` keeps only publishing. `check-release-pr` keeps guarding `changeset-release/*` against a major bump, now over npm and module versions both.
- Its CI is the branch's full CI over the tree as committed, plus one gate: `telo release imports --as=published --dry-run` over the four roots fails when an import would stay relative for any reason other than its version awaiting this release's publish. So the publication commit can fail after merge only on a registry error, which a re-run heals.
- The Module Release PR and the `Sync imports` PR are removed, with the changeset-gate and `telo release check` exemptions for their head branches (`module-release/*`, `imports/*`).

### The publication commit

- Merging the release PR of a final or patch runs one Publish, in order:
  1. npm;
  2. modules (so every floor names a published telo);
  3. the publication commit;
  4. every tag of the release, then the `Record release` dispatch;
  5. the artifact check;
  6. app images, Studio, the site, the standalone CLI, the `.vsix` and the GitHub Release, each checking out or anchored to the tag.
- The **publication commit** is a child of the merge commit (its **release commit**) that no branch holds. Its message is `chore(release): publish <tag>` and its only change is `telo release imports --as=published` over the four roots. Its tree is a function of the release commit and the registry's immutable pins, and its author, committer and both dates are fixed (the bot, the release commit's dates), so a re-run makes the same commit and finds its tags already in place.
- Every tag of a final, patch, `modules-<x.y>-<n>` or `packages-<x.y>-<n>` release is placed on the publication commit, and carries pins to published artifacts only. `v<x.y.z>` moves from the npm job to step 4; its name is still known before anything publishes, for the pack links. A candidate makes no publication commit: its `v<x.y.z>-rc.N` tag stays on the release commit with relative imports, and nothing builds from its tree but `/next/`.
- **A tag's release commit** is the commit it points at, unless that commit is a publication commit — its message is `chore(release): publish <tag>` and its diff against its first parent touches only import lines under the four roots — in which case it is that first parent. Tags made before this change point at their release commit and still read so. Every script that asks which release a tag names asks it this way: `Record release`'s reachability, newest-tag order and copy; `Start release candidates`' refusal while main does not record the newest tag; the release channel's classification of a run, a re-run and a recovery dispatch; the numbering of `modules-` and `packages-` tags; and the reading of which changesets and fragments a tag released. No pinned import reaches main.
- **The artifact check** runs on the publication commit: `telo check` with an empty cache over the four roots, plus the example, starter and blueprint suites. It gates step 6 only. The tags and the record are already out, because they say what was published: a red check leaves the release tagged and recorded with no installers, images, Studio or site, and a re-run that passes (a flake) or the next patch (a defect) completes it.
- **Failures before the tag.** Steps 1–3 are idempotent: a re-run skips what npm and the registry already hold and makes the same publication commit. A run that cannot complete them leaves an npm version or module versions with no tag; the next release PR — which pending module drift or changesets open by themselves — ships the fix, and its tag records both. `RELEASING.md` gains the recovery entry "published to npm and modules, no tag".
- **Rehearsal.** `pnpm run publication-commit -- --release <commit> --tag <tag> --dry-run` builds the publication commit for a release commit whose modules are published and prints its diff and the tags it would make, pushing nothing. Run against the newest release tag of the live line, it rehearses steps 3–4 with no publish.
- The app image builds check out the tag, and their recovery is a `publish-docker.yml` dispatch at the tag. The production targets of `apps/hub` and `apps/authoring-agent` build only from a release tag, since their build contexts hold no `modules/`; local development uses the development target, which mounts the checkout.

### Studio's gallery follows the telo version

- The gallery loads from `https://raw.githubusercontent.com/telorun/telo/v<X.Y.Z>/starters`, where `X.Y.Z` is the version the workspace's telo version control resolves (its pin, or Auto's choice), on the desktop and web builds alike. A prerelease or unreleased version starts from the newest final in the engine catalog.
- When that tag holds no `starters/starters.json`, the gallery tries the next older final in the engine catalog, and so on; when none holds one it says that no gallery is published for that version. The gallery names the telo version it shows, and reloads when the version changes.
- Precedence: the `startersBaseUrl` setting, then the build's `VITE_TELO_STARTERS_URL` (development builds only), then the per-version tag. The release workflows stop setting `VITE_TELO_STARTERS_URL`.
- A `modules-*` or `packages-*` release reaches the gallery with the next `v` tag.

### Local gallery

- `pnpm run starters` copies the checkout's starters into a gitignored scratch directory, rewrites the copy with `telo release imports --as=published`, accepting its exit 1, and serves it. A starter importing a module with unreleased changes keeps that import relative, and Studio refuses it as it does today, naming the file. The local docker compose stack's `starters` service serves the same copy.

### Transition

- This lands on main. `release/0.133` keeps its own pipeline; the first line on the new flow is the next cut. Records of `0.133` tags made after this lands do not repin main, and read each `0.133` tag as its own release commit.

### Documentation

- `RELEASING.md` (both commit roles, the run order, the failure and recovery entries, the rehearsal), the releasing-modules guide, the CLI guide and README, the CLI package guide, the release model guide, Studio's package guide, the starters README, the authoring agent's guide on mixed origins, and the root guide's note that examples and starters import published modules.
- Changesets for `@telorun/cli` and `@telorun/studio`.

## Verify

- On main after the conversion, `telo release check` reports no destination errors. `telo publish --dry-run -o json` of `blueprints/agent-app` and of `apps/authoring-agent` writes imports of `oci://ghcr.io/telorun/<module>@<version>#<pin>`, each pin equal to the hash of the manifest publishing that module reports.
- Fixture-workspace CLI tests: a module importing a workspace module under another base and depth publishes with the target's assigned ref; a relative import of a manifest the workspace does not release fails `IMPORT_TARGET_NOT_RELEASED` at `telo release check`; a positional destination that disagrees with the marker fails `destination_mismatch`; a sibling republished with different bytes under the same version fails `import_pin_mismatch`; with no marker a relative sibling canonicalizes by path and fails `sibling_not_published` when absent.
- No path under `apps/plan-approval` exists; `pnpm install --frozen-lockfile`, `pnpm run check:licenses` and the static checks pass; nothing outside `plans/` and changelogs names `plan-approval`.
- On main after the conversion, `pnpm run imports -- --as=relative --check` exits 0, tests and fixtures included; a pinned import of `modules/ui` reintroduced in a starter, or a pinned self-import in a blueprint's `example/`, fails the static checks, naming it. The same holds on a release branch.
- A permanent CLI test: in a fixture workspace, `telo changed` over a starter that imports a module relatively lists the starter when only the module's files change.
- Replaying #784 on main — the `placement` schema change in `ui-react` with the `todo` starter untouched — fails `Check starter and blueprint manifests` on that PR.
- `--as=published` then `--as=relative` on a consumer written in the canonical form gives back its bytes; `--check` exits 1 on a hand-edited pin hash and 0 on the command's own output.
- At a release tag, the pin of every import of `http-server` (a module with `sources:`) and of every module importing it equals the `integrity` that `telo publish -o json` reported for that module's push in the same run.
- After a final, the `v<x.y.z>` commit's message is `chore(release): publish v<x.y.z>`, its first parent is on `release/<x.y>`, its diff against that parent touches only import lines in the four roots, and `pnpm run imports -- --as=published --check` exits 0 on it. Re-running the Publish run makes the same publication commit and no new tag.
- Script vectors, each over a tag on a publication commit and over a tag made before this change: `Record release` records the right release and brings no `oci://` import of a workspace module onto main; `Start release candidates` accepts main once it records the tag; a Publish re-run and a recovery dispatch at the branch classify as the first run did; the next `modules-` tag takes the next number.
- The release PR's dry-run gate fails on any import error and on any import left relative because the release plan still bumps its module (drift the release PR leaves); an import left relative only because its version awaits this release's publish passes.
- `pnpm run publication-commit -- --release <commit> --tag <tag> --dry-run` against the newest release commit of the first line cut after this change prints a diff touching only import lines and pushes nothing, and prints the same commit sha when run twice. (`0.133` cannot be rehearsed: its ledger was written by an older CLI, so its plan reports every import as bumped.)
- An artifact check made red on purpose leaves the tag and the record PR in place, and no image, Studio build or GitHub Release asset for the release.
- That release's `hub` and `authoring-agent` images boot on the module versions it published.
- A fix touching a starter's import is cherry-picked from main onto a line cut after this change without conflict.
- Studio with telo `0.133.0` selected loads the gallery from `v0.133.0`; selecting a version whose tag has no `starters/starters.json` loads the next older final that has one; a `startersBaseUrl` setting overrides both; an rc version starts from the newest final.
- `pnpm run starters` serves a gallery from which Studio opens every starter whose modules are published.
