import { describe, expect, it } from "vitest";
import {
  pathParamsAnnotationProblems,
  pathParamsProblems,
  readPathTemplate,
} from "../src/path-params-slot.js";

const address = (annotation: Record<string, unknown> = { template: "/path" }) => ({
  type: "object",
  properties: {
    path: { type: "string" },
    pathParams: { type: "object", additionalProperties: {}, "x-telo-path-params-for": annotation },
  },
});

const noDeclarations = { declarationOf: () => undefined };

describe("readPathTemplate", () => {
  it("reads whole-segment variables of a path, an absolute URL's path and a mailto address", () => {
    expect(readPathTemplate("/x/{id}/y/{rev}")).toEqual({ variables: ["id", "rev"] });
    expect(readPathTemplate("https://example.com/{org}/repo?tab=1")).toEqual({ variables: ["org"] });
    expect(readPathTemplate("mailto:{address}")).toEqual({ variables: ["address"] });
    expect(readPathTemplate("/static")).toEqual({ variables: [] });
  });

  it("refuses a variable beside text, an invalid or repeated name, one in the authority or the query", () => {
    const reason = (template: string) => (readPathTemplate(template) as { invalid?: string }).invalid;
    expect(reason("/x/a{id}")).toContain("segment 'a{id}' holds a variable beside other text");
    expect(reason("/x/{1d}")).toContain("'{1d}' names no variable");
    expect(reason("/x/{id}/{id}")).toContain("'{id}' appears twice");
    expect(reason("https://{host}/x")).toContain("its authority '{host}' holds a variable");
    expect(reason("/x?q={q}")).toContain("its query or fragment '?q={q}'");
  });
});

describe("pathParamsProblems", () => {
  it("reports a variable no entry binds at the template, and an entry naming none at the entry", () => {
    const problems = pathParamsProblems(
      { type: "object", properties: { href: address() } },
      { href: { path: "/x/{id}", pathParams: { idd: "a" } } },
      noDeclarations,
    );
    expect(problems.map(({ code, path, judgedAt }) => ({ code, path, judgedAt }))).toEqual([
      { code: "PATH_PARAMETER_UNBOUND", path: "href.path", judgedAt: "href" },
      { code: "PATH_PARAMETER_UNUSED", path: "href.pathParams.idd", judgedAt: "href" },
    ]);
    expect(problems[0]!.message).toBe(
      "'href.path: /x/{id}' reads '{id}', which 'href.pathParams' does not bind. Add 'id' to 'href.pathParams'.",
    );
  });

  it("reads an omitted map as empty, and stays silent where there is nothing to bind", () => {
    const schema = { type: "object", properties: { href: address() } };
    const codes = (href: unknown) =>
      pathParamsProblems(schema, { href }, noDeclarations).map((problem) => [problem.code, problem.path]);
    expect(codes({ path: "/x/{id}" })).toEqual([["PATH_PARAMETER_UNBOUND", "href.path"]]);
    expect(codes({ path: "/x" })).toEqual([]);
    expect(codes({ path: { __tagged: true, engine: "cel", source: "row.href" } })).toEqual([]);
  });

  it("reads every entry as unused when the template field holds an expression", () => {
    const problems = pathParamsProblems(
      address(),
      { path: { __tagged: true, engine: "cel", source: "row.href" }, pathParams: { id: "a" } },
      noDeclarations,
    );
    expect(problems.map((problem) => [problem.code, problem.path])).toEqual([["PATH_PARAMETER_UNUSED", "pathParams.id"]]);
    expect(problems[0]!.message).toContain("'path' is an expression, read as a whole address and never expanded");
  });

  it("reads the template off the declaration a reference names, through the named field", () => {
    const page = { kind: "Lib.Page", metadata: { name: "home" }, path: "/p/{id}" };
    const reference = { __ref: true, kind: "Lib.Page", name: "home", indexes: [] };
    const host = { declarationOf: (value: unknown) => (value === reference ? page : undefined) };
    const schema = address({ template: "/path", through: "path" });
    expect(pathParamsProblems(schema, { path: reference, pathParams: { id: "a" } }, host)).toEqual([]);
    const [problem] = pathParamsProblems(schema, { path: reference, pathParams: {} }, host);
    expect(problem!.message).toBe(
      "the template 'path: /p/{id}' of 'home' (named at 'path') reads '{id}', which 'pathParams' does not bind. Add 'id' to 'pathParams'.",
    );
  });

  it("finds the map inside a named shape, at any depth of a list", () => {
    const shapes: Record<string, Record<string, any>> = { "telo:Lib/Address": address() };
    const problems = pathParamsProblems(
      { type: "object", properties: { links: { type: "array", items: { $ref: "telo:Lib/Address" } } } },
      { links: [{ path: "/x/{id}", pathParams: { id: "a" } }, { path: "/x/a{id}", pathParams: { id: "a" } }] },
      { ...noDeclarations, external: (ref) => shapes[ref] },
    );
    expect(problems.map((problem) => [problem.code, problem.path])).toEqual([["PATH_TEMPLATE_INVALID", "links[1].path"]]);
  });
});

