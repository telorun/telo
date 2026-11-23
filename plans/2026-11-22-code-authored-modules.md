---
status: draft
priority: medium
depends-on: []
packages: [analyzer, kernel, cli, sdk, module-builder, packages/module-synthesis, packages/editor-protocol, packages/language-server, packages/language-host, ide/vscode, apps/studio, packages/runner-protocol, packages/runner-core, apps/docker-runner, apps/k8s-runner, apps/host-runner, apps/authoring-agent, apps/hub, docs]
refinement: not-started
---

# Code-authored modules

## Problem

Every Telo module today is a `telo.yaml`. An author who wants to use Telo as a programming framework — declare kinds, resources and exports from ordinary code, handle inputs in code, and use YAML only where they choose — has no way to do it. The kernel's in-memory manifest source accepts document objects, but only for embedders: it serializes them back to YAML (losing `!cel` / `!ref` tags), every diagnostic then points at generated text nobody wrote, nothing can import such a module by path, and nothing publishes it.

What a working solution must not lose is what YAML gives today: `telo check` judges the module statically, the hub indexes it, an import pin hashes its `telo.yaml`, Studio can show it, and both kernels can load it.

## Constraints

- I need the whole module from gound up to be written in nodejs, so no manifest for that module.
- all languages that we support: node and rust, but Telo must still be open for other languages so no blockers here
- no partials in scope, module is a whole, either code or manifest, not both
- code modules follow same rules that they read variables not process.env directly
- ts files should be handled normally via vscode via typescript extension not telo, studio should show code modules readonly
- whole module must be able to be created via a single TS file or multiple files.
- whole module must not look like imperative builder for a YAML manifest.

## Surface

**Added**

- `telo.ts`, `telo.mts`, `telo.js`, `telo.mjs` — a module entry at the module root, run by the `node` runner
- `telo.rs` — a module entry at the module root, the crate's library root (`[lib] path = "telo.rs"`), run by the `rust` runner
- `telo.locations.json` — the program's optional location table (`format: 1`), written beside the synthesized `telo.yaml` in the program's output directory
- `imports/<Alias>.ts` / `imports/<alias>.rs` + `imports/mod.rs` — committed typed binding of one import, recording its source, pin and the exports its types were generated from
- `<cache root>/synthesis/<key>/` — cached synthesized output
- `telo synth <path> [--format json]` — prints a code module's synthesized `telo.yaml`; `--format json` prints `{ text, locations, inputs }` (both CLIs)
- `telo add <source> [--as <Alias>]` — adds an import to any module: an `imports:` entry in YAML, a binding file in a code module
- `@telorun/module-builder` / `telorun-module-builder` — the authoring builders and binding generators (MIT, on the telo version line, one unit `module-builder`)
- `@telorun/module-synthesis` (subpath `/node`) / `telorun-module-synthesis-core` + `telorun-module-synthesis` — the run contract, the runners and the location table (MIT, off the line)
- `packages/module-synthesis/runners/<runner>.json` — the runner table (runner name, entry names)
- `MODULE_ENTRY_AMBIGUOUS` / `ERR_MODULE_ENTRY_AMBIGUOUS` — a directory holding more than one module entry
- `MODULE_PROGRAM_UNSUPPORTED` / `ERR_MODULE_PROGRAM_UNSUPPORTED` — this host has no runner for the entry
- `MODULE_PROGRAM_FAILED` / `ERR_MODULE_PROGRAM_FAILED` — the program's build or run failed (bounded stderr)
- `MODULE_PROGRAM_OUTPUT_INVALID` / `ERR_MODULE_PROGRAM_OUTPUT_INVALID` — the output breaks the run contract
- `MODULE_PROGRAM_NONDETERMINISTIC` / `ERR_MODULE_PROGRAM_NONDETERMINISTIC` — two runs at publish, package or release planning differ
- `CONTROLLER_NOT_EXPORTED` / `ERR_CONTROLLER_NOT_EXPORTED` — a kind names a controller that is not a named export of the module entry
- `telo/read` response members `program: { locations }` and `refusal: { code, message }`
- `GET /v1/sessions/:id/workspace/synthesis?path=` — `200 { path, text, locations, inputs }` or `200 { path, refusal }`; `404 module_not_found` (new error code)
- `features.synthesis` — runner capability advertising the route

