---
"@telorun/kernel": patch
---

**The npm install root provisions the realm packages without running their lifecycle scripts.** That install exists to put the kernel's own already-built packages on disk as `file:` references, so an npm-delivered controller resolves one copy of each and class identity holds across the boundary. None of them has anything to build there — but npm ran their scripts from wherever the kernel happens to live, and `@telorun/cel` has a `prepare` that generates its version constant from a repo-relative `../../scripts/`. Resolved against a pnpm virtual-store directory inside an installed kernel that path does not exist, so the script failed and took the whole install with it: every npm-delivered controller (`image`, `starlark`, `embedding`) became unloadable in a packaged image while working from a checkout, where the path happens to exist. The failure arrived with `@telorun/cel` joining the realm set — before it, the one realm package had no `prepare`.

The per-controller install keeps its scripts, because a module's own `postinstall` is how it fetches what it needs.

**And `@telorun/cel`'s own `prepare` no longer fails outside a checkout.** `--ignore-scripts` on the realm install was not enough: the per-controller install re-resolves the same tree and keeps its scripts, because a module's own `postinstall` is how it fetches what it needs — so the script ran there instead and failed the same way. It generates the engine's version constant from `../../scripts/`, which only exists in a checkout; it now runs when that path is there and is a no-op when it is not, which is right for an installed copy that already ships the generated file. A failure of the generator itself still fails the install.
