---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": patch
"@telorun/templating": patch
"@telorun/ai": patch
"@telorun/ai-openai": patch
"@telorun/assert": patch
"@telorun/benchmark": patch
"@telorun/codec": patch
"@telorun/config": patch
"@telorun/console": patch
"@telorun/http-client": patch
"@telorun/http-dispatch": patch
"@telorun/http-server": patch
"@telorun/javascript": patch
"@telorun/lambda": patch
"@telorun/mcp-server": patch
"@telorun/ndjson-codec": patch
"@telorun/octet-codec": patch
"@telorun/plain-text-codec": patch
"@telorun/record-stream": patch
"@telorun/run": patch
"@telorun/s3": patch
"@telorun/sql": patch
"@telorun/sse-codec": patch
"@telorun/starlark": patch
"@telorun/test": patch
"@telorun/type": patch
"@telorun/workflow-temporal": patch
"@telorun/yaml": patch
---

Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

The new shape:
- Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
- The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
- `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
- The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.
