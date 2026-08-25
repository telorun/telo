import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { readReferrerRules, rewriteReferrerRuleKinds } from "../src/referrer-rule.js";
import { PeerBinder } from "../src/peer-binding.js";
import {
  evaluateReferrerRules,
  referrerRuleExercised,
  reportReferrerRules,
  validateReferrerRuleDeclarations,
  type Referrer,
  type ReferrerRuleContext,
} from "../src/validate-referrer-rules.js";

/** Conditions are written with the `!cel` tag — the strict half reports one that
 *  is not, since untagged it stops being CEL to every surface but evaluation. */
const cel = (source: string) => makeTaggedSentinel("cel", source);

/** A docs-renderer kind: it needs the resource that mounts it to have collected
 *  an OpenAPI document. Filters are canonical here, as they are after
 *  `resolveSchemaRefKinds` has rewritten them in the declaring scope. */
const REFERENCE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  "x-telo-referrer-rules": [
    {
      referrer: "HttpServer.Server",
      condition: cel("has(referrer.openapi)"),
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
            condition: cel("referrer.openapi.info.title != ''"),
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
        { referrer: ["Self.Server"], condition: cel("true"), code: "C", message: "m" },
      ],
    });
    expect(messages.join(" ")).toContain("'referrer' names the kind");
  });

  it("rejects a duplicate rule code", () => {
    const messages = declarationMessages({
      "x-telo-referrer-rules": [
        { condition: cel("true"), code: "SAME", message: "m" },
        { condition: cel("true"), code: "SAME", message: "m" },
      ],
    });
    expect(messages.join(" ")).toContain("already used by rule 0");
  });

  it("rejects a non-deterministic condition", () => {
    const messages = declarationMessages({
      "x-telo-referrer-rules": [
        { condition: cel("nowMillis() > 0"), code: "C", message: "m" },
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
        { referrer: "Self.Server", condition: cel("true"), code: "A", message: "m" },
        { referrer: "Nope.Server", condition: cel("true"), code: "B", message: "m" },
        { condition: cel("true"), code: "C", message: "m" },
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

/**
 * Peer rules — `peers:` binds the referrer's OTHER entries, `entry` its own.
 * A schema listing tables and enums is the shape: `self` is one table, the
 * schema is the referrer, and what a rule needs to see is the siblings.
 */
describe("peer rules", () => {
  const TABLE_SCHEMA = {
    type: "object",
    properties: { table: { type: "string" }, renamedFrom: { type: "string" } },
    "x-telo-referrer-rules": [
      {
        referrer: "SQL.Schema",
        peers: "/tables",
        condition: cel(
          "!has(self.renamedFrom) || !peers.exists(p, p.table == self.renamedFrom)",
        ),
        code: "SQL_RENAME_SOURCE_STILL_DECLARED",
        message: "renames from a table this schema also declares",
      },
    ],
  };

  const tableDefinition = {
    kind: "Telo.Definition",
    metadata: { name: "Table", module: "SQL" },
    capability: "Telo.Provider",
    schema: TABLE_SCHEMA,
  } as unknown as ResourceManifest;

  const table = (config: Record<string, unknown>): ResourceManifest =>
    ({ kind: "SQL.Table", metadata: { name: config.table as string }, ...config }) as unknown as ResourceManifest;

  const ref = (name: string) => ({ kind: "SQL.Table", name });

  const schema = (...names: string[]): ResourceManifest =>
    ({
      kind: "SQL.Schema",
      metadata: { name: "appSchema" },
      tables: names.map(ref),
    }) as unknown as ResourceManifest;

  const peerMatches = (filter: string, kind: string): boolean => filter === kind;

  /** The referrer kind's ref-slot paths — the field map's answer, which is what
   *  decides which paths hold references. */
  const SHAPES: Record<string, string[]> = {
    "SQL.Schema": ["tables[]", "enums[]", "mounts[].mount"],
  };

  const declarations = (...tables: ResourceManifest[]): ReferrerRuleContext => {
    const byName = new Map(tables.map((t) => [t.metadata!.name as string, t]));
    return {
      peerBinder: new PeerBinder({
        declarationOf: (r) => byName.get(r.name),
        refSlotsOf: (kind) => SHAPES[kind],
      }),
    };
  };

  it("sees the schema's other entries, and not itself", () => {
    const messages = table({ table: "messages", renamedFrom: "chat_messages" });
    const legacy = table({ table: "chat_messages" });
    const listing = schema("messages", "chat_messages");

    const findings = evaluateReferrerRules(
      messages,
      TABLE_SCHEMA,
      [{ manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
      peerMatches,
      declarations(messages, legacy),
    );
    expect(findings).toMatchObject([{ kind: "violation", rule: { code: "SQL_RENAME_SOURCE_STILL_DECLARED" } }]);
  });

  it("holds once the predecessor is no longer declared", () => {
    const messages = table({ table: "messages", renamedFrom: "chat_messages" });
    const listing = schema("messages");
    expect(
      evaluateReferrerRules(
        messages,
        TABLE_SCHEMA,
        [{ manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
        peerMatches,
        declarations(messages),
      ),
    ).toEqual([]);
  });

  it("excludes self by SLOT PATH, so a table listed twice does not judge itself", () => {
    const messages = table({ table: "messages", renamedFrom: "messages" });
    const listing = schema("messages", "messages");
    // The rule reads `peers` only; the duplicate entry at index 1 IS still a
    // peer of the entry at index 0, which is the honest reading of "the other
    // entries" and what makes the exclusion an exact, per-site fact.
    const findings = evaluateReferrerRules(
      messages,
      TABLE_SCHEMA,
      [{ manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
      peerMatches,
      declarations(messages),
    );
    expect(findings).toHaveLength(1);
  });

  it("evaluates once per ENTRY, not once per referrer", () => {
    const messages = table({ table: "messages", renamedFrom: "chat_messages" });
    const legacy = table({ table: "chat_messages" });
    const listing = schema("messages", "chat_messages", "messages");
    const findings = evaluateReferrerRules(
      messages,
      TABLE_SCHEMA,
      [
        { manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" },
        { manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[2]" },
      ],
      peerMatches,
      declarations(messages, legacy),
    );
    expect(findings).toHaveLength(2);
  });

  it("binds `entry` from the slot path — a mount's own fields beside its target", () => {
    const MOUNT_SCHEMA = {
      type: "object",
      "x-telo-referrer-rules": [
        {
          referrer: "SQL.Schema",
          peers: "/mounts",
          condition: cel("entry.prefix.startsWith('/')"),
          code: "MOUNT_PREFIX_ABSOLUTE",
          message: "mounts at a prefix that is not absolute",
        },
      ],
    };
    const api = table({ table: "api" });
    const server = {
      kind: "SQL.Schema",
      metadata: { name: "server" },
      mounts: [{ mount: ref("api"), prefix: "v1" }],
    } as unknown as ResourceManifest;

    const findings = evaluateReferrerRules(
      api,
      MOUNT_SCHEMA,
      [{ manifest: server, kind: "SQL.Schema", name: "server", path: "mounts[0].mount" }],
      peerMatches,
      declarations(api),
    );
    expect(findings).toMatchObject([{ kind: "violation", rule: { code: "MOUNT_PREFIX_ABSOLUTE" } }]);
  });

  it("reports rather than passes when a reference resolves to nothing", () => {
    const messages = table({ table: "messages", renamedFrom: "chat_messages" });
    const listing = schema("messages", "chat_messages");
    const findings = evaluateReferrerRules(
      messages,
      TABLE_SCHEMA,
      [{ manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
      peerMatches,
      declarations(messages),
    );
    expect(findings).toMatchObject([{ kind: "unbound", failure: { reason: "unresolved" } }]);
    expect(
      reportReferrerRules(messages, tableDefinition, findings, true).map((r) => r.code),
    ).toEqual(["REFERRER_RULE_SKIPPED"]);
  });

  it("binds an ABSENT collection as an empty one, so the rule still judges", () => {
    // A resource declaring none of an optional collection is the loudest case a
    // peer rule has — a table whose predecessor the schema lists nowhere — so
    // this must evaluate rather than skip.
    const messages = table({ table: "messages", renamedFrom: "chat_messages" });
    const listing = { kind: "SQL.Schema", metadata: { name: "appSchema" } } as unknown as ResourceManifest;
    expect(
      evaluateReferrerRules(
        messages,
        TABLE_SCHEMA,
        [{ manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
        peerMatches,
        declarations(messages),
      ),
    ).toEqual([]);
  });

  it("reports when the pointer names something that is not a collection", () => {
    const messages = table({ table: "messages" });
    const listing = {
      kind: "SQL.Schema",
      metadata: { name: "appSchema" },
      tables: "not-a-collection",
    } as unknown as ResourceManifest;
    expect(
      evaluateReferrerRules(
        messages,
        TABLE_SCHEMA,
        [{ manifest: listing, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
        peerMatches,
        declarations(messages),
      ),
    ).toMatchObject([{ kind: "unbound", failure: { reason: "no-collection" } }]);
  });

  it("is unexercised while every peer set is empty", () => {
    const rule = readReferrerRules(TABLE_SCHEMA)[0];
    const messages = table({ table: "messages" });
    const alone = schema("messages");
    const referrers = [
      { manifest: alone, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" },
    ];
    expect(referrerRuleExercised(rule, referrers, peerMatches, declarations(messages))).toBe(false);

    const legacy = table({ table: "chat_messages" });
    const both = schema("messages", "chat_messages");
    expect(
      referrerRuleExercised(
        rule,
        [{ manifest: both, kind: "SQL.Schema", name: "appSchema", path: "tables[0]" }],
        peerMatches,
        declarations(messages, legacy),
      ),
    ).toBe(true);
  });
});

describe("peer rules — declaration validation", () => {
  const peersRule = (extra: Record<string, unknown>) => ({
    "x-telo-referrer-rules": [
      {
        referrer: "SQL.Schema",
        condition: cel("true"),
        code: "C",
        message: "m",
        ...extra,
      },
    ],
  });

  it("accepts a pointer whose items are references", () => {
    expect(
      validateReferrerRuleDeclarations(definition(peersRule({ peers: "/tables" })), {
        peersTarget: () => "ok",
      }),
    ).toEqual([]);
  });

  it("refuses a `peers:` with no `referrer:` to check it against", () => {
    const messages = validateReferrerRuleDeclarations(
      definition({
        "x-telo-referrer-rules": [
          { peers: "/tables", condition: cel("true"), code: "C", message: "m" },
        ],
      }),
      { peersTarget: () => "ok" },
    ).map((i) => i.message);
    expect(messages.join(" ")).toContain("must also declare 'referrer:'");
  });

  it("refuses a collection the referrer kind does not declare", () => {
    const messages = validateReferrerRuleDeclarations(definition(peersRule({ peers: "/tabels" })), {
      peersTarget: () => "absent",
    }).map((i) => i.message);
    expect(messages.join(" ")).toContain("declares no collection at '/tabels'");
  });

  it("refuses a collection of plain data — nothing in it resolves", () => {
    const messages = validateReferrerRuleDeclarations(definition(peersRule({ peers: "/labels" })), {
      peersTarget: () => "plain",
    }).map((i) => i.message);
    expect(messages.join(" ")).toContain("holds plain data");
  });

  it("says nothing when the referrer kind is not resolvable here", () => {
    expect(
      validateReferrerRuleDeclarations(definition(peersRule({ peers: "/tables" })), {
        peersTarget: () => "unknown",
      }),
    ).toEqual([]);
  });

  it("reports an untagged condition while the rule still runs", () => {
    const messages = declarationMessages({
      "x-telo-referrer-rules": [{ condition: "has(referrer.openapi)", code: "C", message: "m" }],
    });
    expect(messages.join(" ")).toContain("!cel tag");
    expect(readReferrerRules({
      "x-telo-referrer-rules": [{ condition: "has(referrer.openapi)", code: "C", message: "m" }],
    })).toHaveLength(1);
  });
});

/** The three ways a peer binding was wrong before it consulted the field map. */
describe("peer rules — binding", () => {
  const SHAPES: Record<string, string[]> = {
    "SQL.Schema": ["tables[]", "tables.{}", "notes[].about"],
  };
  const table = (config: Record<string, unknown>): ResourceManifest =>
    ({ kind: "SQL.Table", metadata: { name: config.name as string }, ...config }) as unknown as ResourceManifest;
  const ref = (name: string) => ({ kind: "SQL.Table", name });
  const matches = (filter: string, kind: string) => filter === kind;
  const binder = (...tables: ResourceManifest[]): ReferrerRuleContext => {
    const byName = new Map(tables.map((t) => [t.metadata!.name as string, t]));
    return {
      peerBinder: new PeerBinder({
        declarationOf: (r) => byName.get(r.name),
        refSlotsOf: (kind) => SHAPES[kind],
      }),
    };
  };
  const DUPLICATE = {
    type: "object",
    "x-telo-referrer-rules": [
      {
        referrer: "SQL.Schema",
        peers: "/tables",
        condition: cel("!peers.exists(p, p.table == self.table)"),
        code: "DUP",
        message: "duplicates a table this schema also declares",
      },
    ],
  };

  it("excludes self by KEY in a map-valued collection", () => {
    const a = table({ name: "a", table: "a" });
    const b = table({ name: "b", table: "b" });
    const listing = {
      kind: "SQL.Schema",
      metadata: { name: "s" },
      tables: { a: ref("a"), b: ref("b") },
    } as unknown as ResourceManifest;
    expect(
      evaluateReferrerRules(
        a,
        DUPLICATE,
        [{ manifest: listing, kind: "SQL.Schema", name: "s", path: "tables.a" }],
        matches,
        binder(a, b),
      ),
    ).toEqual([]);
  });

  it("still reports a genuine duplicate in a map-valued collection", () => {
    const a = table({ name: "a", table: "same" });
    const b = table({ name: "b", table: "same" });
    const listing = {
      kind: "SQL.Schema",
      metadata: { name: "s" },
      tables: { a: ref("a"), b: ref("b") },
    } as unknown as ResourceManifest;
    expect(
      evaluateReferrerRules(
        a,
        DUPLICATE,
        [{ manifest: listing, kind: "SQL.Schema", name: "s", path: "tables.a" }],
        matches,
        binder(a, b),
      ),
    ).toMatchObject([{ kind: "violation" }]);
  });

  it("skips and reports when a peer declaration holds a `!cel`", () => {
    const a = table({ name: "a", table: "a" });
    const b = table({ name: "b", table: cel("variables.suffix") });
    const listing = {
      kind: "SQL.Schema",
      metadata: { name: "s" },
      tables: [ref("a"), ref("b")],
    } as unknown as ResourceManifest;
    const findings = evaluateReferrerRules(
      a,
      DUPLICATE,
      [{ manifest: listing, kind: "SQL.Schema", name: "s", path: "tables[0]" }],
      matches,
      binder(a, b),
    );
    expect(findings).toMatchObject([{ kind: "unbound", failure: { reason: "dynamic" } }]);
  });

  it("does not read author data shaped like a reference as one", () => {
    // `notes[].about` is the only reference under `notes`; `notes[].label`
    // carrying `kind` and `name` is plain data, and resolving it would compare
    // against an unrelated manifest.
    const SHAPE_RULE = {
      type: "object",
      "x-telo-referrer-rules": [
        {
          referrer: "SQL.Schema",
          peers: "/notes",
          condition: cel("peers.all(p, p.label.name == 'plain')"),
          code: "NOTE",
          message: "note",
        },
      ],
    };
    const a = table({ name: "a", table: "a" });
    const listing = {
      kind: "SQL.Schema",
      metadata: { name: "s" },
      notes: [
        { about: ref("a"), label: { kind: "colour", name: "plain" } },
        { about: ref("a"), label: { kind: "colour", name: "plain" } },
      ],
    } as unknown as ResourceManifest;
    expect(
      evaluateReferrerRules(
        a,
        SHAPE_RULE,
        [{ manifest: listing, kind: "SQL.Schema", name: "s", path: "notes[0].about" }],
        matches,
        binder(a),
      ),
    ).toEqual([]);
  });

  it("binds nothing when the referrer kind's shape is unknown", () => {
    const a = table({ name: "a", table: "a" });
    const listing = {
      kind: "Other.Holder",
      metadata: { name: "s" },
      tables: [ref("a")],
    } as unknown as ResourceManifest;
    expect(
      evaluateReferrerRules(
        a,
        DUPLICATE,
        [{ manifest: listing, kind: "Other.Holder", name: "s", path: "tables[0]" }],
        () => true,
        binder(a),
      ),
    ).toMatchObject([{ kind: "unbound", failure: { reason: "unknown-shape" } }]);
  });
});