describe("pathParamsAnnotationProblems", () => {
  const problemsOf = (schema: unknown, shapes: Record<string, Record<string, any>> = {}) =>
    pathParamsAnnotationProblems("Link", schema, (ref) => shapes[ref]).map((problem) => problem.message);

  it("accepts a well-formed annotation beside its template, through a reference included", () => {
    const withReference = {
      type: "object",
      properties: {
        path: { anyOf: [{ type: "string" }, { "x-telo-ref": { kind: "Self.Page", use: "schema" } }] },
        pathParams: { type: "object", "x-telo-path-params-for": { template: "/path", through: "path" } },
      },
    };
    expect(problemsOf(address())).toEqual([]);
    expect(problemsOf(withReference)).toEqual([]);
  });

  it("refuses a malformed annotation, a misplaced one, and one naming a field nothing declares", () => {
    expect(problemsOf(address({ template: "path" }))[0]).toContain("a 'template' that is no JSON Pointer");
    expect(problemsOf(address({ template: "/path", via: "x" }))[0]).toContain("with 'via', read by nothing");
    expect(problemsOf(address({ template: "/target" }))[0]).toContain(
      "naming 'target', which the object holding 'pathParams' does not declare",
    );
    expect(
      problemsOf({ type: "object", properties: { path: { type: "string" }, id: { type: "string", "x-telo-path-params-for": { template: "/path" } } } })[0],
    ).toContain("on a property that holds no object");
    expect(problemsOf({ type: "object", "x-telo-path-params-for": { template: "/path" } })[0]).toContain(
      "on a node that is no named property",
    );
  });

  it("refuses 'through' beside a field holding no reference, and its absence beside one that may", () => {
    expect(problemsOf(address({ template: "/path", through: "path" }))[0]).toContain("'through' is read by nothing");
    const reference = {
      type: "object",
      properties: {
        path: { "x-telo-ref": { kind: "Self.Page", use: "schema" } },
        pathParams: { type: "object", "x-telo-path-params-for": { template: "/path" } },
      },
    };
    expect(problemsOf(reference)[0]).toContain("with no 'through', but 'path' may hold a reference");
  });

  it("names the named shape a misplaced annotation sits in", () => {
    const shapes = { "telo:Lib/Address": address({ template: "/target" }) };
    expect(problemsOf({ type: "object", properties: { href: { $ref: "telo:Lib/Address" } } }, shapes)).toEqual([
      "'Link' declares 'schema.properties.href', which reaches 'properties.pathParams.x-telo-path-params-for' in the named shape 'Address' it names, with a 'template' naming 'target', which the object holding 'pathParams' does not declare.",
    ]);
  });
});
