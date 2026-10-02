import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";
import type { JsonSchemaNode } from "../src/json-schema-type.js";

const REQUEST: JsonSchemaNode = {
  type: "object",
  properties: {
    query: {
      type: "object",
      properties: {
        limit: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { type: ["object", "null"], properties: { id: { type: "string" } } },
    anything: { type: "object", additionalProperties: true, properties: { known: { type: "integer" } } },
    either: { anyOf: [{ type: "string" }, { type: "integer" }] },
  },
};

function environment(): CelEnvironment {
  return new CelEnvironment().registerVariable("request", { schema: REQUEST });
}

describe("a variable typed from a schema", () => {
  it("is typed to full depth, unions carried as unions", () => {
    const check = (source: string) => environment().check(source).typeName;
    expect(check("request")).toBe("map");
    expect(check("request.query")).toBe("map");
    expect(check("request.query.limit")).toBe("int");
    expect(check("request.query.tags")).toBe("list<string>");
    expect(check("request.query.tags[0]")).toBe("string");
    expect(check("request.headers")).toBe("map<string, string>");
    expect(check("request.headers['accept']")).toBe("string");
    expect(check("request.either")).toBe("string|int");
  });

  it("makes a typo two levels in a ranged error naming what is declared", () => {
    const result = environment().check("request.query.limti");
    expect(result.diagnostics).toEqual([
      {
        code: "CEL_UNKNOWN_FIELD",
        message: '"limti" is not declared here (declared: limit, tags)',
        range: [14, 19],
      },
    ]);
  });

  it("reaches a host's own property name because it is undeclared, not because of its name", () => {
    const result = environment().check("request.__proto__");
    expect(result.diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
    expect(result.diagnostics[0]?.range).toEqual([8, 17]);
    // The same verdict, from the same rule, for a name with nothing special about it.
    expect(environment().check("request.whatever").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
  });

  it("judges nothing below a schema that says a name may be anything", () => {
    const check = (source: string) => environment().check(source);
    expect(check("request.anything.known").typeName).toBe("int");
    expect(check("request.anything.unknown").valid).toBe(true);
    expect(check("request.anything.unknown.deeper").typeName).toBe("dyn");
  });

  it("reports a dereference of a nullable field, and takes the guard it is given", () => {
    const unguarded = environment().check("request.body.id");
    expect(unguarded.diagnostics).toEqual([
      {
        code: "CEL_NULLABLE_ACCESS",
        message:
          '"request.body" may be null — guard it (e.g. \'request.body != null && …\' or \'request.body == null ? … : request.body.id\') before reading .id',
        range: [13, 15],
      },
    ]);
    for (const guarded of [
      "request.body != null && request.body.id == 'x'",
      "request.body == null || request.body.id == 'x'",
      "request.body != null ? request.body.id : 'x'",
      "request.body == null ? 'x' : request.body.id",
      "!(request.body == null) && request.body.id == 'x'",
    ]) {
      expect(environment().check(guarded).diagnostics, guarded).toEqual([]);
    }
    // Exactly three constructs prove it: a guard written as a call proves nothing.
    const byCall = environment()
      .clone()
      .registerFunction("present(dyn): bool")
      .check("present(request.body) && request.body.id == 'x'");
    expect(byCall.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["CEL_NULLABLE_ACCESS"]);
  });

  it("still accepts a flat field map, so a host can type exactly as shallowly as it must", () => {
    const shallow = new CelEnvironment().registerVariable("self", {
      fields: { columns: "map", name: "string" },
    });
    expect(shallow.check("self.columns.anything.at.all").typeName).toBe("dyn");
    expect(shallow.check("self.name").typeName).toBe("string");
    expect(shallow.check("self.nmae").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
    const nested = new CelEnvironment().registerVariable("self", {
      fields: { columns: { fields: { id: "string" } } },
    });
    expect(nested.check("self.columns.id").typeName).toBe("string");
    expect(nested.check("self.columns.di").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
  });

  it("asks the host's resolver at every node, before the structure is read", () => {
    const seen: string[] = [];
    const environment = new CelEnvironment({
      resolveSchemaType: ({ node }) => {
        const marker = (node as { brand?: string }).brand;
        if (marker) seen.push(marker);
        return marker ? { name: marker } : undefined;
      },
    })
      .registerType({ name: "Port", base: "int" })
      .registerVariable("config", {
        schema: {
          type: "object",
          properties: {
            // The resolver wins over `type: "object"`, which is what "before the
            // structural rules" means.
            port: { type: "object", properties: { ignored: { type: "string" } }, brand: "Port" },
            name: { type: "string" },
          },
        },
      });
    expect(seen).toEqual(["Port"]);
    expect(environment.check("config.port").typeName).toBe("Port");
    expect(environment.check("config.port.ignored").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
    expect(environment.check("config.name").typeName).toBe("string");
  });
});

describe("a reference", () => {
  const WITH_LOCAL_REF: JsonSchemaNode = {
    type: "object",
    properties: { user: { $ref: "#/$defs/User" } },
    $defs: {
      User: { type: "object", properties: { name: { type: "string" }, email: { type: "string" } } },
    },
  };

  it("is followed inside its own document, so a typo two levels in is a ranged error", () => {
    const typed = new CelEnvironment().registerVariable("subject", { schema: WITH_LOCAL_REF });
    expect(typed.check("subject.user.name").typeName).toBe("string");
    expect(typed.check("subject.user.nmae").diagnostics).toEqual([
      {
        code: "CEL_UNKNOWN_FIELD",
        message: '"nmae" is not declared here (declared: name, email)',
        range: [13, 17],
      },
    ]);
    expect(typed.schemaReports()).toEqual([]);
  });

  it("is read against the document a node belongs to, not against the node registered", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: WITH_LOCAL_REF.properties!.user!,
      document: WITH_LOCAL_REF,
    });
    expect(typed.check("subject.email").typeName).toBe("string");
  });

  it("leaving the document is answered by the host, with the document to read instead", () => {
    const shared: JsonSchemaNode = {
      $defs: { Id: { type: "object", properties: { value: { type: "string" }, note: { not: {} } } } },
    };
    const typed = new CelEnvironment({
      resolveSchemaType: ({ node }) =>
        node.$ref === "shared.json#/$defs/Id"
          ? { document: { node: (shared.$defs as Record<string, JsonSchemaNode>).Id!, root: shared } }
          : undefined,
    }).registerVariable("subject", {
      schema: { type: "object", properties: { id: { $ref: "shared.json#/$defs/Id" } } },
    });
    expect(typed.check("subject.id.value").typeName).toBe("string");
    expect(typed.check("subject.id.vlaue").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
    // A node beyond the document the conversion was given reports where the reference
    // that led out of it stands, so a consumer can anchor a diagnostic at a line it has.
    expect(typed.schemaReports()).toEqual([
      {
        name: "subject",
        unjudged: [
          {
            pointer: "/properties/note",
            throughReference: "/properties/id",
            keywords: ["not"],
            reason: "keyword-not-read",
          },
        ],
        recursive: [],
      },
    ]);
  });

  it("the host does not answer is reported by pointer, never typed dyn in silence", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: { type: "object", properties: { id: { $ref: "shared.json#/$defs/Id" } } },
    });
    expect(typed.check("subject.id.anything").typeName).toBe("dyn");
    expect(typed.schemaReports()).toEqual([
      {
        name: "subject",
        unjudged: [{ pointer: "/properties/id", keywords: ["$ref"], reason: "reference-unresolved" }],
        recursive: [],
      },
    ]);
  });

  it("naming nothing in its own document is reported the same way", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: { type: "object", properties: { id: { $ref: "#/$defs/Missing" } } },
    });
    expect(typed.schemaReports()[0]?.unjudged).toEqual([
      { pointer: "/properties/id", keywords: ["$ref"], reason: "reference-unresolved" },
    ]);
  });

  it("re-entered on the descent terminates, declared as recursive rather than reported", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: {
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: { name: { type: "string" }, child: { $ref: "#/$defs/Node" } },
          },
        },
      },
    });
    expect(typed.check("subject.name").typeName).toBe("string");
    expect(typed.check("subject.child.child.name").typeName).toBe("dyn");
    expect(typed.schemaReports()).toEqual([
      {
        name: "subject",
        unjudged: [],
        recursive: [{ pointer: "/$defs/Node", reference: "#/$defs/Node" }],
      },
    ]);
  });
});

