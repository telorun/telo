import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A function's derived determinism and host-backedness, read by every consumer:
 * rule conditions, the compile-eval warning, idempotent regions and slots held
 * to a callable abstract.
 */

function source(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) =>
      new URL(relative, `file://${base}`).pathname,
  };
}

async function check(
  text: string,
  analyzer = new StaticAnalyzer(),
  files: Record<string, string> = {},
): Promise<Array<[string, string]>> {
  const url = "/lib/telo.yaml";
  const graph = await new Loader([source({ ...files, [url]: text })]).loadGraph(url, {
    desugarImports: true,
  });
  return analyzer.analyze(flattenForAnalyzer(graph)).map((d) => [String(d.code), d.message]);
}

const NATIVE = "pkg:telo/local/js?path=./nodejs/pricing.mjs&local_path=./nodejs/src/index.ts";

const pricing = (withVatBody: string, extra = "") => `kind: Telo.Library
metadata: { name: Pricing, version: 0.1.0 }
---
kind: Telo.Function
metadata: { name: withVat }
params:
  - name: net
    schema: { type: integer }
  - name: rateBps
    schema: { type: integer }
returns:
  schema: { type: integer }
body: !cel "${withVatBody}"
---
kind: Telo.Function
metadata: { name: isStale }
params:
  - name: at
    schema: { x-telo-type: Telo.Timestamp }
returns:
  schema: { type: boolean }
body: !cel "now() - at > duration('1h')"
---
kind: Telo.Definition
metadata: { name: SecureEquals }
capability: Telo.Callable
deterministic: true
params:
  - name: a
    schema: { type: string }
  - name: b
    schema: { type: string }
returns:
  schema: { type: boolean }
controllers:
  - ${NATIVE}#SecureEquals
---
kind: Self.SecureEquals
metadata: { name: secureEquals }
${extra}`;

const priceKind = (condition: string) => `---
kind: Telo.Definition
metadata: { name: Price }
capability: Telo.Invocable
schema:
  type: object
  properties:
    net: { type: integer }
    gross: { type: integer }
  x-telo-resource-rules:
    - condition: !cel "${condition}"
      code: GROSS_INCLUDES_VAT
      message: gross must be net plus VAT
controllers:
  - ${NATIVE}#Price
---
kind: Self.Price
metadata: { name: right }
net: 100
gross: 123
---
kind: Self.Price
metadata: { name: wrong }
net: 100
gross: 100
`;

describe("a rule condition calling a module function", () => {
  it("runs a deterministic body, evaluated by the analyzer", async () => {
    const diagnostics = await check(
      pricing("net + net * rateBps / 10000", priceKind("Self.withVat(self.net, 2300) == self.gross")),
    );
    expect(diagnostics).toEqual([
      ["RESOURCE_RULE_VIOLATED", "Self.Price/wrong: gross must be net plus VAT"],
    ]);
  });

  it("refuses a body reaching now() and a native function, naming the chain", async () => {
    const diagnostics = await check(
      pricing(
        "net",
        priceKind(
          "Self.isStale(timestamp('2020-01-01T00:00:00Z')) || Self.secureEquals('a', 'b')",
        ),
      ),
    );
    const refusals = diagnostics.filter(([code]) => code === "RESOURCE_RULE_INVALID");
    expect(refusals.map(([, message]) => message)).toEqual([
      expect.stringContaining("calls 'Self.isStale', which re-evaluates per call (Self.isStale → now())"),
      expect.stringContaining("calls 'Self.secureEquals', which needs the runtime's host (Self.secureEquals)"),
    ]);
  });

  it("is refused once the body it calls reaches now(), with no edit to the rule", async () => {
    const analyzer = new StaticAnalyzer();
    const rule = priceKind("Self.withVat(self.net, 2300) >= self.net");
    expect(await check(pricing("net + net * rateBps / 10000", rule), analyzer)).toEqual([]);

    const edited = await check(
      pricing("net + (now() > timestamp('2000-01-01T00:00:00Z') ? 0 : rateBps)", rule),
      analyzer,
    );
    expect(edited.map(([code]) => code)).toContain("RESOURCE_RULE_INVALID");
    expect(edited.find(([code]) => code === "RESOURCE_RULE_INVALID")![1]).toContain(
      "(Self.withVat → now())",
    );
  });
});

