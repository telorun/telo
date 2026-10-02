/**
 * Validates the standard library's signature data.
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
import { CelEnvironment, parseSignature, parseTypeExpression, signatureKey } from "../dist/index.js";

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

if (problems.length > 0) {
  console.error(`standard-library.json is not valid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const outsideCel = [...data.functions, ...data.optionalTypeFunctions].filter((entry) => entry.spec === false);
console.log(
  `standard-library.json generation ${data.generation}: ${keys.size} distinct calls, all types resolve, ` +
    `${outsideCel.length + 1} declarations outside CEL, each with a reason.`,
);
