/**
 * Validates the signature data: CEL's own library, and the function catalog beside it.
 *
 * The data is the contract a port in another language reads, so it has to be checkable
 * without that port: every signature must parse, every type it names must exist, no two
 * entries may answer the same call (which would make one of them unreachable), and every
 * key in the file must be one the loader reads. A file that fails any of those would
 * register a function nothing can call, or silently drop one.
 *
 * It also holds the line between CEL and this engine: **a declaration CEL itself does not
 * define must say so and say why** (`"spec": false` with a `reason`). Without that gate the
 * library grows a member nobody decided was outside the language, and a port inherits it
 * as though it were CEL.
 *
 * Usage: node scripts/check-signatures.mjs
 */
import { readFileSync } from "node:fs";
import {
  CelEnvironment,
  catalogImplementation,
  functionCatalog,
  parseSignature,
  parseTypeExpression,
  registerFunctionCatalog,
  signatureKey,
} from "../dist/index.js";

const path = new URL("../src/signatures/standard-library.json", import.meta.url);
const data = JSON.parse(readFileSync(path, "utf8"));
const problems = [];

const FILE_KEYS = [
  "generation",
  "description",
  "typeConstants",
  "constants",
  "functions",
  "optionalTypeConstants",
  "optionalTypeOperators",
  "optionalTypeFunctions",
  "operators",
  "symmetricOperators",
  "crossNumericOperators",
];
const FUNCTION_KEYS = ["signature", "spec", "reason", "deterministic", "description"];
const OPERATOR_SYMBOLS = ["!", "-", "+", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "in"];

for (const key of Object.keys(data)) {
  if (!FILE_KEYS.includes(key)) problems.push(`the file holds an unknown key ${JSON.stringify(key)}`);
}
if (!Number.isInteger(data.generation) || data.generation < 1) {
  problems.push("generation must be a positive integer");
}

const keys = new Map();
const noteKey = (key, where) => {
  const held = keys.get(key);
  if (held) problems.push(`${where} answers the same call as ${held}: ${key}`);
  else keys.set(key, where);
};

for (const group of ["functions", "optionalTypeFunctions"]) {
  for (const entry of data[group]) {
    for (const key of Object.keys(entry)) {
      if (!FUNCTION_KEYS.includes(key)) {
        problems.push(`${entry.signature}: unknown key ${JSON.stringify(key)}`);
      }
    }
    if ("spec" in entry && entry.spec !== false) {
      problems.push(`${entry.signature}: "spec" is written only as false, for a member CEL does not define`);
    }
    if (entry.spec === false && !entry.reason) {
      problems.push(`${entry.signature}: CEL does not define it, so it must carry a reason for being here`);
    }
    if (entry.spec !== false && entry.reason) {
      problems.push(`${entry.signature}: a reason belongs to a declaration marked "spec": false`);
    }
    try {
      const signature = parseSignature(entry.signature);
      noteKey(signatureKey(signature), entry.signature);
    } catch (error) {
      problems.push(`${entry.signature}: ${error.message}`);
      continue;
    }
  }
}

const readType = (text, where) => {
  try {
    parseTypeExpression(text);
  } catch (error) {
    problems.push(`${where}: ${error.message}`);
  }
};

for (const entry of [...data.operators, ...data.optionalTypeOperators]) {
  if (!OPERATOR_SYMBOLS.includes(entry.operator)) {
    problems.push(`${entry.operator} is not an operator of the language`);
  }
  for (const text of [...entry.parameters, entry.returns]) readType(text, `operator ${entry.operator}`);
  noteKey(`${entry.operator}(${entry.parameters.join(", ")})`, `operator ${entry.operator}`);
}

for (const group of data.symmetricOperators) {
  for (const operator of group.operators) {
    if (!OPERATOR_SYMBOLS.includes(operator)) problems.push(`${operator} is not an operator of the language`);
    for (const type of group.types) {
      readType(type, `operator ${operator}`);
      noteKey(`${operator}(${type}, ${type})`, `symmetric operator ${operator}`);
    }
  }
  readType(group.returns, `symmetric operator ${group.operators.join("/")}`);
}

const cross = data.crossNumericOperators;
if (cross.spec !== false || !cross.reason) {
  problems.push("crossNumericOperators is not CEL's own, so it must carry \"spec\": false and a reason");
}
for (const operator of cross.operators) {
  for (const [left, right] of cross.pairs) {
    noteKey(`${operator}(${left}, ${right})`, `cross-numeric operator ${operator}`);
  }
}

for (const type of [...data.typeConstants, ...data.optionalTypeConstants]) {
  if (type === "null_type" || type === "optional_type") continue;
  readType(type, "type constant");
}
for (const constant of data.constants) readType(constant.type, `constant ${constant.name}`);

// The whole library must load into an environment, which is the one reader that matters.
try {
  const environment = new CelEnvironment({ enableOptionalTypes: true });
  const registered = environment.definitions().functions.length;
  if (registered < keys.size) {
    problems.push(`the environment registered ${registered} functions where the data holds ${keys.size}`);
  }
} catch (error) {
  problems.push(`the library does not load: ${error.message}`);
}

