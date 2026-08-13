# Plan — one schema-error renderer, with union reduction

## Problem

Schema validation failures are rendered three different ways, and none of them handles unions.

- `analyzer/nodejs/src/schema-compat.ts` (`formatSingleError`) turns `additionalProperties`, `required`, `enum` and `type` into readable prose.
- `kernel/nodejs/src/manifest-schemas.ts` exports a function of the same name that joins raw `instancePath` + `message`, with none of that handling.
- `kernel/nodejs/src/observed-state.ts` maps its own third variant inline.

So the same failure reads one way under `telo check` and a worse way at runtime, which is a defect on its own: a developer who fixes what the analyzer told them then meets a different sentence describing the same thing.

Neither renderer does anything about `anyOf` / `oneOf`. Both join the entire AJV error array, so a failing union emits *every* branch's errors concatenated, with nothing indicating which branch was meant. This is already live — `Fs.FileWrite`'s `content` is an `anyOf` of a string and an `x-telo-binary` branch, and a bad value there reports both branches' complaints — and it is about to become the primary authoring surface, since `modules/pdfmake` discriminates document nodes by which key is present.

This runs against a stated core goal: error messages must be actionable and point at the place in the manifest that needs fixing.

## Solution

One shared renderer, browser-safe in the analyzer and re-imported by the kernel — the split already used for `buildEvalPaths` and the redaction path parser. Two parts.

**The prose formatter.** The analyzer's keyword handling becomes the single implementation. The kernel's copy and the observed-state variant are deleted and call it instead, so static and runtime phrase a failure identically.

**Union reduction.** When an `anyOf` / `oneOf` fails, select the branch the author plainly intended and report only its errors: prefer branches whose discriminating `required` properties are present in the value, then among those the branch with the fewest errors at the deepest matched path. When no branch is a plausible match, say so and list the alternatives by their discriminating keys, rather than concatenating every branch's complaints.

This is not fixable inside AJV, and the plan should not pretend otherwise. A union must attempt every branch, and the validator genuinely cannot know which one was intended; AJV's `discriminator: true` works only against an explicit OpenAPI-style discriminator property, which would mean changing every module's authoring surface. Branch selection is a rendering concern and belongs in the renderer.

The renderer serves every site where AJV errors reach a human: `telo check`, resource configuration validation, the invocation contract's `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`, and observed state. Regression coverage asserts the *same wording* from the analyzer and the kernel for one shared fixture, since agreement is the property being bought. Changesets for `@telorun/analyzer` and `@telorun/kernel`.

## Decisions

- **Fix the rendering layer, not the schemas.** Adding discriminator properties to every union across the standard library would change what authors write in order to work around a message-quality problem — and for `modules/pdfmake` specifically it would break verbatim copy-paste of pdfmake examples, which is that module's reason for mirroring pdfmake's shape at all.
- **One renderer shared across both halves, not two kept in step.** The divergence is the bug being fixed; two copies re-diverge, as these already have.
- **Heuristic branch selection with an honest fallback.** The heuristic will sometimes pick wrong, so it never claims certainty: when no branch is plausible it reports the alternatives instead of guessing. A confident wrong message is worse than the concatenation it replaces.
- **`anyOf` stays the recommended form for byte unions.** CLAUDE.md's graceful-degradation rule requires it — a consumer that does not know `x-telo-binary` reads that branch as matching everything, which fails under `oneOf`. This plan must improve `anyOf` diagnostics, never nudge authors toward `oneOf` to get them.
- **Rejected: reporting all branches with better formatting.** The problem is not the layout of the soup, it is that the reader has to work out which branch applies — which the selection rule can usually do for them.