describe("a referrer-rule condition calling a module function", () => {
  it("evaluates a deterministic body and refuses one reaching now()", async () => {
    const diagnostics = await check(
      pricing(
        "net + net * rateBps / 10000",
        `---
kind: Telo.Definition
metadata: { name: Rate }
capability: Telo.Provider
schema:
  type: object
  properties:
    bps: { type: integer }
  x-telo-referrer-rules:
    - condition: !cel "Self.withVat(100, self.bps) > 100"
      code: RATE_POSITIVE
      message: a referenced rate must add VAT
    - condition: !cel "!Self.isStale(timestamp('2020-01-01T00:00:00Z'))"
      code: RATE_FRESH
      message: a referenced rate must be fresh
controllers:
  - ${NATIVE}#Rate
---
kind: Self.Rate
metadata: { name: zero }
bps: 0
---
kind: Telo.Definition
metadata: { name: Invoice }
capability: Telo.Invocable
schema:
  type: object
  properties:
    rate:
      x-telo-ref: { kind: Self.Rate, use: dependency }
controllers:
  - ${NATIVE}#Invoice
---
kind: Self.Invoice
metadata: { name: invoice }
rate: !ref zero
`,
      ),
    );
    expect(diagnostics).toEqual([
      ["REFERRER_RULE_INVALID", expect.stringContaining("calls 'Self.isStale', which re-evaluates")],
      ["REFERRER_RULE_VIOLATED", expect.stringContaining("a referenced rate must add VAT")],
      ["REFERRER_RULE_VIOLATED", expect.stringContaining("a referenced rate must be fresh")],
    ]);
  });
});

describe("a compile-time field calling a volatile function", () => {
  it("warns, naming the chain to the leaf", async () => {
    const diagnostics = await check(
      pricing(
        "net",
        `---
kind: Telo.Function
metadata: { name: stamp }
returns:
  schema: { type: string }
body: !cel "string(now())"
---
kind: Telo.Definition
metadata: { name: Label }
capability: Telo.Provider
schema:
  type: object
  properties:
    text: { type: string }
controllers:
  - ${NATIVE}#Label
---
kind: Self.Label
metadata: { name: bootLabel }
text: !cel "Self.stamp()"
`,
      ),
    );
    expect(diagnostics).toEqual([
      [
        "CEL_NONDETERMINISTIC_IN_COMPILE_FIELD",
        expect.stringContaining("so `Self.stamp → now()` is baked in at load"),
      ],
    ]);
  });

  it("sees through an imported function to the internal one it calls", async () => {
    const diagnostics = await check(
      `kind: Telo.Library
metadata: { name: App, version: 0.1.0 }
imports:
  Clock: ../clock/telo.yaml
---
kind: Telo.Definition
metadata: { name: Label }
capability: Telo.Provider
schema:
  type: object
  properties:
    text: { type: string }
controllers:
  - ${NATIVE}#Label
---
kind: Self.Label
metadata: { name: bootLabel }
text: !cel "Clock.stamp()"
`,
      new StaticAnalyzer(),
      {
        "/clock/telo.yaml": `kind: Telo.Library
metadata: { name: Clock, version: 0.1.0 }
exports: { resources: [stamp] }
---
kind: Telo.Function
metadata: { name: stamp }
returns:
  schema: { type: string }
body: !cel "Self.iso()"
---
kind: Telo.Function
metadata: { name: iso }
returns:
  schema: { type: string }
body: !cel "string(now())"
`,
      },
    );
    expect(diagnostics).toEqual([
      [
        "CEL_NONDETERMINISTIC_IN_COMPILE_FIELD",
        expect.stringContaining("so `Clock.stamp → Self.iso → now()` is baked in at load"),
      ],
    ]);
  });
});

