import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { readReferrerRules, rewriteReferrerRuleKinds } from "../src/referrer-rule.js";
import {
  evaluateReferrerRules,
  referrerRuleExercised,
  reportReferrerRules,
  validateReferrerRuleDeclarations,
  type Referrer,
} from "../src/validate-referrer-rules.js";

/** A docs-renderer kind: it needs the resource that mounts it to have collected
 *  an OpenAPI document. Filters are canonical here, as they are after
 *  `resolveSchemaRefKinds` has rewritten them in the declaring scope. */
const REFERENCE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  "x-telo-referrer-rules": [
    {
      referrer: "HttpServer.Server",
      condition: "has(referrer.openapi)",
      code: "REFERENCE_WITHOUT_OPENAPI",
      message: "declares no `openapi:` block",
    },
  ],
};

const definition = (schema: unknown): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Reference", module: "HttpServer" },
    capability: "Telo.Mount",
    schema,
  }) as unknown as ResourceManifest;

const reference = (): ResourceManifest =>
  ({ kind: "Http.Reference", metadata: { name: "docs" } }) as unknown as ResourceManifest;

const server = (config: Record<string, unknown>, name = "server"): ResourceManifest =>
  ({ kind: "Http.Server", metadata: { name }, ...config }) as unknown as ResourceManifest;

const referrer = (manifest: ResourceManifest, path = "mounts[1].mount"): Referrer => ({
  manifest,
  kind: manifest.kind,
  name: manifest.metadata?.name as string,
  path,
});

/** The analyzer resolves a referring manifest's own `kind:` through its module's
 *  aliases before comparing; here `Http` is that alias. */
const kindMatches = (filter: string, kind: string): boolean =>
  filter === kind.replace(/^Http\./, "HttpServer.");

const declarationMessages = (schema: unknown): string[] =>
  validateReferrerRuleDeclarations(definition(schema)).map((i) => i.message);

describe("referrer rules — evaluation", () => {
  it("reports the REFERRER, at the slot it reaches through", () => {
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer(server({ port: 8080 }))],
      kindMatches,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "violation",
      referrer: { kind: "Http.Server", name: "server", path: "mounts[1].mount" },
    });
  });

  it("holds when the referrer satisfies the condition", () => {
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer(server({ port: 8080, openapi: { info: { title: "T", version: "1" } } }))],
      kindMatches,
    );
    expect(findings).toEqual([]);
  });

  it("judges only referrers the filter matches", () => {
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer({ kind: "Other.Holder", metadata: { name: "holder" } } as ResourceManifest)],
      kindMatches,
    );
    expect(findings).toEqual([]);
  });

  it("judges a referrer once however many slots reach the resource", () => {
    const one = server({ port: 8080 });
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer(one, "mounts[0].mount"), referrer(one, "mounts[3].mount")],
      kindMatches,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ referrer: { path: "mounts[0].mount" } });
  });

  it("judges two same-named referrers from different modules separately", () => {
    // Resource names are module-scoped, so a `(kind, name)` key would collapse
    // these two and drop the second violation in silence.
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer(server({ port: 8080 })), referrer(server({ port: 9090 }))],
      kindMatches,
    );
    expect(findings).toHaveLength(2);
  });

  it("reports the skip when a value the condition reads holds CEL", () => {
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer(server({ openapi: { __compiled: true, source: "variables.doc" } }))],
      kindMatches,
    );
    expect(findings[0]).toMatchObject({ kind: "skipped" });
  });

  it("does not skip on an unrelated expression elsewhere in the referrer", () => {
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [
        referrer(
          server({
            port: { __compiled: true, source: "ports.http" },
            openapi: { info: { title: "T", version: "1" } },
          }),
        ),
      ],
      kindMatches,
    );
    expect(findings).toEqual([]);
  });

  it("reports a throwing rule as a defect in the rule", () => {
    const findings = evaluateReferrerRules(
      reference(),
      {
        "x-telo-referrer-rules": [
          {
            referrer: "HttpServer.Server",
            condition: "referrer.openapi.info.title != ''",
            code: "BOOM",
            message: "…",
          },
        ],
      },
      [referrer(server({ port: 8080 }))],
      kindMatches,
    );
    expect(findings[0]).toMatchObject({ kind: "failed" });
  });

  it("says nothing when the kind declares no rules", () => {
    expect(
      evaluateReferrerRules(reference(), { type: "object" }, [referrer(server({}))], kindMatches),
    ).toEqual([]);
  });
});

