import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { resolveSignature } from "../src/callable-signature.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { resolveRefSentinels } from "../src/resolve-ref-sentinels.js";
import { resolveSchemaTypeRefs } from "../src/resolve-schema-type-refs.js";
import type { ManifestSource } from "../src/types.js";

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

/** Every diagnostic `telo check` reports for a single-file library, as
 *  `[code, message]` pairs — exhaustive, so a stray diagnostic fails the test. */
async function check(text: string): Promise<Array<[string, string]>> {
  const url = "/lib/telo.yaml";
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph))
    .map((d) => [String(d.code), d.message]);
}

const codes = (diagnostics: Array<[string, string]>): string[] => diagnostics.map(([c]) => c);

const library = (name: string, body: string): string =>
  [`kind: Telo.Library`, `metadata:`, `  name: ${name}`, `  version: 0.1.0`, body].join("\n");

describe("libraries declaring and calling functions across a module boundary", () => {
  it("Crypto checks clean, its body's module call reaching an inherited signature", async () => {
    const crypto = library(
      "Crypto",
      `exports:
  kinds: [Hmac, Signer, WebhookVerifier]
  resources: [hmacSha256, hmacSha512, signatureHeader, secureEquals]
---
kind: Telo.Abstract
metadata:
  name: Signer
  description: Signs a message under a key and returns the signature as text.
capability: Telo.Callable
params:
  - name: key
    schema: { type: string }
  - name: message
    schema: { type: string }
returns:
  schema: { type: string }
---
kind: Telo.Definition
metadata:
  name: Hmac
  description: Signs a message with HMAC under a key, using the configured digest algorithm.
capability: Telo.Callable
extends: Self.Signer
deterministic: true
schema:
  type: object
  required: [algorithm]
  properties:
    algorithm: { type: string, enum: [sha256, sha384, sha512] }
controllers:
  - pkg:telo/local/js?path=./nodejs/crypto.mjs&local_path=./nodejs/src/index.ts#HmacFunction
---
kind: Self.Hmac
metadata:
  name: hmacSha256
algorithm: sha256
---
kind: Self.Hmac
metadata:
  name: hmacSha512
algorithm: sha512
---
kind: Telo.Definition
metadata:
  name: SecureEquals
  description: Compares two strings in constant time.
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
  - pkg:telo/local/js?path=./nodejs/crypto.mjs&local_path=./nodejs/src/index.ts#SecureEqualsFunction
---
kind: Self.SecureEquals
metadata:
  name: secureEquals
---
kind: Telo.Function
metadata:
  name: signatureHeader
  description: Renders a webhook signature header value from a timestamp and a payload.
params:
  - name: key
    schema: { type: string }
  - name: timestamp
    schema: { type: integer }
  - name: payload
    schema: { type: string }
returns:
  schema: { type: string }
body: !cel "'t=' + string(timestamp) + ',v1=' + Self.hmacSha256(key, string(timestamp) + '.' + payload)"
---
kind: Telo.Definition
metadata:
  name: WebhookVerifier
  description: Accepts a webhook only when its signature matches the payload under the shared key.
capability: Telo.Invocable
schema:
  type: object
  required: [signer]
  properties:
    signer:
      x-telo-ref: { kind: Self.Signer, use: dependency }
controllers:
  - pkg:telo/local/js?path=./nodejs/crypto.mjs&local_path=./nodejs/src/index.ts#WebhookVerifierController
`,
    );
    expect(codes(await check(crypto))).toEqual([]);
  });

  it("Billing checks clean, its parameters typed from their named shapes", async () => {
    const billing = library(
      "Billing",
      `exports:
  resources: [Money, format, total, isStale]
---
kind: Telo.JsonSchema
metadata:
  name: Money
schema:
  type: object
  required: [amount, currency, pricedAt]
  properties:
    amount: { type: integer }
    currency: { type: string }
    pricedAt: { x-telo-type: Telo.Timestamp }
---
kind: Telo.Function
metadata:
  name: format
  description: Renders an amount of money with its currency code.
params:
  - name: value
    schema: !ref Money
  - name: locale
    schema: { type: string, default: en-US }
    optional: true
returns:
  schema: { type: string }
body: !cel "format(value.amount, ',d') + ' ' + value.currency"
---
kind: Telo.Function
metadata:
  name: total
  description: Sums a list of amounts that share one currency.
params:
  - name: items
    schema: { type: array, items: !ref Money }
returns:
  schema: !ref Money
body: !cel "{'amount': int(sum(items.map(m, m.amount))), 'currency': items[0].currency, 'pricedAt': now()}"
---
kind: Telo.Function
metadata:
  name: isStale
  description: Tells whether a price is older than the given maximum age.
params:
  - name: value
    schema: !ref Money
  - name: maxAge
    schema: { x-telo-type: Telo.Duration }
returns:
  schema: { type: boolean }
body: !cel "now() - value.pricedAt > maxAge"
`,
    );
    expect(await check(billing)).toEqual([]);
  });
});

