---
"@telorun/kernel": minor
"@telorun/cli": patch
---

Key the npm controller install root per runner, so two runners over one workspace no longer corrupt each other's tree.

The root's `package.json` records `@telorun/sdk` as a `file:` dependency pointing at the running CLI's own copy, and npm rewrites that relative to the root — in `package.json`, in `package-lock.json`, and as the target of the symlink it materializes. Since the cache moved to the workspace root, a second runner read paths true only for the first: a host and a container bind-mounting the same checkout alternately broke each other's installs with `EMISSINGTARGET`, taking down every resource behind an npm-delivered controller.

Roots now live at `.telo/npm/<hash>/`, keyed by that relative path plus the host `os`/`arch`/`libc` — the string npm will write, so a root is shared exactly when everything recorded in it means the same thing on both sides. A different CLI installation, a workspace mounted at another depth, or another architecture or libc each get their own tree; a workspace copied to another directory at the same depth (`WORKDIR /build` … `COPY --from=build /build /srv`) keeps one, so an image still finds the tree `telo install` warmed for it. The key names the runner rather than the app, so every manifest in a workspace shares one root as before. Each root carries a `.telo-install-root.json` marker naming the key's inputs.

Existing roots are not migrated: the first run after upgrading installs into a fresh directory, and the old flat `.telo/npm/` contents can be deleted.