describe("a module call inside an idempotent region", () => {
  const region = (call: string) =>
    pricing(
      "net",
      `---
kind: Telo.Definition
metadata: { name: Unmarked }
capability: Telo.Callable
params:
  - name: key
    schema: { type: string }
returns:
  schema: { type: string }
controllers:
  - ${NATIVE}#Unmarked
---
kind: Self.Unmarked
metadata: { name: unmarked }
---
kind: Telo.Definition
metadata: { name: Marked }
capability: Telo.Callable
deterministic: true
params:
  - name: key
    schema: { type: string }
returns:
  schema: { type: string }
controllers:
  - ${NATIVE}#Marked
---
kind: Self.Marked
metadata: { name: marked }
---
kind: Telo.Function
metadata: { name: wrap }
params:
  - name: key
    schema: { type: string }
returns:
  schema: { type: string }
body: !cel "Self.unmarked(key)"
---
kind: Telo.Definition
metadata: { name: Write }
capability: Telo.Invocable
controllers:
  - ${NATIVE}#Write
---
kind: Self.Write
metadata: { name: write }
---
kind: Telo.Definition
metadata: { name: Once }
capability: Telo.Invocable
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
      x-telo-provides-zone:
        idempotent: re-running the body is a no-op
        noSuspend: the claim is held in memory
controllers:
  - ${NATIVE}#Once
---
kind: Self.Once
metadata: { name: importAll }
steps:
  - name: put
    invoke: !ref write
    inputs:
      key: !cel "${call}"
`,
    );

  const nondeterminism = async (call: string) =>
    (await check(region(call))).filter(([code]) => code === "DURABLE_NONDETERMINISM");

  it("reports a native function whose kind claims nothing", async () => {
    expect(await nondeterminism("Self.unmarked('a')")).toEqual([
      ["DURABLE_NONDETERMINISM", expect.stringContaining("'Self.unmarked' is evaluated inside")],
    ]);
  });

  it("accepts a native function whose kind claims determinism", async () => {
    expect(await nondeterminism("Self.marked('a')")).toEqual([]);
  });

  it("reports a body wrapping the unmarked native, with the chain", async () => {
    expect(await nondeterminism("Self.wrap('a')")).toEqual([
      [
        "DURABLE_NONDETERMINISM",
        expect.stringContaining("'Self.wrap → Self.unmarked' is evaluated inside"),
      ],
    ]);
  });
});

describe("a function in a slot constrained to a callable abstract", () => {
  const verifier = (functions: string, signer: string) => `kind: Telo.Library
metadata: { name: Crypto, version: 0.1.0 }
---
kind: Telo.Abstract
metadata: { name: Signer }
capability: Telo.Callable
params:
  - name: key
    schema: { type: string }
  - name: message
    schema: { type: string }
returns:
  schema: { type: string }
---
kind: Telo.Abstract
metadata: { name: StableSigner }
capability: Telo.Callable
extends: Self.Signer
deterministic: true
---
kind: Telo.Definition
metadata: { name: Verifier }
capability: Telo.Invocable
schema:
  type: object
  properties:
    signer:
      x-telo-ref: { kind: Self.Signer, use: dependency }
    stable:
      x-telo-ref: { kind: Self.StableSigner, use: dependency }
controllers:
  - ${NATIVE}#Verifier
---
${functions}
---
kind: Self.Verifier
metadata: { name: verifier }
${signer}
`;

  const fn = (name: string, messageType: string, body: string) => `kind: Telo.Function
metadata: { name: ${name} }
params:
  - name: key
    schema: { type: string }
  - name: message
    schema: { type: ${messageType} }
returns:
  schema: { type: string }
body: !cel "${body}"`;

  it("is satisfied by a function whose signature stands in for the abstract's", async () => {
    expect(
      await check(verifier(fn("concat", "string", "key + message"), "signer: !ref concat")),
    ).toEqual([]);
  });

  it("is refused, naming the parameter, when the signature cannot stand in", async () => {
    const diagnostics = await check(
      verifier(fn("numeric", "integer", "key + string(message)"), "signer: !ref numeric"),
    );
    expect(diagnostics.map(([code]) => code)).toEqual(["REFERENCE_KIND_MISMATCH"]);
    expect(diagnostics[0]![1]).toContain(
      "'numeric' does not extend 'Crypto.Signer', and cannot stand in for it: parameter 'message' does not accept",
    );
  });

  it("is refused, naming the chain, when the abstract requires determinism", async () => {
    const diagnostics = await check(
      verifier(fn("clocked", "string", "key + message + string(now())"), "stable: !ref clocked"),
    );
    expect(diagnostics.map(([code]) => code)).toEqual(["REFERENCE_KIND_MISMATCH"]);
    expect(diagnostics[0]![1]).toContain(
      "'Crypto.StableSigner' requires a deterministic function, and 'clocked' is not (clocked → now()).",
    );
  });
});