**Changed**

- `teloEditorProtocol` — bumped; a host serves code modules only to an engine of the new generation
- `telo upgrade` — in a code module moves the pin in each binding file and regenerates its types
- `telo install`, `telo check`, `telo run` (incl. `--watch`), `telo publish`, `telo package`, `telo describe`, `telo needs report`, `telo env template`, `App.Instance` `source:` — accept a code module wherever a module directory is accepted

**Removed**

None.

## Solution

**A code module is a directory whose entry is a library the runner imports.** The entry is `telo.<ext>` at the module root and its extension picks the runner (the Gradle `build.gradle` / `build.gradle.kts` pattern). The entry's URL is the module's canonical source, so the module root, relative imports, `!module-path` and `!include-*` resolve exactly as for `telo.yaml`. A directory holding two entries is refused. The set of runners is a data table both host halves read; adding a language adds a row and its runner, and changes no kernel, analyzer, CLI or editor code.

**Synthesis, not execution.** A host runs the program to produce the module's documents — the CDK / cdk8s pattern — and every consumer reads those documents. The entry exports the module as a value (the default export in Node, registered by the builder's module macro in Rust) and importing it does nothing; the runner's own driver imports the entry and writes, into an empty output directory, `telo.yaml` in Telo's own grammar (tags included) and optionally `telo.locations.json`, keyed by document index and JSON Pointer, mapping each node to a file and range of the program's source. Both analyzers read the text as they read any `telo.yaml`; the location table rides the source's read result, so a finding is placed by lookup. At `telo publish` / `telo package` the synthesized text is the artifact's `telo.yaml`, with the measured `requires:` floor written beside `layers:` (a program never writes `requires:` or `include:`); consumers, pins and the hub see an ordinary module. The run contract is normative in `packages/module-synthesis/README.md`, with vectors in `packages/module-synthesis/conformance/` that both halves of the package and both analyzers run.

**The run contract is hermetic.** The driver runs with an environment carrying nothing of the host's, stdin closed, no arguments, its working directory the empty output directory. Everything the entry uses arrives at build time (bundled imports in Node, `include_str!` in Rust). The Node runner bundles its driver and the entry with esbuild — the controller bundle's conditions and loaders, so synthesis imports the code the controller realm runs — and runs it on Node under the permission model (read its bundle, write the output directory, no child processes, workers or addons). The Rust runner generates a driver crate in the cache, seeded with the module's `Cargo.lock` and depending on the module crate by path, builds it with cargo and executes it directly, refusing a build whose dep-info records an environment dependency other than Cargo's own. Importing the entry is part of the run, so a controller dependency that loads a native addon or reads files at import fails it with `MODULE_PROGRAM_FAILED`, whose message says the failure came while importing the entry and that such a dependency is loaded inside the controller's `create()`. Variables reach a module only as declared `variables:` read at run time by the kernel, never through the program. `telo publish`, `telo package` and release planning run the program twice and refuse differing output.

**One synthesizer for every host.** `@telorun/module-synthesis` (and its Rust twin) is composed into both kernels' local sources, the CLIs and the VS Code extension host; its browser-safe half (entry table, location table schema, nearest-ancestor resolution) is what the analyzers depend on, and the analyzer never runs a program. Output is cached under `<cache root>/synthesis/<key>/`, keyed by every input the build reported, the build options, the runner and the format, so an unchanged module never runs its program again and an edit to any input is a new key. `--watch` watches the recorded inputs. Both kernels host both runners from the start; a host whose toolchain lacks one refuses with `MODULE_PROGRAM_UNSUPPORTED`.

