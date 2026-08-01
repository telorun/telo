---
"@telorun/kernel": patch
---

The npm install root no longer evicts every controller when the kernel's realm changes.

`materializeInstallRoot` wrote the root's `package.json` from scratch, containing only the realm-collapse deps (`@telorun/sdk` as a `file:` ref). Every controller alias a previous `installPackage --save` had recorded was dropped from that file, so the `npm install` that followed pruned their `node_modules` folders — and each controller then reinstalled itself, one `--save` at a time.

That install runs whenever the recorded root identity does not match, and the identity is a hash of the realm deps — which include the SDK's absolute path. Two kernels addressing the same app legitimately resolve `@telorun/sdk` to different paths: a globally installed `@telorun/cli` and a repo checkout. Alternating between them flipped the hash on every run, so every run reinstalled every controller and the cache never appeared to take effect.

The rewrite now merges: existing dependencies are preserved and the realm deps written over them, so the install relinks the SDK and leaves the controllers alone. The recorded identity still hashes the realm deps only — hashing the aliases too would make each controller install invalidate the root and trigger another root install.

Preserved entries are pruned first: a `file:` spec whose target no longer exists (the app was run from a checkout that has since moved, or its `.telo/` was copied without it) and an alias with no folder in `node_modules` are both dropped. Dropping them is free — `installPackage` reinstalls a controller the moment something asks for it — and carrying them is not: the package manager resolves every recorded entry, so under pnpm one dead `file:` record fails the whole root install with an error that names nothing in the manifest, and the state file is written only after a successful install, so every later run would repeat it. The prune is also what stops aliases accumulating now that the rewrite preserves them: a controller version an app has moved off drops out at the next root install.
