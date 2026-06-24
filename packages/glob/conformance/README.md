# Telo glob — matching spec

The single, language-neutral contract for resolving a `.gitignore`-style pattern
set against a list of relative POSIX file paths. Every Telo runtime (Node today;
Rust / Go later) MUST implement this spec exactly. `glob.json` is the executable
conformance suite — load it, run each case through your `selectByPatterns`
equivalent, and assert the output equals `selected`. If your implementation
disagrees with a single case, it is wrong, not the fixture.

This is deliberately a **subset** of gitignore, chosen so it can be reimplemented
identically in any language without inheriting one library's quirks. Where this
spec and a given gitignore library disagree, this spec wins.

## Inputs

`selectByPatterns(paths, patterns, options)`:

- `paths` — relative, POSIX-separated (`/`), no leading `/`. The matcher never
  walks a filesystem; the caller owns the walk and passes the candidate paths.
- `patterns` — ordered `.gitignore`-style list. Empty list selects nothing.
- `options.applyDefaultIgnore` — default `true`. When `false`, the **soft** deny
  tier is skipped. The **hard** deny tier is always applied (see below).
- `options.exclude` — extra patterns carved out after selection, same grammar.

Output: the subset of `paths` that is selected, **sorted** ascending by code unit.

## Grammar

A pattern is matched against a whole path. Tokens:

| token | meaning |
| --- | --- |
| `*` | any run of characters except `/` |
| `?` | exactly one character except `/` |
| `**/` | zero or more leading path segments (i.e. "any depth") |
| `/**` (trailing) or bare `**` | any characters, including `/` |
| `!` (prefix) | negate this pattern (carve out) |

All other characters match literally (regex metacharacters are escaped).
Wildcards **do** match a leading `.` — dotfiles are not special. Hiding caches
like `.telo/` is the deny tier's job, never the wildcard's.

### Normalization

Before compiling a pattern: convert `\` → `/`, strip a leading `./`, strip a
leading `!` (recording negation), strip a single leading `/` (recording a root
anchor).

### Anchoring

- A pattern whose body contains a `/` anywhere **other than a sole trailing
  slash** — or that began with a leading `/` — is **anchored**: it matches from
  the root of the path (`public/**` matches `public/a`, not `x/public/a`).
- A pattern with no internal slash is **floating**: it matches at any depth, as
  if `**/` were prepended (`*.js` ≡ `**/*.js`; `routes.yaml` matches
  `sub/routes.yaml` but not `sub/myroutes.yaml` — segment boundaries are
  respected).

### Trailing slash

`foo/` selects the **contents** of directory `foo` — it is rewritten to `foo/**`
after the anchoring decision (so `node_modules/` stays floating and matches a
`node_modules` dir at any depth, while `src/lib/` stays anchored).

### Negation & ordering

Patterns are evaluated in order; the **last** pattern that matches a path decides
it (positive → selected, negated → not). There is **no** "cannot re-include under
an excluded directory" rule — unlike git, `!public/keep.js` after `public/**` /
`!public/**` re-includes `public/keep.js`. This is a deliberate simplification:
pure last-match-wins is trivial to port and has no hidden state.

## Deny tiers

Applied after selection, both as ordered pattern lists in this same grammar:

- **Hard** (`HARD_IGNORE`: `node_modules/`, `.git/`, `.telo/`) — always
  subtracted, even when `applyDefaultIgnore` is `false`. No pattern can opt these
  back in. They exist so `include:` resolution (which sets
  `applyDefaultIgnore: false` to reach co-located partials) can never pull in the
  manifest cache, the VCS dir, or vendored deps.
- **Soft** (`DEFAULT_IGNORE`: `.telobundle.*`) — subtracted by default,
  skipped when `applyDefaultIgnore` is `false`.

`GLOB_PRUNE_DIRS` (`node_modules`, `.git`, `.telo`) mirrors the hard tier's
directories: a walking caller MAY prune them mid-descent for performance, which
changes no result because the hard tier denies them regardless.

## Reference fixtures

See [`glob.json`](./glob.json). Each case is
`{ name, patterns, paths, options?, selected }`. The Node implementation
(`@telorun/glob`) is verified against it in
`packages/glob/nodejs/tests/glob-conformance.test.ts`.