**One file holds the module and its controllers.** Controllers are exports of the entry — defined there, or re-exported from another file of the module, which is the only way a second file takes part. In Node a kind names its controller by value, and the driver finds its export name by identity among the entry's named exports (the lexicographically first name when two hold the same value); a value that is no named export is `CONTROLLER_NOT_EXPORTED`, reported at the kind's line. The candidate is always `pkg:telo/local/js?path=…&local_path=./telo.ts#<Export>`, and the kernel bundles the entry as written: the module value and the builder ride in the controller bundle, which is sound because the builder has no import-time effect and declares `sideEffects: false`, so loading a controller writes nothing. In Rust `telo.rs` is the crate's library root (built as an `rlib`, so the driver can link it), holding the module and the controllers; a kind names its controller by type, the candidate is `pkg:cargo/<crate>?local_path=.#<entry>`, and the Rust SDK exposes a controller's entry name to the builder.

**Typed bindings make the compiler the author's feedback loop.** Since Telo publishes no diagnostics into `.ts` files, the TypeScript or Rust compiler is what catches a misspelled field. `telo add <source>` resolves and pins the source and writes a committed binding file per alias under `imports/` (generated by the module's own builder version, so the binding matches the builder it compiles against); `telo upgrade` moves the pin and regenerates the types together; `telo install` only warms the cache, as today. A module's own kinds need no generation: TypeScript types are inferred from the schema builders (the TypeBox pattern), Rust schemas derived from the config types (the schemars pattern). Built-in `Telo.*` kinds ship in the builder. CEL is written through `cel(…)` / `interpolate(…)` helpers and is expected only at the edges — a port, a request mapped into a handler's inputs.

**Where findings appear.** `telo check <code module>` prints the same codes and exit status as for YAML, each finding at its program location (`telo.ts:14:3`) with the resource and path kept in the message; a finding no location covers is placed at the entry. In editors the engine publishes nothing at a program-origin file: a consumer's dependency verdict for a code library keeps editable-origin severity and is re-anchored at the consumer's `imports:` entry, with LSP `relatedInformation` linking to the program line. Studio shows a code module read-only, recognised by the read's `program` member.

**Editor and Studio reads.** `telo/read` of a code module directory or entry answers the canonical entry URI, the synthesized text and `program: { locations }`, or `refusal: { code, message }`; the host sends `workspace/didChangeWatchedFiles` for the entry when a recorded input changes, and serves code modules only in a trusted VS Code workspace. Studio's desktop build runs its bundled telo's `telo synth --format json`; its browser build calls the runner's `GET /v1/sessions/:id/workspace/synthesis` when the session's runner advertises `features.synthesis` (the runner runs `telo synth` inside the session's workload) and otherwise shows the module unavailable with `MODULE_PROGRAM_UNSUPPORTED`. Runner images carry the toolchain of every runner they advertise.

**Applications too.** `variables:`, `secrets:`, `ports:` with `env:` / `arg:`, `targets:`, `logging:`, `tracing:`, `translations:`, `needs:` and `lang:` are documents the program emits; `telo run <dir> [arguments]` reads arguments against the synthesized bindings (the program receives none), and runners learn an application's `ports:` from the synthesized documents.

**Everything else follows.** Docs: a code-modules guide under `docs/extend/`, the CLI reference for `telo synth` / `telo add`, the benefits-ledger entry. The authoring-agent primer and the hub's library-design guide learn code modules. `tests/check-run-agreement.yaml` gains a row for every `MODULE_*` refusal except the publish-only one and for `CONTROLLER_NOT_EXPORTED`; both analyzers' check-conformance pin `MODULE_ENTRY_AMBIGUOUS` and `CONTROLLER_NOT_EXPORTED`. The code-modules guide and the primer state that importing the entry performs no I/O and that heavy or native dependencies are loaded in `create()`. `module-builder/` and `packages/module-synthesis/` join the MIT list and `pnpm run check:licenses`; `module-builder` joins `release.groups.telo`. `cli/rust` gains `telo synth`; `telo add` is Node-CLI only, like `telo upgrade`.

## Decisions

- **Synthesis over runtime registration (Pulumi) and over in-process hosting** — static analysis, hub indexing, the import pin and Studio all need documents without running code, and a Node host cannot import a Rust program.
- **Entry by `telo.<ext>`, not a pointer file or a package-manifest key** — a pointer file is a manifest the constraints forbid; Go's `go.mod` has nowhere to put a key; `telo.yaml` already makes the basename the convention.
- **Program emits Telo's YAML grammar, not a JSON encoding of tags** — one grammar both analyzers already read and the published artifact already is; a second spelling of every tag would be twinned forever.
- **Location table keyed by document + JSON Pointer, not a text source map** — the loader's own position key, so mapping is a lookup with no second parser.
- **Determinism enforced by an empty environment and a sandbox; two runs only where output becomes durable** — the environment rule then holds in every language by construction, without doubling every cold load.
- **The entry is a library the runner's driver imports, never a main** (Vite / ESLint config files, `go test`'s generated harness) — so one file can hold the module and its controllers: importing it is effect-free in the controller realm and in the sandbox alike, and one driver contract serves every language. A top-level `synth()` call would make loading a controller write output.
- **Controllers are exports of the entry, named by identity** — a bundled function value carries no export name, and the namespace lookup recovers it; a separate controller entry as a second rule would give one concept two PURL shapes.
- **The builder stays in the controller bundle rather than being tree-shaken out** — correctness would otherwise rest on esbuild proving the builder's calls pure, for a negligible size saving.
- **An import-time native or file read fails synthesis rather than being stubbed** — a stubbed dependency would silently change what the program emits, and widening the sandbox would let reads escape the cache key.
- **Committed bindings under `imports/`, written by a new `telo add`** — the only committed place for a pin in a module with no manifest; gitignored bindings would leave a fresh clone untyped; `telo install` stays a cache-warming command that never writes the author's tree.
- **Findings re-anchored at the consumer's import in editors** — keeps the author's errors as errors without publishing into `.ts`.
- **Browser Studio reads through a runner route, not `workspace/file`** — the cache is outside the workspace, and a flag switching one route between two answer shapes is two routes in one.
- **Builder on the telo line, synthesis package off it** — the builder's bindings and annotations are one generation's surface; the run contract is spoken across generations, like the editor protocol.