describe("resolving a signature", () => {
  it("takes the instance's, else the nearest along extends, each half replacing rather than merging", () => {
    const abstract = {
      kind: "Telo.Abstract",
      metadata: { name: "Pricer", module: "Billing" },
      capability: "Telo.Callable",
      params: [{ name: "value", schema: { type: "integer" } }],
      returns: { schema: { type: "string" } },
    };
    const native = {
      kind: "Telo.Definition",
      metadata: { name: "Native", module: "Billing" },
      extends: "Billing.Pricer",
      params: [{ name: "amount", schema: { type: "number" } }],
      schema: { type: "object", properties: { returns: {} } },
    };
    const defs: Record<string, any> = { "Billing.Pricer": abstract, "Billing.Native": native };
    const resolve = (kind: string) => defs[kind];

    expect(resolveSignature(undefined, native as any, resolve)).toEqual({
      params: native.params,
      returns: abstract.returns,
    });
    const instance = {
      kind: "Billing.Native",
      metadata: { name: "n" },
      returns: { schema: {} },
      params: [{ name: "other", schema: { type: "integer" } }],
    };
    // `returns` is a property of the kind's schema, so the instance declares it;
    // `params` is not, so on this instance it is configuration and replaces nothing.
    expect(resolveSignature(instance as any, native as any, resolve)).toEqual({
      params: native.params,
      returns: instance.returns,
    });
  });
});

describe("a signature's named shapes", () => {
  const sentinel = (source: string) => ({ __tagged: true, engine: "ref", source });

  it("resolve at the root and nested on a definition, an abstract and a function, and nowhere else on a kind", () => {
    const meta = (name: string) => ({ name, module: "Billing" });
    const manifests = [
      { kind: "Telo.JsonSchema", metadata: meta("Money"), schema: { type: "object" } },
      {
        kind: "Telo.Abstract",
        metadata: meta("Pricer"),
        capability: "Telo.Callable",
        params: [{ name: "value", schema: sentinel("Money") }],
        returns: { schema: { type: "array", items: sentinel("Money") } },
      },
      {
        kind: "Telo.Definition",
        metadata: meta("Native"),
        capability: "Telo.Callable",
        params: [{ name: "items", schema: { type: "array", items: sentinel("Money") } }],
        returns: { schema: sentinel("Money") },
        // Outside the signature a kind document keeps its references as written.
        schema: { type: "object", properties: { shape: sentinel("Money") } },
      },
      {
        kind: "Telo.Function",
        metadata: meta("total"),
        params: [{ name: "items", schema: { type: "array", items: sentinel("Money") } }],
        returns: { schema: sentinel("Money") },
        body: "x",
      },
    ] as unknown as ResourceManifest[];

    resolveRefSentinels(manifests);
    resolveSchemaTypeRefs(manifests);

    const money = { $ref: "telo:Billing/Money" };
    const [, pricer, native, fn] = manifests as unknown as Array<Record<string, any>>;
    expect(pricer.params[0].schema).toEqual(money);
    expect(pricer.returns.schema.items).toEqual(money);
    expect(native.params[0].schema.items).toEqual(money);
    expect(native.returns.schema).toEqual(money);
    expect(native.schema.properties.shape).toEqual(sentinel("Money"));
    expect(fn.params[0].schema.items).toEqual(money);
    expect(fn.returns.schema).toEqual(money);
  });

  it("written as a bare name is FUNCTION_TYPE_NAME_FORM, repaired with !ref", async () => {
    const graph = await new Loader([
      inMemorySource({
        "/lib/telo.yaml": library(
          "Billing",
          `---
kind: Telo.JsonSchema
metadata:
  name: Money
schema: { type: object }
---
kind: Telo.Function
metadata:
  name: format
params:
  - name: value
    schema: Money
returns:
  schema: { type: string }
body: !cel "'x'"
`,
        ),
      }),
    ]).loadGraph("/lib/telo.yaml", { desugarImports: true });
    const diagnostics = new StaticAnalyzer().analyze(flattenForAnalyzer(graph));
    expect(diagnostics.map((d) => [d.code, (d.data as any)?.path, (d.data as any)?.fix])).toEqual([
      ["FUNCTION_TYPE_NAME_FORM", "params[0].schema", { replacement: "Money", tag: "ref" }],
    ]);
  });
});