// --- the function catalog ---------------------------------------------------
//
// The same rules, with one difference the data states once instead of 67 times: NOTHING in
// the catalog is defined by cel-spec, so `"spec": false` and its reason are declared for
// the whole FILE, and an entry carrying either of them is a mistake.

const catalogPath = new URL("../src/signatures/function-catalog.json", import.meta.url);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const CATALOG_FILE_KEYS = ["generation", "description", "spec", "reason", "categories", "functions"];
const CATALOG_ENTRY_KEYS = [
  "name",
  "signature",
  "signatures",
  "category",
  "summary",
  "deterministic",
  "hostBacked",
  "checksLiteralArguments",
];

for (const key of Object.keys(catalog)) {
  if (!CATALOG_FILE_KEYS.includes(key)) {
    problems.push(`function-catalog.json holds an unknown key ${JSON.stringify(key)}`);
  }
}
if (!Number.isInteger(catalog.generation) || catalog.generation < 1) {
  problems.push("function-catalog.json: generation must be a positive integer");
}
if (catalog.spec !== false || typeof catalog.reason !== "string" || catalog.reason.length < 40) {
  problems.push(
    'function-catalog.json: not one of its functions is cel-spec\'s, so the file carries "spec": false and the reason why, once',
  );
}

const catalogKeys = new Map();
const names = new Set();
for (const entry of catalog.functions) {
  for (const key of Object.keys(entry)) {
    if (!CATALOG_ENTRY_KEYS.includes(key)) {
      problems.push(`${entry.name}: unknown key ${JSON.stringify(key)}`);
    }
  }
  if ("spec" in entry || "reason" in entry) {
    problems.push(`${entry.name}: the whole catalog is outside cel-spec, declared once on the file`);
  }
  if (names.has(entry.name)) problems.push(`${entry.name} is declared twice`);
  names.add(entry.name);
  if (!catalog.categories.includes(entry.category)) {
    problems.push(`${entry.name}: ${JSON.stringify(entry.category)} is not one of the declared categories`);
  }
  for (const field of ["signature", "summary"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      problems.push(`${entry.name}: ${field} is what a listing prints, and must be written`);
    }
  }
  for (const field of ["deterministic", "hostBacked"]) {
    if (typeof entry[field] !== "boolean") problems.push(`${entry.name}: ${field} is a flag`);
  }
  if (!Array.isArray(entry.signatures) || entry.signatures.length === 0) {
    problems.push(`${entry.name}: declares no signature to register`);
    continue;
  }
  for (const text of entry.signatures) {
    let signature;
    try {
      signature = parseSignature(text);
    } catch (error) {
      problems.push(`${text}: ${error.message}`);
      continue;
    }
    if (signature.name !== entry.name) {
      problems.push(`${text}: registered under ${entry.name}, which is not the name it declares`);
    }
    const key = signatureKey(signature);
    const held = catalogKeys.get(key);
    if (held) problems.push(`${text} answers the same call as ${held}: ${key}`);
    else catalogKeys.set(key, text);
    if (keys.has(key)) {
      problems.push(
        `${text} answers the same call as the standard library's ${keys.get(key)}, which registering it would silently REPLACE`,
      );
    }
    // A declaration with no behaviour type-checks and then fails at evaluation.
    if (catalogImplementation(key, {}) === undefined) {
      problems.push(`${text}: nothing implements ${key}`);
    }
  }
}

// The catalog must load onto an environment through the public registration surface, which
// is the one reader that matters — and it is the only reader that sees a host's own
// override, since the catalog has no privileged door.
try {
  const environment = new CelEnvironment({ enableOptionalTypes: true });
  const before = environment.definitions().functions.length;
  registerFunctionCatalog(environment);
  const added = environment.definitions().functions.length - before;
  if (added !== catalogKeys.size) {
    problems.push(`registering the catalog added ${added} functions where the data holds ${catalogKeys.size}`);
  }
} catch (error) {
  problems.push(`the catalog does not load: ${error.message}`);
}

if (problems.length > 0) {
  console.error(`the signature data is not valid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const outsideCel = [...data.functions, ...data.optionalTypeFunctions].filter((entry) => entry.spec === false);
const hostBacked = functionCatalog().filter((entry) => entry.hostBacked).length;
const volatile = functionCatalog().filter((entry) => !entry.deterministic).length;
console.log(
  `standard-library.json generation ${data.generation}: ${keys.size} distinct calls, all types resolve, ` +
    `${outsideCel.length + 1} declarations outside CEL, each with a reason.\n` +
    `function-catalog.json generation ${catalog.generation}: ${catalog.functions.length} functions over ` +
    `${catalogKeys.size} distinct calls in ${catalog.categories.length} categories, none of them cel-spec's, ` +
    `${hostBacked} host-backed and ${volatile} volatile; every call implemented and none shadowing the library.`,
);
