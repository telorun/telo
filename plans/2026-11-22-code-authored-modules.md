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

## Surface

**Added**

- `telo.ts`, `telo.mts`, `telo.js`, `telo.mjs` — a module entry at the module root, run by the `node` runner
- `telo.rs` — a module entry at the module root, the crate's `[[bin]] name = "telo"`, run by the `rust` runner
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

**A code module is a directory whose entry is a program.** The entry is `telo.<ext>` at the module root and its extension picks the runner (the Gradle `build.gradle` / `build.gradle.kts` pattern). The entry's URL is the module's canonical source, so the module root, relative imports, `!module-path` and `!include-*` resolve exactly as for `telo.yaml`. A directory holding two entries is refused. The set of runners is a data table both host halves read; adding a language adds a row and its runner, and changes no kernel, analyzer, CLI or editor code.

**Synthesis, not execution.** A host runs the program to produce the module's documents — the CDK / cdk8s pattern — and every consumer reads those documents. The program writes, into an empty output directory, `telo.yaml` in Telo's own grammar (tags included) and optionally `telo.locations.json`, keyed by document index and JSON Pointer, mapping each node to a file and range of the program's source. Both analyzers read the text as they read any `telo.yaml`; the location table rides the source's read result, so a finding is placed by lookup. At `telo publish` / `telo package` the synthesized text is the artifact's `telo.yaml`, with the measured `requires:` floor written beside `layers:` (a program never writes `requires:` or `include:`); consumers, pins and the hub see an ordinary module. The run contract is normative in `packages/module-synthesis/README.md`, with vectors in `packages/module-synthesis/conformance/` that both halves of the package and both analyzers run.

**The run contract is hermetic.** The program runs with an environment carrying nothing of the host's, stdin closed, no arguments, its working directory the empty output directory. Everything it uses arrives at build time (bundled imports in Node, `include_str!` in Rust). The Node runner bundles the entry with esbuild and runs the bundle on Node under the permission model (read its bundle, write the output directory, no child processes, workers or addons); the Rust runner builds the `telo` binary with cargo into the cache and executes it directly, refusing one whose dep-info records an environment dependency other than Cargo's own. Variables reach a module only as declared `variables:` read at run time by the kernel, never through the program. `telo publish`, `telo package` and release planning run the program twice and refuse differing output.

**One synthesizer for every host.** `@telorun/module-synthesis` (and its Rust twin) is composed into both kernels' local sources, the CLIs and the VS Code extension host; its browser-safe half (entry table, location table schema, nearest-ancestor resolution) is what the analyzers depend on, and the analyzer never runs a program. Output is cached under `<cache root>/synthesis/<key>/`, keyed by every input the build reported, the build options, the runner and the format, so an unchanged module never runs its program again and an edit to any input is a new key. `--watch` watches the recorded inputs. Both kernels host both runners from the start; a host whose toolchain lacks one refuses with `MODULE_PROGRAM_UNSUPPORTED`.

**Controllers live beside the program, not in it.** A Node code module keeps its controllers in a separate entry of the same package (`controllers.ts`), referenced from the program through a typed handle built from a type-only import, so the path and export name are checked by the compiler and the synthesized candidate is `pkg:telo/local/js?…&local_path=<entry>#<Export>`. A Rust code module is one crate: the lib target holds the controllers (`pkg:cargo/<crate>?local_path=.#<entry>`), the `telo` bin target synthesizes, referencing a controller by type; the Rust SDK exposes a controller's entry name to the builder. The controller bundle never contains the builder, and synthesis never loads controller code.

**Typed bindings make the compiler the author's feedback loop.** Since Telo publishes no diagnostics into `.ts` files, the TypeScript or Rust compiler is what catches a misspelled field. `telo add <source>` resolves and pins the source and writes a committed binding file per alias under `imports/` (generated by the module's own builder version, so the binding matches the builder it compiles against); `telo upgrade` moves the pin and regenerates the types together; `telo install` only warms the cache, as today. A module's own kinds need no generation: TypeScript types are inferred from the schema builders (the TypeBox pattern), Rust schemas derived from the config types (the schemars pattern). Built-in `Telo.*` kinds ship in the builder. CEL is written through `cel(…)` / `interpolate(…)` helpers and is expected only at the edges — a port, a request mapped into a handler's inputs.

**Where findings appear.** `telo check <code module>` prints the same codes and exit status as for YAML, each finding at its program location (`telo.ts:14:3`) with the resource and path kept in the message; a finding no location covers is placed at the entry. In editors the engine publishes nothing at a program-origin file: a consumer's dependency verdict for a code library keeps editable-origin severity and is re-anchored at the consumer's `imports:` entry, with LSP `relatedInformation` linking to the program line. Studio shows a code module read-only, recognised by the read's `program` member.

