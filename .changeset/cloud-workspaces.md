---
"@telorun/studio": minor
"@telorun/cli": minor
"@telorun/kernel": minor
---

Studio opens Telo Cloud workspaces: optional sign-in on the web and desktop builds, a local working copy of the workspace's git repository, commit, update with a per-file conflict choice, and publishing a module to the workspace's registry. The web build is also released as the container image `ghcr.io/telorun/studio-web`, with the Helm chart `oci://ghcr.io/telorun/charts/studio-web` to deploy it.

`telo publish -o json` reports one entry per manifest under `modules`: a stable failure `code` with its `details`, or the `version`, `digest` and `integrity` of what was pushed and whether it was `identical` to what is already published. Every unpublished sibling import is now reported, not only the first. A transport's publish result carries the pushed artifact's `digest`.

The `requires.telo` edge check now starts `npx` outside the module's directory, so a `.npmrc` beside the manifest no longer decides which registry `@telorun/cli` is installed from.