## Complete example after the change

A Node library, `quotes/` — the whole module, its kind and its controller in one file:

```
quotes/
  package.json      # @telorun/module-builder, @telorun/sdk
  telo.ts           # the module
```

```ts
// quotes/telo.ts
import { InvokeError, integerInput } from "@telorun/sdk";
import { library, kind, t, Telo, type Static } from "@telorun/module-builder";

const QuoteRequest = t.object({ sku: t.string(), quantity: t.integer({ minimum: 1 }) });
const Quote = t.object({ sku: t.string(), quantity: t.integer(), total: t.number() });
const PriceList = t.object({
  prices: t.record(t.number({ minimum: 0 })),
  bulkThreshold: t.integer({ default: 10 }),
  bulkDiscount: t.number({ minimum: 0, maximum: 1, default: 0 }),
});

// The controller: an export of the entry, so the kernel loads it as telo.ts#PriceQuoteController.
export const PriceQuoteController = {
  async create(config: Static<typeof PriceList>) {
    return {
      async invoke(inputs: Static<typeof QuoteRequest>): Promise<Static<typeof Quote>> {
        const price = config.prices[inputs.sku];
        if (price === undefined) {
          throw new InvokeError("QUOTE_UNKNOWN_SKU", `no price for ${inputs.sku}`, { sku: inputs.sku });
        }
        const quantity = integerInput(inputs.quantity)!;
        const discount = quantity >= integerInput(config.bulkThreshold)! ? config.bulkDiscount : 0;
        return { sku: inputs.sku, quantity, total: price * quantity * (1 - discount) };
      },
    };
  },
};

const priceQuote = kind("PriceQuote", {
  capability: Telo.Invocable,
  description:
    "Prices a quantity of one product from a price list, with a bulk discount above a threshold. " +
    "Returns the line total; a product missing from the list fails with QUOTE_UNKNOWN_SKU.",
  schema: PriceList,
  inputType: QuoteRequest,
  outputType: Quote,
  throws: {
    QUOTE_UNKNOWN_SKU: { data: t.object({ sku: t.string() }), displayMessage: "No price is listed for {$sku}." },
  },
  controller: PriceQuoteController,
});

const standardPricing = priceQuote.resource("standardPricing", {
  prices: { "SKU-1": 12.5, "SKU-2": 40 },
  bulkDiscount: 0.1,
});

// The module: the default export, which the runner's driver reads.
export default library({
  name: "Quotes",
  version: "1.0.0",
  license: "MIT",
  lang: "en",
  description:
    "Price quotes for order lines: a price list per product, bulk discounts above a quantity " +
    "threshold, and a ready-made standard price list.",
  exports: { kinds: [priceQuote], resources: [standardPricing] },
});
```

