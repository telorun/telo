import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

/**
 * One word, one meaning across the record modules: in every kind's schema a
 * property named `model` is a reference to a shape and one named `collection` a
 * reference to a data-model collection or a kind extending it.
 */

type Doc = Record<string, any>;

const MODULES = ["data-model", "ui", "crud", "crud-ui"];
const KIND_DOCUMENTS = new Set(["Telo.Definition", "Telo.Abstract"]);

interface Module {
  name: string;
  /** Import alias → the imported module's name, `Self` → this module's. */
  aliases: Map<string, string>;
  docs: Doc[];
}

const read = (directory: string): Doc[] =>
  parseAllDocuments(readFileSync(new URL(`../../../${directory}/telo.yaml`, import.meta.url), "utf8"), {
    logLevel: "silent",
  }).map((doc) => doc.toJS());

const moduleNameAt = (directory: string): string => read(directory)[0]!.metadata.name;

const modules: Module[] = MODULES.map((directory) => {
  const docs = read(directory);
  const name = docs[0]!.metadata.name as string;
  const imports = (docs[0]!.imports ?? {}) as Record<string, string>;
  const aliases = new Map<string, string>([["Self", name]]);
  for (const [alias, source] of Object.entries(imports)) {
    aliases.set(alias, moduleNameAt(source.replace(/^\.\.\//, "")));
  }
  return { name, aliases, docs };
});

const canonical = (kind: string, module: Module): string => {
  const dot = kind.indexOf(".");
  const prefix = kind.slice(0, dot);
  return prefix === "Telo" ? kind : `${module.aliases.get(prefix) ?? prefix}.${kind.slice(dot + 1)}`;
};

/** Every kind declared across the modules, by canonical kind, with its parent. */
const parents = new Map<string, string | undefined>();
for (const module of modules) {
  for (const doc of module.docs) {
    if (!KIND_DOCUMENTS.has(doc.kind)) continue;
    parents.set(`${module.name}.${doc.metadata.name}`, doc.extends ? canonical(doc.extends, module) : undefined);
  }
}

const COLLECTION = `${moduleNameAt("data-model")}.Collection`;
const isCollection = (kind: string): boolean => {
  for (let current: string | undefined = kind; current; current = parents.get(current)) {
    if (current === COLLECTION) return true;
  }
  return false;
};

/** The kinds an `x-telo-ref` names, canonical. */
const refKinds = (node: Doc, module: Module): string[] | undefined => {
  const ref = node["x-telo-ref"];
  if (ref === undefined) return undefined;
  const kinds = typeof ref === "string" ? [ref] : [ref.kind].flat();
  return kinds.map((kind: string) => canonical(kind, module));
};

/** Each property named `name` in a schema, with where it sits. */
function propertiesNamed(schema: unknown, name: string, at: string, out: [string, Doc][] = []): [string, Doc][] {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => propertiesNamed(item, name, `${at}[${index}]`, out));
    return out;
  }
  const node = schema as Doc;
  for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, Doc>)) {
    if (key === name) out.push([`${at}.properties.${key}`, child]);
    propertiesNamed(child, name, `${at}.properties.${key}`, out);
  }
  for (const key of ["items", "additionalProperties", "patternProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions"]) {
    if (node[key] && typeof node[key] === "object") {
      const values = key === "patternProperties" || key === "$defs" || key === "definitions" ? Object.values(node[key]) : [node[key]];
      values.forEach((value) => propertiesNamed(value, name, `${at}.${key}`, out));
    }
  }
  return out;
}

const sites = (name: string) =>
  modules.flatMap((module) =>
    module.docs
      .filter((doc) => KIND_DOCUMENTS.has(doc.kind) && doc.schema)
      .flatMap((doc) =>
        propertiesNamed(doc.schema, name, `${module.name}.${doc.metadata.name}.schema`).map(
          ([at, property]) => [at, refKinds(property, module)] as const,
        ),
      ),
  );

it("types every `model` as a reference to a shape", () => {
  const found = sites("model");
  expect(found.length).toBeGreaterThan(0);
  expect(found.filter(([, kinds]) => !kinds || !kinds.every((kind) => kind === "Telo.Type"))).toEqual([]);
});

it("types every `collection` as a reference to a data-model collection", () => {
  const found = sites("collection");
  expect(found.length).toBeGreaterThan(0);
  expect(found.filter(([, kinds]) => !kinds || !kinds.every(isCollection))).toEqual([]);
});