describe("a signature's references and names", () => {
  it("reports a !ref that names nothing, at the root and nested, on a kind and on a function", async () => {
    const diagnostics = await check(
      library(
        "Billing",
        `---
kind: Telo.Abstract
metadata:
  name: Pricer
capability: Telo.Callable
params:
  - name: value
    schema: !ref Nope
returns:
  schema: { type: array, items: !ref AlsoNope }
---
kind: Telo.Function
metadata:
  name: format
params:
  - name: value
    schema: !ref Missing
returns:
  schema: { type: string }
body: !cel "'x'"
`,
      ),
    );
    expect(codes(diagnostics)).toEqual([
      "CONTRACT_TYPE_NOT_FOUND",
      "CONTRACT_TYPE_NOT_FOUND",
      "CONTRACT_TYPE_NOT_FOUND",
    ]);
    expect(diagnostics.map(([, message]) => message.slice(0, message.indexOf(" names")))).toEqual([
      "'params[0].schema'",
      "'returns.schema.items'",
      "'params[0].schema'",
    ]);
  });

  it("checks each parameter's name as a CEL binding name", async () => {
    const diagnostics = await check(
      library(
        "Billing",
        `---
kind: Telo.Function
metadata:
  name: format
params:
  - name: in
    schema: { type: string }
  - name: Value
    schema: { type: string }
returns:
  schema: { type: string }
body: !cel "Value"
`,
      ),
    );
    expect(codes(diagnostics)).toEqual(["INVALID_NAME", "NAME_CASE_CONVENTION"]);
  });
});

describe("an instance of a native function kind", () => {
  const kind = (instance: string) =>
    library(
      "Crypto",
      `---
kind: Telo.Definition
metadata:
  name: Hmac
capability: Telo.Callable
deterministic: true
params:
  - name: message
    schema: { type: string }
returns:
  schema: { type: string }
schema:
  type: object
  properties:
    algorithm: { type: string }
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
---
kind: Self.Hmac
metadata:
  name: hmacSha256
algorithm: sha256
${instance}`,
    );

  it("does not replace its kind's signature through configuration its kind's schema does not declare", async () => {
    expect(
      await check(kind("params:\n  - name: in\n    schema: !ref Nope")),
    ).toEqual([]);
  });

  it("refuses `deterministic`, which only the kind supplying the code may claim", async () => {
    const diagnostics = await check(kind("deterministic: false"));
    expect(codes(diagnostics)).toEqual(["CALLABLE_DEFINITION_INVALID"]);
    expect(diagnostics[0]![1]).toContain("declares `deterministic` on an instance of a function kind");
  });
});

describe("a slot holding a function", () => {
  it("is untyped when its kind declares no signature of its own, as Telo.Function does not", async () => {
    const diagnostics = await check(
      library(
        "Crypto",
        `---
kind: Telo.Abstract
metadata:
  name: Holder
schema:
  type: object
  properties:
    fn:
      x-telo-ref: { kind: Telo.Function, use: dependency }
`,
      ),
    );
    expect(codes(diagnostics)).toEqual(["X_TELO_REF_CALLABLE_UNTYPED"]);
    expect(diagnostics[0]![1]).toContain("constrains to 'Telo.Function', a function kind that declares no signature");
  });
});

describe("a Telo.Function", () => {
  const fn = (extra: string, body = "!cel \"value.amount\"") =>
    library(
      "Billing",
      `---
kind: Telo.JsonSchema
metadata:
  name: Money
schema:
  type: object
  properties:
    amount: { type: integer }
---
kind: Telo.Function
metadata:
  name: amountOf
params:
  - name: value
    schema: !ref Money
returns:
  schema: { type: integer }
body: ${body}
${extra}`,
    );

  it("refuses `deterministic:`, which a body derives rather than claims", async () => {
    const diagnostics = await check(fn("deterministic: true"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]![0]).toBe("SCHEMA_VIOLATION");
    expect(diagnostics[0]![1]).toContain("'deterministic' is not allowed");
  });

  it("types its body against its parameters", async () => {
    const diagnostics = await check(fn("", '!cel "value.amont"'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]![0]).toBe("CEL_UNKNOWN_FIELD");
    expect(diagnostics[0]![1]).toContain("'value.amont' is not defined");
  });

  it("sees its parameters in place of the kernel globals, even one its module declares", async () => {
    const diagnostics = await check(
      library(
        "Billing",
        `variables:
  limit: { type: integer }
---
kind: Telo.Function
metadata:
  name: overLimit
params:
  - name: amount
    schema: { type: integer }
returns:
  schema: { type: boolean }
body: !cel "amount > variables.limit"
`,
      ),
    );
    const unknown = diagnostics.find(([code]) => code === "CEL_UNKNOWN_IDENTIFIER");
    expect(unknown?.[1]).toContain("unknown identifier 'variables'");
  });

  it("refuses x-telo-sensitive inside its signature, where nothing redacts a CEL value", async () => {
    const diagnostics = await check(
      library(
        "Billing",
        `---
kind: Telo.Function
metadata:
  name: token
params:
  - name: secret
    schema: { type: string, x-telo-sensitive: true }
returns:
  schema: { type: string }
body: !cel "secret"
`,
      ),
    );
    expect(codes(diagnostics)).toEqual(["SENSITIVE_ANNOTATION_MISPLACED"]);
  });
});

