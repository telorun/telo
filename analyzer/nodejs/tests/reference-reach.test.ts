import { describe, expect, it } from "vitest";
import type { RefSlot } from "../src/ref-slot.js";
import { buildDrivenSlotMap } from "../src/reference-field-map.js";
import {
  declaredReach,
  reachOfSchema,
  reachSites,
  type ReachSite,
  type SchemaFromResolver,
} from "../src/reference-reach.js";
import { forEachDrivenSlot } from "../src/schema-walk.js";

const slot = (kind: string) => ({ "x-telo-ref": { kind, use: "call" } });
const target = (name: string) => ({ kind: "std.Handler", name });

function referenceRefSites(sites: ReachSite[]): Map<string, RefSlot[]> {
  return new Map(
    sites.filter((s) => s.refs.length > 0).map((s) => [s.path, s.refs.map((r) => r.slot)]),
  );
}

function throwsRefSites(schema: Record<string, any>, data: unknown): Map<string, RefSlot[]> {
  const out = new Map<string, RefSlot[]>();
  forEachDrivenSlot(schema, data, (driven) => {
    if (driven.kind === "ref") out.set(driven.path, driven.slots.map((s) => s.slot));
  });
  return out;
}

const defsKind = {
  type: "object",
  properties: { target: { $ref: "#/$defs/Target" } },
  $defs: { Target: slot("std.A") },
};

const rootAnyOfKind = {
  type: "object",
  anyOf: [
    { required: ["target"], properties: { target: slot("std.A") } },
    { properties: { target: slot("std.B"), other: slot("std.C") } },
  ],
};

const rootMapKind = {
  type: "object",
  properties: { fixed: slot("std.A"), plain: { type: "string" } },
  additionalProperties: slot("std.B"),
};

const recursiveKind = {
  type: "object",
  $defs: {
    Node: {
      type: "object",
      properties: {
        handler: slot("std.A"),
        children: { type: "array", items: { $ref: "#/$defs/Node" } },
      },
    },
  },
  properties: { tree: { $ref: "#/$defs/Node" } },
};

const stopsKind = {
  type: "object",
  properties: {
    handler: slot("std.A"),
    with: {
      "x-telo-scope": "/with",
      type: "array",
      items: { type: "object", properties: { inner: slot("std.A") } },
    },
    steps: {
      type: "array",
      "x-telo-step-context": { invoke: "invoke" },
      items: { type: "object", properties: { invoke: slot("std.A") } },
    },
  },
};

const recursiveData = (() => {
  const c1: Record<string, unknown> = { handler: target("c1") };
  const c2: Record<string, unknown> = { handler: target("c2"), children: [c1] };
  c1.children = [c2];
  return { tree: { handler: target("root"), children: [c1] } };
})();

const fixtures: Array<[string, Record<string, any>, unknown, string[]]> = [
  ["a slot behind a local $ref", defsKind, { target: target("a") }, ["target"]],
  [
    "slots in root anyOf branches",
    rootAnyOfKind,
    { target: target("a"), other: target("b") },
    ["target", "other"],
  ],
  [
    "a root additionalProperties slot, declared keys and the envelope skipped",
    rootMapKind,
    {
      kind: "std.Relay",
      metadata: { name: "relay" },
      fixed: target("a"),
      plain: "text",
      extra: target("b"),
    },
    ["fixed", "extra"],
  ],
  [
    "a recursive slot, to data depth, with a datum aliasing its ancestor",
    recursiveKind,
    recursiveData,
    ["tree.handler", "tree.children[0].handler", "tree.children[0].children[0].handler"],
  ],
  [
    "a scope stop and a step stop",
    stopsKind,
    { handler: target("a"), with: [{ inner: target("b") }], steps: [{ invoke: target("c") }] },
    ["handler"],
  ],
];

describe("reference enumeration without schema-from", () => {
  it.each(fixtures)("equals the throws walk's ref sites: %s", (_label, schema, data, paths) => {
    const reference = referenceRefSites(reachSites(schema, data));
    expect([...reference.keys()]).toEqual(paths);
    expect(reference).toEqual(throwsRefSites(schema, data));
  });

  it("unions every branch's slot at one site", () => {
    const sites = referenceRefSites(reachSites(rootAnyOfKind, { target: target("a") }));
    expect(sites.get("target")!.map((s) => s.kinds)).toEqual([["std.A"], ["std.B"]]);
  });

  it("reports a scope stop's concrete site", () => {
    const sites = reachSites(stopsKind, { with: [{ inner: target("b") }] });
    expect(sites.filter((s) => s.scopes.length > 0).map((s) => s.path)).toEqual(["with"]);
  });

  it("is the reach the throws view reads, memoized per schema", () => {
    expect(buildDrivenSlotMap(defsKind)).toBe(reachOfSchema(defsKind));
  });
});