**Editor and Studio reads.** `telo/read` of a code module directory or entry answers the canonical entry URI, the synthesized text and `program: { locations }`, or `refusal: { code, message }`; the host sends `workspace/didChangeWatchedFiles` for the entry when a recorded input changes, and serves code modules only in a trusted VS Code workspace. Studio's desktop build runs its bundled telo's `telo synth --format json`; its browser build calls the runner's `GET /v1/sessions/:id/workspace/synthesis` when the session's runner advertises `features.synthesis` (the runner runs `telo synth` inside the session's workload) and otherwise shows the module unavailable with `MODULE_PROGRAM_UNSUPPORTED`. Runner images carry the toolchain of every runner they advertise.

**Applications too.** `variables:`, `secrets:`, `ports:` with `env:` / `arg:`, `targets:`, `logging:`, `tracing:`, `translations:`, `needs:` and `lang:` are documents the program emits; `telo run <dir> [arguments]` reads arguments against the synthesized bindings (the program receives none), and runners learn an application's `ports:` from the synthesized documents.

**Everything else follows.** Docs: a code-modules guide under `docs/extend/`, the CLI reference for `telo synth` / `telo add`, the benefits-ledger entry. The authoring-agent primer and the hub's library-design guide learn code modules. `tests/check-run-agreement.yaml` gains a row for every `MODULE_*` refusal except the publish-only one; both analyzers' check-conformance pin `MODULE_ENTRY_AMBIGUOUS`. `module-builder/` and `packages/module-synthesis/` join the MIT list and `pnpm run check:licenses`; `module-builder` joins `release.groups.telo`. `cli/rust` gains `telo synth`; `telo add` is Node-CLI only, like `telo upgrade`.

## Decisions

- **Synthesis over runtime registration (Pulumi) and over in-process hosting** — static analysis, hub indexing, the import pin and Studio all need documents without running code, and a Node host cannot import a Rust program.
- **Entry by `telo.<ext>`, not a pointer file or a package-manifest key** — a pointer file is a manifest the constraints forbid; Go's `go.mod` has nowhere to put a key; `telo.yaml` already makes the basename the convention.
- **Program emits Telo's YAML grammar, not a JSON encoding of tags** — one grammar both analyzers already read and the published artifact already is; a second spelling of every tag would be twinned forever.
- **Location table keyed by document + JSON Pointer, not a text source map** — the loader's own position key, so mapping is a lookup with no second parser.
- **Determinism enforced by an empty environment and a sandbox; two runs only where output becomes durable** — the environment rule then holds in every language by construction, without doubling every cold load.
- **Controllers in a separate entry of the same package/crate** — a program and a controller realm in one bundle would make the kernel execute the program and inline the builder; a function value carries no export name once bundled.
- **Committed bindings under `imports/`, written by a new `telo add`** — the only committed place for a pin in a module with no manifest; gitignored bindings would leave a fresh clone untyped; `telo install` stays a cache-warming command that never writes the author's tree.
- **Findings re-anchored at the consumer's import in editors** — keeps the author's errors as errors without publishing into `.ts`.
- **Browser Studio reads through a runner route, not `workspace/file`** — the cache is outside the workspace, and a flag switching one route between two answer shapes is two routes in one.
- **Builder on the telo line, synthesis package off it** — the builder's bindings and annotations are one generation's surface; the run contract is spoken across generations, like the editor protocol.

## Complete example after the change

A Node library, `quotes/`:

```
quotes/
  package.json      # @telorun/module-builder, @telorun/sdk
  telo.ts           # the module program
  controllers.ts    # the controller entry
```

```ts
// quotes/telo.ts
import { library, kind, t, Telo, controllerEntry } from "@telorun/module-builder";
import type * as Controllers from "./controllers.js";

const code = controllerEntry<typeof Controllers>("./controllers.ts");

export const QuoteRequest = t.object({ sku: t.string(), quantity: t.integer({ minimum: 1 }) });
export const Quote = t.object({ sku: t.string(), quantity: t.integer(), total: t.number() });

export const PriceQuote = kind("PriceQuote", {
  capability: Telo.Invocable,
  description:
    "Prices a quantity of one product from a price list, with a bulk discount above a threshold. " +
    "Returns the line total; a product missing from the list fails with QUOTE_UNKNOWN_SKU.",
  schema: t.object({
    prices: t.record(t.number({ minimum: 0 })),
    bulkThreshold: t.integer({ default: 10 }),
    bulkDiscount: t.number({ minimum: 0, maximum: 1, default: 0 }),
  }),
  inputType: QuoteRequest,
  outputType: Quote,
  throws: {
    QUOTE_UNKNOWN_SKU: { data: t.object({ sku: t.string() }), displayMessage: "No price is listed for {$sku}." },
  },
  controller: code.PriceQuote,
});

const standardPricing = PriceQuote.resource("standardPricing", {
  prices: { "SKU-1": 12.5, "SKU-2": 40 },
  bulkDiscount: 0.1,
});

export default library({
  name: "Quotes",
  version: "1.0.0",
  license: "MIT",
  lang: "en",
  description:
    "Price quotes for order lines: a price list per product, bulk discounts above a quantity " +
    "threshold, and a ready-made standard price list.",
  exports: { kinds: [PriceQuote], resources: [standardPricing] },
});
```

```ts
// quotes/controllers.ts
import { InvokeError, integerInput, type ResourceContext } from "@telorun/sdk";
import type { ConfigOf, InputOf, OutputOf } from "@telorun/module-builder";
import type { PriceQuote as Kind } from "./telo.js";

class PriceQuoteResource {
  constructor(private readonly config: ConfigOf<typeof Kind>) {}

  async invoke(inputs: InputOf<typeof Kind>): Promise<OutputOf<typeof Kind>> {
    const price = this.config.prices[inputs.sku];
    if (price === undefined) {
      throw new InvokeError("QUOTE_UNKNOWN_SKU", `no price for ${inputs.sku}`, { sku: inputs.sku });
    }
    const quantity = integerInput(inputs.quantity)!;
    const discount = quantity >= integerInput(this.config.bulkThreshold)! ? this.config.bulkDiscount : 0;
    return { sku: inputs.sku, quantity, total: price * quantity * (1 - discount) };
  }
}

export const PriceQuote = {
  async create(resource: ConfigOf<typeof Kind>, ctx: ResourceContext) {
    return new PriceQuoteResource(resource);
  },
};
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
controllers: [pkg:telo/local/js?path=./controllers.mjs&local_path=./controllers.ts#PriceQuote]
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

The same library in Rust, `quotes-rs/` — one crate, the controllers in the lib target and the program in the `telo` bin target:

```toml
# quotes-rs/Cargo.toml
[package]
name = "acme-quotes"
version = "1.0.0"
edition = "2021"

[lib]
path = "src/lib.rs"

[[bin]]
name = "telo"
path = "telo.rs"

[dependencies]
telorun-sdk = "…"
telorun-module-builder = "…"
schemars = "…"
serde = { version = "1", features = ["derive"] }
```

```rust
// quotes-rs/src/lib.rs
use std::collections::BTreeMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use telorun_sdk::{controller, Controller, ControllerError, InvokeContext, ResourceContext, Result, Value};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PriceQuoteConfig {
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

pub struct PriceQuote { config: PriceQuoteConfig }

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
```

```rust
// quotes-rs/telo.rs
use std::collections::BTreeMap;
use acme_quotes::{PriceQuote, PriceQuoteConfig, Quote, QuoteRequest};
use telorun_module_builder::{kind, library, synth, Telo};

fn main() {
    let price_quote = kind("PriceQuote")
        .capability(Telo::Invocable)
        .description("Prices a quantity of one product from a price list, with a bulk discount above a threshold. …")
        .schema::<PriceQuoteConfig>()
        .input_type::<QuoteRequest>()
        .output_type::<Quote>()
        .throws("QUOTE_UNKNOWN_SKU", "No price is listed for {$sku}.")
        .controller::<PriceQuote>();

    let standard_pricing = price_quote.resource("standardPricing", PriceQuoteConfig {
        prices: BTreeMap::from([("SKU-1".into(), 12.5), ("SKU-2".into(), 40.0)]),
        bulk_threshold: 10,
        bulk_discount: 0.1,
    });

    synth(
        library("Quotes").version("1.0.0").license("MIT").lang("en")
            .description("Price quotes for order lines: …")
            .export_kind(&price_quote)
            .export_resource(&standard_pricing),
    );
}
```

**Verify**

- `telo check ./quotes` and `telo check` of `telo synth ./quotes` saved as a plain `telo.yaml` report the same findings, the first at `telo.ts` lines.
- `telo run ./shop` serves `POST /v1/quotes`; `telo run` of the YAML `QuoteCli` prints `12 × SKU-2 = 432`; the same app over `quotes-rs/` prints the same on both kernels.
- A misspelled `Http.Server` field in `shop/telo.ts` is a TypeScript error in VS Code, and Telo reports nothing in the `.ts` file.
- A directory holding `telo.yaml` and `telo.ts` is refused by `telo check` and `telo run` with `MODULE_ENTRY_AMBIGUOUS`, naming both.
- A program printing `process.env.HOME` into a description emits nothing for it; one embedding the time fails `telo publish` with `MODULE_PROGRAM_NONDETERMINISTIC`.
- Editing a file `telo.ts` imports re-synthesizes on the next `telo run`; an unchanged module never runs its program again.
- The built controller bundle of `quotes/` contains no `@telorun/module-builder` code.
- `telo upgrade` in `shop/` changes only `imports/*` files.
- Studio shows `quotes/` read-only, in the desktop build and in the browser build over a runner advertising `features.synthesis`.