describe("what a node says about its own type", () => {
  it("composes with allOf: a field of each half is read, a third is not declared", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: {
        allOf: [
          { type: "object", properties: { left: { type: "string" } } },
          { type: "object", properties: { right: { type: "integer" } } },
        ],
      },
    });
    expect(typed.check("subject.left").typeName).toBe("string");
    expect(typed.check("subject.right").typeName).toBe("int");
    expect(typed.check("subject.absent").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
    expect(typed.schemaReports()).toEqual([]);
  });

  it("intersects a reference with what the node says beside it", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: {
        $ref: "#/$defs/Named",
        type: "object",
        properties: { count: { type: "integer" } },
        $defs: { Named: { type: "object", properties: { name: { type: "string" } } } },
      },
    });
    expect(typed.check("subject.name").typeName).toBe("string");
    expect(typed.check("subject.count").typeName).toBe("int");
  });

  it("reports two things it says that cannot both hold", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: { allOf: [{ type: "string" }, { type: "integer" }] },
    });
    expect(typed.check("subject").typeName).toBe("dyn");
    expect(typed.schemaReports()[0]?.unjudged).toEqual([
      { pointer: "", keywords: ["allOf"], reason: "intersection-empty" },
    ]);
  });

  it("types a constant and an enumeration from their values, beside a host-typed branch", () => {
    const typed = new CelEnvironment({
      resolveSchemaType: ({ node }) => ((node as { brand?: string }).brand ? { name: "Path" } : undefined),
    })
      .registerType({ name: "Path", base: "string" })
      .registerVariable("file", {
        schema: { anyOf: [{ const: ":memory:" }, { brand: "Path" }] },
      })
      .registerVariable("mode", { schema: { enum: ["read", 1, null] } });
    expect(typed.check("file").typeName).toBe("string|Path");
    expect(typed.check("mode").typeName).toBe("string|int|null");
    expect(typed.schemaReports()).toEqual([]);
  });

  it("reports a keyword it has no rule for, beside the type it did produce", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: {
        type: "object",
        properties: {
          name: { type: "string", not: { const: "root" } },
          pair: { type: "array", items: [{ type: "string" }, { type: "integer" }] },
          either: { if: { type: "string" }, then: { type: "string" }, else: { type: "integer" } },
        },
      },
    });
    // What it could read, it still read.
    expect(typed.check("subject.name").typeName).toBe("string");
    expect(typed.check("subject.pair").typeName).toBe("list");
    expect(typed.schemaReports()[0]?.unjudged).toEqual([
      { pointer: "/properties/name", keywords: ["not"], reason: "keyword-not-read" },
      { pointer: "/properties/pair", keywords: ["items"], reason: "shape-not-read" },
      { pointer: "/properties/either", keywords: ["else", "if", "then"], reason: "keyword-not-read" },
    ]);
  });

  it("reports a type name the host answered and nothing registered", () => {
    const typed = new CelEnvironment({
      resolveSchemaType: ({ node }) => ((node as { brand?: string }).brand ? { name: "Port" } : undefined),
    }).registerVariable("subject", {
      // Nothing registers `Port`, so the host is disagreeing with itself: the structural
      // reading still stands, and the disagreement is reported beside it rather than lost.
      schema: { type: "object", properties: { port: { type: "integer", brand: "Port" } } },
    });
    expect(typed.check("subject.port").typeName).toBe("int");
    expect(typed.schemaReports()[0]?.unjudged).toEqual([
      {
        pointer: "/properties/port",
        keywords: [],
        typeName: "Port",
        reason: "named-type-unregistered",
      },
    ]);
  });

  it("says nothing about a node that constrains no type, and reports nothing either", () => {
    const typed = new CelEnvironment().registerVariable("subject", {
      schema: { type: "object", properties: { free: { description: "anything", minLength: 2 } } },
    });
    expect(typed.check("subject.free.whatever").typeName).toBe("dyn");
    expect(typed.schemaReports()).toEqual([]);
  });
});