describe("referrer rules — reporting", () => {
  it("anchors the violation on the referrer and names the declaring kind", () => {
    const findings = evaluateReferrerRules(
      reference(),
      REFERENCE_SCHEMA,
      [referrer(server({ port: 8080 }))],
      kindMatches,
    );
    const [report] = reportReferrerRules(reference(), definition(REFERENCE_SCHEMA), findings, true);
    expect(report.code).toBe("REFERRER_RULE_VIOLATED");
    expect(report.manifest.kind).toBe("Http.Server");
    expect(report.path).toBe("mounts[1].mount");
    expect(report.message).toContain("required by Http.Reference");
    expect(report.rule).toBe("REFERENCE_WITHOUT_OPENAPI");
  });

  it("anchors a defect in the rule on the declaring definition", () => {
    const [report] = reportReferrerRules(
      reference(),
      definition(REFERENCE_SCHEMA),
      [
        {
          kind: "failed",
          rule: readReferrerRules(REFERENCE_SCHEMA)[0],
          reason: "no such member",
        },
      ],
      true,
    );
    expect(report.code).toBe("REFERRER_RULE_INVALID");
    expect(report.manifest.kind).toBe("Telo.Definition");
    expect(report.path).toBe("schema.x-telo-referrer-rules[0]");
  });

  it("downgrades a dependency's broken rule to a warning, anchored where the path exists", () => {
    const offending = server({ port: 8080 });
    const [report] = reportReferrerRules(
      reference(),
      definition(REFERENCE_SCHEMA),
      [
        {
          kind: "failed",
          rule: readReferrerRules(REFERENCE_SCHEMA)[0],
          referrer: referrer(offending),
          reason: "boom",
        },
      ],
      false,
    );
    expect(report.severity).toBe("warning");
    // The manifest and the path have to move together: `mounts[1].mount` is a
    // path in the REFERRER, and naming it on any other manifest anchors the
    // diagnostic at a node that does not exist there.
    expect(report.manifest).toBe(offending);
    expect(report.path).toBe("mounts[1].mount");
  });

  it("falls back to the referenced resource with no path when there is no referrer", () => {
    const [report] = reportReferrerRules(
      reference(),
      definition(REFERENCE_SCHEMA),
      [{ kind: "failed", rule: readReferrerRules(REFERENCE_SCHEMA)[0], reason: "will not parse" }],
      false,
    );
    expect(report.manifest.kind).toBe("Http.Reference");
    expect(report.path).toBeUndefined();
  });
});

describe("referrer rules — exercise tracking", () => {
  it("is unexercised when nothing the filter matches references the kind", () => {
    const rule = readReferrerRules(REFERENCE_SCHEMA)[0];
    expect(referrerRuleExercised(rule, [], kindMatches)).toBe(false);
    expect(
      referrerRuleExercised(
        rule,
        [referrer({ kind: "Other.Holder", metadata: { name: "h" } } as ResourceManifest)],
        kindMatches,
      ),
    ).toBe(false);
    expect(referrerRuleExercised(rule, [referrer(server({}))], kindMatches)).toBe(true);
  });
});

describe("referrer rules — declaration validation", () => {
  it("accepts the reference rule", () => {
    expect(declarationMessages(REFERENCE_SCHEMA)).toEqual([]);
  });

  it("requires condition, code and message", () => {
    const messages = declarationMessages({ "x-telo-referrer-rules": [{}] });
    expect(messages).toHaveLength(3);
  });

  it("rejects a non-string referrer filter", () => {
    const messages = declarationMessages({
      "x-telo-referrer-rules": [
        { referrer: ["Self.Server"], condition: "true", code: "C", message: "m" },
      ],
    });
    expect(messages.join(" ")).toContain("'referrer' names the kind");
  });

  it("rejects a duplicate rule code", () => {
    const messages = declarationMessages({
      "x-telo-referrer-rules": [
        { condition: "true", code: "SAME", message: "m" },
        { condition: "true", code: "SAME", message: "m" },
      ],
    });
    expect(messages.join(" ")).toContain("already used by rule 0");
  });

  it("rejects a non-deterministic condition", () => {
    const messages = declarationMessages({
      "x-telo-referrer-rules": [
        { condition: "nowMillis() > 0", code: "C", message: "m" },
      ],
    });
    expect(messages.join(" ")).toContain("re-evaluates per call");
  });

  it("rejects a non-array annotation", () => {
    expect(declarationMessages({ "x-telo-referrer-rules": {} }).join(" ")).toContain(
      "must be an array of rules",
    );
  });
});

describe("referrer rules — filter canonicalization", () => {
  it("rewrites each filter in place and leaves an unresolved one as written", () => {
    const node = {
      "x-telo-referrer-rules": [
        { referrer: "Self.Server", condition: "true", code: "A", message: "m" },
        { referrer: "Nope.Server", condition: "true", code: "B", message: "m" },
        { condition: "true", code: "C", message: "m" },
      ],
    } as Record<string, unknown>;
    const seen: string[] = [];
    rewriteReferrerRuleKinds(node, (kind) => {
      seen.push(kind);
      return kind === "Self.Server" ? "HttpServer.Server" : undefined;
    });
    expect(seen).toEqual(["Self.Server", "Nope.Server"]);
    expect(readReferrerRules(node).map((r) => r.referrer)).toEqual([
      "HttpServer.Server",
      "Nope.Server",
      undefined,
    ]);
  });
});
