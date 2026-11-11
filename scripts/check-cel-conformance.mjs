/**
 * Replays the CEL conformance vectors through `@telorun/cel`.
 *
 * The vectors directory is a parameter of the package's conformance config, and this
 * script is the only thing in the repository that names where the vectors currently live —
 * so moving them is a one-line change here, and `@telorun/cel`'s own test suite never
 * needs a sibling package's tree to exist.
 *
 * It is also where the HOST's type vocabulary is handed over, for the same reason. The
 * dialect rows (`types.json`) declare variables of Telo's value types, and the engine knows
 * no host type name by design — a host registers its own through `registerType`. So the
 * types are derived here from `sdk/value-types/*.json`, by rule and naming none, in the
 * engine's own registration shape, and the driver refuses a row declaring a name the list
 * does not carry rather than inventing one:
 *
 * - a `representation: json` entry with no `celType` is a brand over its `base`, with its
 *   base conversion and `string(Self)` (one conversion when the base is `string`);
 * - `fromHost` adds `Self.joinPath(string): Self`;
 * - `members` become fields, each member schema read as a CEL type, plus `string(Self)`;
 * - and `Stream`, the live stream type the tag layer registers under that bare name, over
 *   `dyn` with nothing declared.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const vectors = fileURLToPath(new URL("templating/cel-conformance/", root));
const valueTypes = new URL("sdk/value-types/", root);

/** A JSON Schema type name as the CEL type a value of it is. */
const SCALAR_CEL_TYPES = { string: "string", integer: "int", number: "double", boolean: "bool" };

/** A member's schema as the CEL type its field reads as: a scalar, a list's element, a map's value. */
function celTypeOfSchema(schema, at) {
  if (schema.type === "array" && schema.items) return `list<${celTypeOfSchema(schema.items, `${at}/items`)}>`;
  if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return `map<string, ${celTypeOfSchema(schema.additionalProperties, `${at}/additionalProperties`)}>`;
  }
  const scalar = SCALAR_CEL_TYPES[schema.type];
  if (scalar === undefined) throw new Error(`${at}: no CEL type is derived for the schema ${JSON.stringify(schema)}`);
  return scalar;
}

function hostTypeOf(entry, file) {
  if (entry.members !== undefined) {
    return {
      name: entry.name,
      base: "dyn",
      fields: Object.fromEntries(
        Object.entries(entry.members).map(([member, schema]) => [member, celTypeOfSchema(schema, `${file}#/members/${member}`)]),
      ),
      conversions: ["string(Self): string"],
    };
  }
  if (entry.representation !== "json" || entry.celType !== undefined) return undefined;
  const base = SCALAR_CEL_TYPES[entry.base];
  if (base === undefined) throw new Error(`${file}: no CEL type is derived for the base ${JSON.stringify(entry.base)}`);
  return {
    name: entry.name,
    base,
    conversions: base === "string" ? ["string(Self): string"] : [`${base}(Self): ${base}`, "string(Self): string"],
    ...(entry.fromHost !== undefined ? { members: ["Self.joinPath(string): Self"] } : {}),
  };
}

const hostTypes = [
  ...readdirSync(valueTypes)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((file) => hostTypeOf(JSON.parse(readFileSync(new URL(file, valueTypes), "utf8")), file) ?? []),
  { name: "Stream", base: "dyn" },
];

const result = spawnSync("pnpm", ["--filter", "@telorun/cel", "run", "test:conformance"], {
  cwd: fileURLToPath(root),
  env: {
    ...process.env,
    CEL_CONFORMANCE_DIR: vectors,
    CEL_CONFORMANCE_HOST_TYPES: JSON.stringify(hostTypes),
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
