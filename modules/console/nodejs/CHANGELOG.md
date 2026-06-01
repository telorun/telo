# @telorun/console

## 0.8.0

### Minor Changes

- 55b4ec5: Add exported resource instances: a `Telo.Library` can declare a resource and export it as a ready-made singleton via `exports.resources`, and consumers reference it across the import boundary with `!ref Alias.name` (and read value-flow exports in CEL as `${{ resources.Alias.name }}`). `std/console` now exports `writeLine` / `readLine` singletons, so a consumer can `!ref Console.writeLine` instead of declaring its own `Console.WriteLine` instance.

  Reference grammar: every `!ref` is `<Alias>.<name>`, split on the first dot — a bare name (or `Self.`-qualified) resolves locally; a non-`Self` alias resolves into that import's `exports.resources`. A resource name may no longer contain a dot (new `INVALID_RESOURCE_NAME` diagnostic), since the dot separates alias from name.

  `Self` now resolves a library's own kinds **ungated** (no longer bound to `exports.kinds`) — `exports` gates importers, not internal use — and the kernel registers `Self` in each import's child context, so a library can declare an instance of a kind it doesn't export (`kind: Self.WriteLine`).

  `std/assert` likewise exports its config-free assertions (`equals`, `matches`, `contains`) as singletons, so a test can `!ref Assert.equals` — including inside a `Run.Sequence` step — instead of declaring an `Assert.Equals` instance.

  Mechanics: the analyzer forwards a library's exported instances across the import boundary (gate = what's forwarded), and the kernel injects/boots them from the import's child context. Cross-module refs resolve on every consumption surface — Phase 5 injection (threads the alias; an unresolved ref defers to a later init pass), flat boot targets, `Run.Sequence` step invokes (via `resolveChildren` + `executeInvokeStep`), and CEL `${{ resources.Alias.name }}`. Lifecycle is unchanged — an exported instance is the import child context's existing singleton.

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.7.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.6.0

### Major Changes

- 0eba4d4: **Breaking:** `Console.WriteLine` and `Console.ReadLine` are now `Telo.Invocable` and accept their per-call data via `inputs:` instead of as resource-level configuration.

  - `Console.WriteLine`'s `output` field moves from the resource `schema` into the kind's `inputType`. Pass it under the step's `inputs:` block.
  - `Console.ReadLine`'s `prompt` field moves the same way.
  - Both capabilities switch from `Telo.Runnable` to `Telo.Invocable`.

  CEL expressions in `output` / `prompt` now resolve naturally against the caller's scope (`steps.*`, `resources.*`, `variables.*`, `secrets.*`) — the previous controller-internal `expandValue(manifest.output, input)` trick is gone.

  Migrate call sites from:

  ```yaml
  - name: Greet
    invoke:
      kind: Console.WriteLine
      output: "Hello, ${{ steps.Ask.result.value }}!"
  ```

  to:

  ```yaml
  - name: Greet
    invoke: { kind: Console.WriteLine }
    inputs:
      output: "Hello, ${{ steps.Ask.result.value }}!"
  ```

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.5.1

### Patch Changes

- c1e26b8: Re-release of the `Console.WriteLine` / `Console.ReadLine` `Telo.Invocable` refactor (previously shipped as a major bump) under a minor bump after the prior version was rolled back due to a bug.

## 0.4.2

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.4.1

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.4.0

### Minor Changes

- f74bfa2: Three console-package changes bundled into one release.

  **New: `Console.StreamWait`** — stream passthrough that animates a single-cell frame sequence on stdout while waiting for the first item from the input stream, then clears the cell and forwards every item unchanged. Frames, prefix, and clear sequence are interleaved into the output stream — the controller never writes to stdout directly, so the downstream sink (typically `Console.WriteStream`) is the only stdout writer. Useful for "loading" indicators in CLI flows where the next step is a stream with measurable startup latency (HTTP requests, AI completions, file reads). Configurable `prefix`, `frames` (default braille spinner cycle), and `intervalMs` (default 80 ms; minimum 16). First frame paints synchronously to avoid an `intervalMs` blank gap.

  **New: console markup language** — every text path (`Console.WriteLine.output`, `Console.WriteStream` string chunks, `Console.ReadLine.prompt`, `Console.StreamWait.prefix`) interprets a small chalk-template-style markup at write time. Syntax: `{red text}`, `{red.bold ERROR}`, `{red.bgWhite warning}`, `{#ff8800 hex}`, `{red {bold WORLD}!}` (nested), `\{ \}` for literal braces. Renders to ANSI SGR codes when the underlying stdout is a TTY; strips to plain text otherwise. Detection is per-invocation via `ctx.stdout.isTTY`. Unknown styles fall back to literal text — no crash. **Migration note**: any existing manifest with literal `{…}` characters in console output now needs to escape them as `\{ \}` to preserve previous rendering. Unlikely in practice.

  **Behaviour change: `Console.ReadLine.prompt`** no longer auto-appends `": "` after the prompt text. The `prompt` field is now written to stdout character-for-character. Manifests that relied on `prompt: "Foo"` rendering as `Foo: ` must update to `prompt: "Foo: "`. In-tree consumers migrated: `examples/console-user-input.yaml` (Username/Password prompts) and `examples/chat-console.yaml` (ChatLoop reads).

## 0.3.0

### Minor Changes

- 795c117: Add `Console.WriteStream` — drains a `Stream<string | Uint8Array>` to stdout. Strings use Node's native UTF-8 path; `Uint8Array` chunks pass through unchanged. No newline policy. Pairs with text producers like `RecordStream.ExtractText` and byte-producing codecs (`Ndjson.Encoder`, `Sse.Encoder`, `Octet.Encoder`) on the same input contract.

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.1.11

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.1.10

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.9

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.8

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.7

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.6

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