describe("a signature replacing a callable abstract's", () => {
  const abstract = `---
kind: Telo.JsonSchema
metadata:
  name: Money
schema:
  type: object
  required: [amount]
  properties:
    amount: { type: integer }
---
kind: Telo.JsonSchema
metadata:
  name: Label
schema: { type: string }
---
kind: Telo.Abstract
metadata:
  name: Pricer
capability: Telo.Callable
deterministic: true
params:
  - name: value
    schema: !ref Money
  - name: locale
    schema: { type: string }
    optional: true
returns:
  schema: { type: array, items: !ref Label }
`;
  const child = (signature: string, deterministic = "deterministic: true") =>
    library(
      "Billing",
      `${abstract}---
kind: Telo.Definition
metadata:
  name: Native
extends: Self.Pricer
${deterministic}
${signature}
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
`,
    );

  it("is refused when a parameter or the result does not stand in, compared through named shapes", async () => {
    const diagnostics = await check(
      child(`params:
  - name: value
    schema: !ref Label
  - name: locale
    schema: { type: string }
    optional: true
returns:
  schema: { type: array, items: !ref Money }`),
    );
    expect(codes(diagnostics)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE", "CONTRACT_NOT_SUBSTITUTABLE"]);
    expect(diagnostics[0]![1]).toContain("parameter 'value' does not accept the argument 'Billing.Pricer' declares");
    expect(diagnostics[1]![1]).toContain("`returns` replaces the result declared by 'Billing.Pricer'");
  });

  it("is compared through the named shapes of an abstract an imported library declares", async () => {
    const graph = await new Loader([
      inMemorySource({
        "/lib/telo.yaml": library(
          "Billing",
          `exports:
  kinds: [Pricer]
${abstract}`,
        ),
        "/app/telo.yaml": [
          "kind: Telo.Library",
          "metadata:",
          "  name: Shop",
          "  version: 0.1.0",
          "imports:",
          "  Billing: ../lib/telo.yaml",
          "---",
          "kind: Telo.JsonSchema",
          "metadata:",
          "  name: Other",
          "schema: { type: string }",
          "---",
          "kind: Telo.Definition",
          "metadata:",
          "  name: Native",
          "extends: Billing.Pricer",
          "deterministic: true",
          "params:",
          "  - name: value",
          "    schema: !ref Other",
          "returns:",
          "  schema: { type: array, items: { type: integer } }",
          "controllers:",
          "  - pkg:telo/local/js?path=./nowhere.mjs#Never",
          "",
        ].join("\n"),
      }),
    ]).loadGraph("/app/telo.yaml", { desugarImports: true });
    const diagnostics = new StaticAnalyzer()
      .analyze(flattenForAnalyzer(graph))
      .map((d) => [String(d.code), d.message] as [string, string]);
    expect(codes(diagnostics)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE", "CONTRACT_NOT_SUBSTITUTABLE"]);
    expect(diagnostics[0]![1]).toContain("parameter 'value' does not accept the argument 'Billing.Pricer' declares");
    expect(diagnostics[1]![1]).toContain("`returns` replaces the result declared by 'Billing.Pricer'");
  });

  it("is refused when a parameter is renamed, since a holder calls by the abstract's names", async () => {
    const diagnostics = await check(
      child(`params:
  - name: price
    schema: !ref Money
  - name: locale
    schema: { type: string }
    optional: true`),
    );
    expect(codes(diagnostics)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE"]);
    expect(diagnostics[0]![1]).toContain("parameter 'price' is named 'value' by 'Billing.Pricer'");
  });

  it("is refused when it requires an argument the abstract leaves optional", async () => {
    const diagnostics = await check(
      child(`params:
  - name: value
    schema: !ref Money
  - name: locale
    schema: { type: string }`),
    );
    expect(codes(diagnostics)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE"]);
    expect(diagnostics[0]![1]).toContain("requires 2 argument(s) while 'Billing.Pricer' requires only 1");
  });

  it("is refused when an implementation does not make the determinism the abstract requires", async () => {
    const diagnostics = await check(child("", ""));
    expect(codes(diagnostics)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE"]);
    expect(diagnostics[0]![1]).toContain("requires `deterministic: true` of every implementation");
  });
});