// The Http.Server not-found handler's `returns`, borrowed from
// `HttpDispatch.Outcomes/$defs/Returns`.
const outcomes = {
  type: "object",
  $defs: {
    Returns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "integer" },
          mode: { type: "string", enum: ["buffer", "stream"] },
          content: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: { body: {}, encoder: slot("Codec.Encoder") },
            },
          },
        },
        required: ["status"],
        oneOf: [
          {
            properties: {
              content: {
                type: "object",
                additionalProperties: { type: "object", not: { required: ["encoder"] } },
              },
            },
          },
          {
            properties: {
              mode: { const: "stream" },
              content: {
                type: "object",
                additionalProperties: { type: "object", required: ["encoder"] },
              },
            },
            required: ["mode", "content"],
          },
        ],
      },
    },
  },
};

const serverKind = {
  type: "object",
  properties: {
    port: { type: "integer" },
    notFoundHandler: {
      type: "object",
      properties: {
        invoke: slot("Telo.Invocable"),
        returns: { "x-telo-schema-from": "HttpDispatch.Outcomes/$defs/Returns" },
      },
    },
  },
};

const serverResolver: SchemaFromResolver = (expression, document) =>
  document === serverKind && expression === "HttpDispatch.Outcomes/$defs/Returns"
    ? { document: outcomes, node: outcomes.$defs.Returns }
    : undefined;

const server = {
  kind: "Http.Server",
  metadata: { name: "server" },
  port: 8080,
  notFoundHandler: {
    invoke: target("notFound"),
    returns: [
      { status: 404, content: { "application/json": { body: {} } } },
      {
        status: 200,
        mode: "stream",
        content: {
          "application/x-ndjson": { encoder: target("ndjson") },
          "text/plain": { encoder: target("text") },
        },
      },
    ],
  },
};

describe("reference enumeration with a static schema-from slot", () => {
  const pattern = "notFoundHandler.returns";
  const below = (path: string) => path.startsWith(`${pattern}[`) || path.startsWith(`${pattern}.`);

  it("is the throws walk's ref sites plus the anchor's", () => {
    const sites = reachSites(serverKind, server, serverResolver);
    const reference = referenceRefSites(sites);
    const throws = throwsRefSites(serverKind, server);
    expect([...throws.keys()].filter(below)).toEqual([]);
    const expansion = sites.filter((s) => s.refs.length > 0 && below(s.path));
    expect(expansion.map((s) => s.path)).toEqual([
      "notFoundHandler.returns[1].content.application/x-ndjson.encoder",
      "notFoundHandler.returns[1].content.text/plain.encoder",
    ]);
    for (const site of expansion) {
      for (const ref of site.refs) {
        expect(ref.declaredIn.document).toBe(outcomes);
        expect(ref.fieldPath).toBe("notFoundHandler.returns[].content.{}.encoder");
      }
    }
    expect(reference).toEqual(
      new Map([...throws, ...expansion.map((s) => [s.path, s.refs.map((r) => r.slot)] as const)]),
    );
  });

  it("resolves the anchor's local $ref against the anchor definition's whole schema", () => {
    const anchorDocument = {
      $defs: {
        Entry: { type: "object", properties: { encoder: { $ref: "#/$defs/Encoder" } } },
        Encoder: slot("Codec.Encoder"),
      },
    };
    const kind = { type: "object", properties: { entry: { "x-telo-schema-from": "A.B/$defs/Entry" } } };
    const sites = reachSites(kind, { entry: { encoder: target("e") } }, () => ({
      document: anchorDocument,
      node: anchorDocument.$defs.Entry,
    }));
    expect(sites.map((s) => s.path)).toEqual(["entry.encoder"]);
  });
});

describe("declared-slot view", () => {
  const paths = (schema: Record<string, any>, resolver?: SchemaFromResolver) =>
    declaredReach(schema, resolver).references.map((r) => r.path);

  it("lists a slot behind a local $ref", () => {
    expect(paths(defsKind)).toEqual(["target"]);
  });

  it("lists both root anyOf branches' slots, kinds unioned at a shared pattern", () => {
    const { references } = declaredReach(rootAnyOfKind);
    expect(references.map((r) => [r.path, r.kinds])).toEqual([
      ["target", ["std.A", "std.B"]],
      ["other", ["std.C"]],
    ]);
  });

  it("lists a recursive slot at its outermost occurrence only", () => {
    expect(paths(recursiveKind)).toEqual(["tree.handler"]);
  });

  it("lists a static schema-from anchor's slots under the stop's pattern", () => {
    const encoder = declaredReach(serverKind, serverResolver).references.find((r) =>
      r.path.endsWith("encoder"),
    );
    expect(encoder).toMatchObject({
      path: "notFoundHandler.returns[].content.{}.encoder",
      isArray: true,
      kinds: ["Codec.Encoder"],
    });
  });
});