`telo synth ./quotes` prints what is published as the artifact's `telo.yaml` (trimmed):

```yaml
kind: Telo.Library
metadata: { name: Quotes, version: 1.0.0, license: MIT, description: Price quotes for order lines … }
lang: en
exports: { kinds: [PriceQuote], resources: [standardPricing] }
---
kind: Telo.Definition
metadata: { name: PriceQuote, description: Prices a quantity of one product … }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./telo.mjs&local_path=./telo.ts#PriceQuoteController]
schema: { … }
inputType: { kind: Telo.JsonSchema, schema: { … } }
outputType: { kind: Telo.JsonSchema, schema: { … } }
throws: { codes: { QUOTE_UNKNOWN_SKU: { … } } }
---
kind: Self.PriceQuote
metadata: { name: standardPricing }
prices: { SKU-1: 12.5, SKU-2: 40 }
bulkDiscount: 0.1
```

A Node application importing a YAML library and the code library, `shop/`:

```
shop/
  package.json
  telo.ts
  imports/Http.ts     # telo add oci://ghcr.io/telorun/http-server@0.44.2 --as Http
  imports/Quotes.ts   # telo add ../quotes
```

```ts
// shop/telo.ts
import { application, cel, interpolate, t, Telo } from "@telorun/module-builder";
import { Http } from "./imports/Http.js";
import { Quotes } from "./imports/Quotes.js";

const quotesApi = Http.Api.resource("quotesApi", {
  routes: [
    {
      request: {
        path: "/quotes",
        method: "POST",
        schema: { body: t.object({ sku: t.string(), quantity: t.integer({ minimum: 1 }) }) },
      },
      handler: Quotes.standardPricing,
      inputs: { sku: cel("request.body.sku"), quantity: cel("request.body.quantity") },
      returns: [{ status: 200, content: { "application/json": { body: cel("result") } } }],
    },
  ],
});

const server = Http.Server.resource("server", {
  listen: { port: cel("ports.http") },
  openapi: { info: { title: "Quotes", version: "1.0.0" } },
  mounts: [
    { path: "/v1", mount: quotesApi },
    { path: "/docs", mount: Http.Reference.inline({}) },
  ],
});

export default application({
  name: "Shop",
  version: "1.0.0",
  ports: { http: { env: "PORT", protocol: "tcp", default: 8845 } },
  targets: [
    server,
    {
      name: "openDocs",
      invoke: Telo.OpenUrl.resource("openDocs", {}),
      inputs: { url: interpolate("http://localhost:${{ ports.http }}/docs/") },
    },
  ],
});
```

A YAML application importing the code library — `../quotes` resolves to `quotes/telo.ts`:

```yaml
kind: Telo.Application
metadata: { name: QuoteCli, version: 1.0.0 }
imports: { Quotes: ../quotes, Console: oci://ghcr.io/telorun/console@0.9.0 }
targets:
  - { name: quote, invoke: !ref Quotes.standardPricing, inputs: { sku: SKU-2, quantity: 12 } }
  - name: show
    invoke: !ref print
    inputs:
      output: !interpolate "${{ steps.quote.result.quantity }} × SKU-2 = ${{ steps.quote.result.total }}"
---
kind: Console.WriteLine
metadata: { name: print }
```

The same library in Rust, `quotes-rs/` — one crate whose library root `telo.rs` holds the module and its controller:

```toml
# quotes-rs/Cargo.toml
[package]
name = "acme-quotes"
version = "1.0.0"
edition = "2021"

[lib]
path = "telo.rs"

[dependencies]
telorun-sdk = "…"
telorun-module-builder = "…"
schemars = "…"
serde = { version = "1", features = ["derive"] }
```

