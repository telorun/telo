# Authoring-agent stale refs & CLI output format

## Problem

The deployed authoring agent emitted an import against the deprecated registry
(`std/http-dispatch@0.8.0#sha256-…`), which failed to resolve, and its output
carried raw ANSI escapes into a non-TTY. Both trace to one cause: the published
image was 22 days old, and `apps/authoring-agent/Dockerfile` bakes *both* the
system prompt (`COPY .`) and the CLI (`FROM telorun/node:${TELO_NODE_VERSION}`).
The stale image carried the pre-hub prompt and a CLI predating the spec-compliant
colour precedence in `cli/nodejs/src/logger.ts`.

The image is stale because nothing forces it to rebuild.
`apps/authoring-agent` is already a changie project, but
`scripts/check-changie-fragments.mjs` matches only `^modules/<name>/…`, so an
`apps/**` change needs no fragment, `metadata.version` never moves, and the
`authoring-agent` job in `.github/workflows/publish-docker.yml` — which publishes
only when that version moves — never fires. `apps/hub` is unaffected because it
publishes `:latest` + `:sha-*` on every push and gates only its immutable tag on
the bump.

The ref itself was **valid and correctly pinned** — real module, real version,
real digest. Two things went wrong, and only the first survives on `main`:

- The prompt still teaches the deprecated form —
  `apps/authoring-agent/chat/telo.yaml` named the standard library as living
  "under the `std` namespace" and listed a dozen modules there.
- The old CLI did not split the `#sha256-…` fragment before building the fetch
  URL, so it requested `…/0.8.0` (which returns JSON version metadata) instead of
  `…/0.8.0/telo.yaml`, and the JSON parsed into a document with no `kind` —
  reported as "no recognizable Telo documents". `RegistrySource.read` splits the
  fragment correctly on current `main`, and that exact ref now checks clean.

Separately, the agent parses `telo check`'s prose output for diagnostics. It has
no machine contract, and the CLI decides colour from `process.stdout.isTTY` while
`formatDiagnostics` writes to stderr.

## Solution

**Prompt.** Remove the `std` namespace paragraph from
`apps/authoring-agent/chat/telo.yaml`; make `oci://` and relative paths the only
writable import sources, with the bare `namespace/name@VERSION` form named as
deprecated. Refs are written verbatim as the hub tools return them, integrity pin
included when there is one.

**CLI output.** Add a global `-o, --output text|json` (default `text`) in
`cli/nodejs/src/cli.ts`, and route every CLI-owned write through one seam
(`cli/nodejs/src/output.ts`) — roughly 115 direct `console.*` calls across the
nine command files, with a test enforcing that no bypass returns. stdout is the
machine surface and carries only the payload under `json`; stderr stays the human
surface in both formats, so no failure reason is swallowed. `telo check`'s
payload is the analyzer diagnostic array (`code`, `severity`, location,
`message`), which is what removes the agent's prose parsing, and the agent's
check loop is switched to `-o json` in the same change. Colour is decided
per-stream rather than from stdout alone.

**Release.** Extend `scripts/check-changie-fragments.mjs` to `apps/` on the same
rule it applies to modules, and give every app image `hub`'s publish policy in
`publish-docker.yml`: `:latest` + `:sha-*` on every push, immutable `:<version>`
still gated on the version bump.

## Decisions

- **No analyzer change.** The plan originally added an HTTP-status detail to the
  import-resolution failure in `manifest-loader.ts`. Dropped: `verifiedFetch`
  already reports non-2xx status, and the observed failure was the unsplit URL
  fragment, fixed on `main`. Nothing here needs changing.
- **The agent keeps writing integrity pins.** An earlier decision forbade it, on
  a misreading of the failure as a fabricated digest. The digest was correct;
  the pin is what gives tamper detection, and an unpinned import is strictly
  weaker. Refs are copied verbatim from the tools instead.
- **No `telo add` verb.** Considered a CLI verb that resolves and pins a
  dependency so the ref is machine-produced rather than composed by the model.
  Rejected as unnecessary: the hub tools already return a complete ref, so the
  prompt only has to say "copy it verbatim".
- **No static diagnostic for the deprecated ref form.** Considered a warning on a
  bare `namespace/name@version` source. Rejected: with the prompt fixed the agent
  has no reason to write one, and `plans/remove-telo-registry.md` deliberately
  keeps those refs resolving, so the warning would fire on working apps whose
  authors have nothing to fix.
- **`-o` rather than `--format`,** matching kubectl, so `yaml` is a future value
  in the enum rather than a second flag. `yaml` is not implemented now.
- **`telo run` is exempt from `-o json` entirely**, rather than writing its
  envelope to one stream. The kernel runs in-process and `teeStdio` copies rather
  than redirects, so the app writes to both descriptors and neither is the CLI's
  to claim — an envelope after arbitrary app output is unparseable on either.
  `--debug` is already the machine surface for a run, framed per event precisely
  because it shares a stream.
- **stderr keeps its prose under `-o json`.** Rejected: suppressing it, which
  swallowed every failure reason a command had not separately collected into its
  payload. One rule beats a re-collection obligation on each new command, and it
  matches npm, cargo and kubectl.
- **A document command never emits an error envelope.** Its stdout is the
  document or empty: a CEL expression evaluating to `{"ok":false,…}` would
  otherwise be indistinguishable from a failure report.
- **`--json` on `cel eval` and `module manifest` become aliases, not reshapes.**
  `module manifest --json` is a live contract the hub's tracker reads.
- **No command may silently ignore `-o json`.** A machine consumer cannot
  distinguish "nothing to report" from "unsupported", so every command emits at
  least an envelope. A partially-honoured global flag is worse than none.
- **Both image fixes, not either.** The fragment gate depends on someone
  remembering; every-push `:latest` makes staleness structurally impossible.
  They cover different failure modes.
- **One plan, not two.** The prompt and CLI halves share the stale-image root
  cause; splitting them would lose that.

## After the change

The agent searches the hub and writes an `imports:` entry pairing a PascalCase
alias with the ref exactly as the tool returned it — `oci://ghcr.io/telorun/…`
at an exact version, pin included when present, never the bare `std/…` form.
Its check loop runs `telo check -o json` and reads diagnostics by `code` and
location instead of parsing prose, with stdout and stderr surfaced as separate
tool-result fields so the document stays parseable. A human running `telo check`
sees the identical coloured text output as today. Editing the prompt now requires
a changie fragment, and merging it rebuilds and republishes
`telorun/authoring-agent:latest-slim` on that push — with `:sha-<short>-slim`
published every push regardless, so staleness cannot recur even if a fragment is
forgotten.