```rust
// quotes-rs/telo.rs
use std::collections::BTreeMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use telorun_module_builder::{kind, library, module, Library, Telo};
use telorun_sdk::{controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PriceList {
    pub prices: BTreeMap<String, f64>,
    #[serde(default = "ten")]
    pub bulk_threshold: i64,
    #[serde(default)]
    pub bulk_discount: f64,
}
fn ten() -> i64 { 10 }

#[derive(Deserialize, JsonSchema)]
pub struct QuoteRequest { pub sku: String, #[schemars(range(min = 1))] pub quantity: i64 }

#[derive(Serialize, JsonSchema)]
pub struct Quote { pub sku: String, pub quantity: i64, pub total: f64 }

pub struct PriceQuote { config: PriceList }

#[controller(entry = "price_quote")]
impl Controller for PriceQuote {
    fn create(manifest: Value, _ctx: &dyn ResourceContext) -> Result<Self> {
        Ok(Self { config: telorun_sdk::from_value(manifest)? })
    }

    fn invoke(&self, input: Value, _ctx: &InvokeContext) -> Result<Value> {
        let request: QuoteRequest = telorun_sdk::from_value(input)?;
        let price = self.config.prices.get(&request.sku).ok_or_else(|| {
            ControllerError::new("QUOTE_UNKNOWN_SKU", format!("no price for {}", request.sku))
        })?;
        let discount = if request.quantity >= self.config.bulk_threshold { self.config.bulk_discount } else { 0.0 };
        let total = price * request.quantity as f64 * (1.0 - discount);
        telorun_sdk::to_value(Quote { sku: request.sku, quantity: request.quantity, total })
    }
}

// The module, registered for the runner's generated driver; importing the crate does nothing.
#[module]
fn quotes() -> Library {
    let price_quote = kind("PriceQuote")
        .capability(Telo::Invocable)
        .description("Prices a quantity of one product from a price list, with a bulk discount above a threshold. …")
        .schema::<PriceList>()
        .input_type::<QuoteRequest>()
        .output_type::<Quote>()
        .throws("QUOTE_UNKNOWN_SKU", "No price is listed for {$sku}.")
        .controller::<PriceQuote>();

    let standard_pricing = price_quote.resource("standardPricing", PriceList {
        prices: BTreeMap::from([("SKU-1".into(), 12.5), ("SKU-2".into(), 40.0)]),
        bulk_threshold: 10,
        bulk_discount: 0.1,
    });

    library("Quotes").version("1.0.0").license("MIT").lang("en")
        .description("Price quotes for order lines: …")
        .export_kind(&price_quote)
        .export_resource(&standard_pricing)
}
```

**Verify**

- `telo check ./quotes` and `telo check` of `telo synth ./quotes` saved as a plain `telo.yaml` report the same findings, the first at `telo.ts` lines.
- `telo run ./shop` serves `POST /v1/quotes`; `telo run` of the YAML `QuoteCli` prints `12 × SKU-2 = 432`; the same app over `quotes-rs/` prints the same on both kernels.
- A misspelled `Http.Server` field in `shop/telo.ts` is a TypeScript error in VS Code, and Telo reports nothing in the `.ts` file.
- A directory holding `telo.yaml` and `telo.ts` is refused by `telo check` and `telo run` with `MODULE_ENTRY_AMBIGUOUS`, naming both.
- A program printing `process.env.HOME` into a description emits nothing for it; one embedding the time fails `telo publish` with `MODULE_PROGRAM_NONDETERMINISTIC`.
- Editing a file `telo.ts` imports re-synthesizes on the next `telo run`; an unchanged module never runs its program again.
- `quotes/telo.ts` is the whole module: its controller loads as `local_path=./telo.ts#PriceQuoteController`, and loading it writes no file.
- A kind given a controller that is not a named export is `CONTROLLER_NOT_EXPORTED` at the kind's line in `telo.ts`.
- A controller importing a native-addon package at the top of `telo.ts` fails synthesis with `MODULE_PROGRAM_FAILED` naming the import; moved into `create()`, it synthesizes and runs.
- `telo upgrade` in `shop/` changes only `imports/*` files.
- Studio shows `quotes/` read-only, in the desktop build and in the browser build over a runner advertising `features.synthesis`.
