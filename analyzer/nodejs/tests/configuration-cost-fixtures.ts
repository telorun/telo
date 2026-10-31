import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * The generated applications the configuration benches time and the
 * configuration corpus records. Each is served from memory under
 * `tests/__generated__/`, never written.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUN = resolve(HERE, "../../../modules/run");
export const GENERATED = join(HERE, "__generated__");

export type CostShape = "isolated" | "reached";

/** Three hundred values, with `configurations` configurations (0: no choice)
 *  read off two enum variables. In `isolated` every tenth value holds a choice
 *  and the rest reach nothing that varies; in `reached` every value reads a
 *  dimension. */
export function costApplication(shape: CostShape, configurations: 0 | 1 | 2 | 4): string {
  const a = configurations === 1 ? ["x"] : ["x", "y"];
  const cases = (values: readonly string[]) => values.map((v, i) => `${v}: ${i + 1}`).join(", ");
  const choice = (variable: string, values: readonly string[]) =>
    `!switch { switch: !cel "variables.${variable}", cases: { ${cases(values)} } }`;
  const lines = [
    "kind: Telo.Application",
    "metadata:",
    `  name: ConfigurationCost`,
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    `  a: { env: A, type: string, enum: [${a.join(", ")}], default: x }`,
    ...(configurations === 4 ? ["  b: { env: B, type: string, enum: [x, y], default: x }"] : []),
  ];
  const reads = configurations === 4 ? `variables.a + variables.b` : `variables.a`;
  for (let i = 0; i < 300; i++) {
    let value = `!cel "'r${i}'"`;
    if (shape === "reached") value = `!cel "${reads}"`;
    if (configurations > 0 && i % 10 === 0) value = choice("a", a);
    if (configurations === 4 && i % 10 === 5) value = choice("b", ["x", "y"]);
    lines.push("---", "kind: Run.Value", "metadata:", `  name: r${i}`, `value: ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A template definition whose body holds `n` entries, each one open
 *  field-value `!if` reading no reference, beside one declaration-position
 *  `!if` over an enum. */
export function costLibrary(n: number): string {
  const lines = [
    "kind: Telo.Library",
    "metadata: { name: Cost }",
    "imports:",
    `  Run: ${RUN}`,
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wide }",
    "capability: Telo.Invocable",
    "schema:",
    "  type: object",
    "  properties:",
    "    dialect: { type: string, enum: [a, b] }",
  ];
  for (let i = 0; i < n; i++) lines.push(`    a${i}: { type: integer }`, `    b${i}: { type: integer }`);
  lines.push(
    "resources:",
    "  - !if",
    "    metadata: { name: chosen }",
    `    if: !cel "self.dialect == 'a'"`,
    "    then: { kind: Run.Value, value: 1 }",
    "    else: { kind: Run.Value, value: 2 }",
  );
  for (let i = 0; i < n; i++) {
    lines.push(
      "  - kind: Run.Value",
      `    metadata: { name: value${i} }`,
      "    value: !if",
      `      if: !cel "self.a${i} == self.b${i}"`,
      "      then: 1",
      "      else: 2",
    );
  }
  lines.push("invoke: !ref chosen");
  return `${lines.join("\n")}\n`;
}

const flags = (n: number) =>
  Array.from({ length: n }, (_, i) => `  flag${i + 1}: { env: FLAG_${i + 1}, type: boolean, default: false }`);

/**
 * Fixture V: one sequence of `n` steps, step k a `value: !if` on
 * `variables.flagK`, and step k+1 reading `steps.stepK.result` in its taken
 * branch — so a step reads a string where the step before it is off, found
 * where both flags say so. `padding` adds that many declarations no
 * configuration varies, each holding one expression of its own; `unread` that
 * many declared variables no expression reads.
 */
export function flagSequence(n: number, padding = 0, unread = 0): string {
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: FlagSequence }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(n),
    ...Array.from({ length: unread }, (_, i) => `  unread${i}: { env: UNREAD_${i}, type: string, default: x }`),
    "targets:",
    "  - !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
  ];
  for (let k = 1; k <= n; k++) {
    lines.push(
      `  - name: step${k}`,
      "    value: !if",
      `      if: !cel "variables.flag${k}"`,
      `      then: ${k === 1 ? "1" : `!cel "steps.step${k - 1}.result + 1"`}`,
      `      else: "off"`,
    );
  }
  for (let i = 0; i < padding; i++) {
    lines.push("---", "kind: Run.Value", `metadata: { name: pad${i} }`, `value: !cel "'p${i}'"`);
  }
  return `${lines.join("\n")}\n`;
}

/** Fixture W: fixture V's steps, nested inside one `try:` step. */
export function flagSequenceInTry(n: number): string {
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: FlagSequenceInTry }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(n),
    "targets:",
    "  - !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
    "  - name: guarded",
    "    try:",
  ];
  for (let k = 1; k <= n; k++) {
    lines.push(
      `      - name: step${k}`,
      "        value: !if",
      `          if: !cel "variables.flag${k}"`,
      `          then: ${k === 1 ? "1" : `!cel "steps.step${k - 1}.result + 1"`}`,
      `          else: "off"`,
    );
  }
  lines.push("    catch:", "      - name: recovered", "        value: 0");
  return `${lines.join("\n")}\n`;
}

/**
 * Fixture S: `n` jobs, job k declared only when `variables.flagK` holds, each
 * started by an `!if` item of `targets:` and throwing its own code into the
 * one `catches:` of the iteration calling every job, its message adding a
 * number to the flag (one finding per job, where its flag holds). Two
 * functions call each other through choices on flag1 and flag2, a cycle
 * where both hold.
 */
export function flagTargets(n: number): string {
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: FlagTargets }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(Math.max(n, 2)),
    "targets:",
  ];
  for (let k = 1; k <= n; k++) {
    lines.push("  - !if", `    if: !cel "variables.flag${k}"`, `    then: !ref job${k}`);
  }
  lines.push("  - !ref guard");
  for (let k = 1; k <= n; k++) {
    lines.push(
      "---",
      "!if",
      `metadata: { name: job${k} }`,
      `if: !cel "variables.flag${k}"`,
      "then:",
      "  kind: Run.Sequence",
      "  steps:",
      "    - name: fail",
      "      throw:",
      `        code: JOB_${k}`,
      `        message: !cel "string(variables.flag${k} + 1)"`,
    );
  }
  lines.push(
    "---",
    "kind: Run.Iteration",
    "metadata: { name: guard }",
    `collection: !cel "[1]"`,
    "steps:",
  );
  for (let k = 1; k <= n; k++) {
    lines.push(
      "  - !if",
      `    if: !cel "variables.flag${k}"`,
      `    then: { name: call${k}, invoke: !ref job${k} }`,
    );
  }
  lines.push("catches:");
  for (let k = 1; k <= n; k++) {
    lines.push(`  - when: !cel "error.code == 'JOB_${k}'"`, `    value: ${k}`);
  }
  for (const [name, other, flag] of [
    ["a", "b", 1],
    ["b", "a", 2],
  ] as const) {
    lines.push(
      "---",
      "kind: Telo.Function",
      `metadata: { name: ${name} }`,
      "params:",
      "  - name: n",
      "    schema: { type: integer }",
      "returns:",
      "  schema: { type: integer }",
      "body: !if",
      `  if: !cel "variables.flag${flag}"`,
      `  then: !cel "Self.${other}(n)"`,
      `  else: !cel "n"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Fixture F: one sequence whose first step dispatches to a target `flag1`
 * chooses — one output declaring `x`, one closed without it — then `k` steps
 * each forwarding the result before it, and a step reading `x` off the last.
 */
export function forwardChain(k: number): string {
  const contract = (member: string) => [
    "outputType:",
    "  kind: Telo.JsonSchema",
    `  schema: { type: object, additionalProperties: false, properties: { ${member}: { type: integer } } }`,
    `value: { ${member}: 1 }`,
  ];
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: ForwardChain }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref sequence",
    "---",
    "kind: Run.Value",
    "metadata: { name: withX }",
    ...contract("x"),
    "---",
    "kind: Run.Value",
    "metadata: { name: withoutX }",
    ...contract("y"),
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
    "  - name: s0",
    "    invoke: !if",
    `      if: !cel "variables.flag1"`,
    "      then: !ref withX",
    "      else: !ref withoutX",
  ];
  for (let i = 1; i <= k; i++) lines.push(`  - name: s${i}`, `    value: !cel "steps.s${i - 1}.result"`);
  lines.push("  - name: reader", `    value: !cel "steps.s${k}.result.x"`);
  return `${lines.join("\n")}\n`;
}

/**
 * Fixture T: fixture V's steps written by a consumer of a local templated kind
 * whose body forwards `self.steps` into a `Run.Sequence` entry, beside one
 * entry a body `!if` chooses on a consumer field bound to `variables.flag1`.
 */
export function forwardedSequence(n: number): string {
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: ForwardedSequence }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(n),
    "targets:",
    "  - !ref wrapped",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapped }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    extra: { type: boolean, x-telo-eval: compile }",
    "    steps: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.steps"`,
    "  - !if",
    "    metadata: { name: chosen }",
    `    if: !cel "self.extra"`,
    "    then: { kind: Run.Value, value: 1 }",
    `    else: { kind: Run.Value, value: "off" }`,
    "run: !ref sequence",
    "---",
    "kind: ForwardedSequence.Wrapped",
    "metadata: { name: wrapped }",
    `extra: !cel "variables.flag1"`,
    "steps:",
  ];
  for (let k = 1; k <= n; k++) {
    lines.push(
      `  - name: step${k}`,
      "    value: !if",
      `      if: !cel "variables.flag${k}"`,
      `      then: ${k === 1 ? "1" : `!cel "steps.step${k - 1}.result + 1"`}`,
      `      else: "off"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Fixture T's consumer and its N-step chain, at `indent`, with the fields
 *  after its `kind` (`metadata` left to the caller). */
function forwardedSequenceConsumer(n: number, indent: string): string[] {
  const lines = [`${indent}extra: !cel "variables.flag1"`, `${indent}steps:`];
  for (let k = 1; k <= n; k++) {
    lines.push(
      `${indent}  - name: step${k}`,
      `${indent}    value: !if`,
      `${indent}      if: !cel "variables.flag${k}"`,
      `${indent}      then: ${k === 1 ? "1" : `!cel "steps.step${k - 1}.result + 1"`}`,
      `${indent}      else: "off"`,
    );
  }
  return lines;
}

/** Where fixture Tn writes its consumer in the sequence `holder`. */
export type NestedForm = "inline" | "with";

/** The prefix of the consumer's own fields in `holder`, per form. */
export const NESTED_PREFIX: Readonly<Record<NestedForm, string>> = { inline: "steps[0].invoke.", with: "with[0]." };

/**
 * Fixture Tn: fixture T's consumer written beneath a sequence `holder` instead
 * of at the top level — Tn-inline as the target of its one step, the holder
 * declaring no `with:`; Tn-with as its `with:` member, a step invoking it.
 */
export function forwardedSequenceNested(n: number, form: NestedForm): string {
  const definition = forwardedSequence(n).split("\n---\n")[1]!;
  return [
    "kind: Telo.Application",
    "metadata: { name: ForwardedSequence }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(n),
    "targets:",
    "  - !ref holder",
    "---",
    definition,
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    ...(form === "with"
      ? [
          "with:",
          "  - kind: ForwardedSequence.Wrapped",
          "    metadata: { name: wrapped }",
          ...forwardedSequenceConsumer(n, "    "),
          "steps:",
          "  - name: member",
          "    invoke: !ref wrapped",
        ]
      : ["steps:", "  - name: inline", "    invoke:", "      kind: ForwardedSequence.Wrapped", ...forwardedSequenceConsumer(n, "      ")]),
    "",
  ].join("\n");
}

/** Fixture V's `n` steps, at `indent`. */
function flagSteps(n: number, indent: string): string[] {
  const lines: string[] = [];
  for (let k = 1; k <= n; k++) {
    lines.push(
      `${indent}- name: step${k}`,
      `${indent}  value: !if`,
      `${indent}    if: !cel "variables.flag${k}"`,
      `${indent}    then: ${k === 1 ? "1" : `!cel "steps.step${k - 1}.result + 1"`}`,
      `${indent}    else: "off"`,
    );
  }
  return lines;
}

/**
 * Fixture Ti: fixture V's sequence written inline as the target of the one
 * step of a sequence `holder`. With `chosen`, a choice on `variables.flag0`
 * takes that inline sequence or a reference to `other` there.
 */
export function inlineSequence(n: number, chosen = false): string {
  const inline = (indent: string) => [`${indent}kind: Run.Sequence`, `${indent}steps:`, ...flagSteps(n, `${indent}  `)];
  return [
    "kind: Telo.Application",
    "metadata: { name: InlineSequence }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...(chosen ? ["  flag0: { env: FLAG_0, type: boolean, default: false }"] : []),
    ...flags(n),
    "targets:",
    "  - !ref holder",
    "---",
    ...(chosen ? ["kind: Run.Value", "metadata: { name: other }", "value: 0", "---"] : []),
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "steps:",
    "  - name: inline",
    ...(chosen
      ? ["    invoke: !if", `      if: !cel "variables.flag0"`, "      then:", ...inline("        "), "      else: !ref other"]
      : ["    invoke:", ...inline("      ")]),
    "",
  ].join("\n");
}

/**
 * Fixture K: a sequence `holder` of `k` steps, step j invoking an inline value
 * where `variables.flagJ` holds and a reference to `fallback` elsewhere — `k`
 * inline declarations, each under a choice of its own.
 */
export function inlineDeclarations(k: number): string {
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: InlineDeclarations }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(k),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Run.Value",
    "metadata: { name: fallback }",
    "value: 0",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "steps:",
  ];
  for (let j = 1; j <= k; j++) {
    lines.push(
      `  - name: step${j}`,
      "    invoke: !if",
      `      if: !cel "variables.flag${j}"`,
      `      then: { kind: Run.Value, value: ${j} }`,
      "      else: !ref fallback",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A consumer whose forward views the lifted view builder builds through every
 * kind of option: a body field choice deciding which forward an entry holds, a
 * body entry a choice declares, both decided by a consumer field a choice
 * decides; a family repeating over a consumer list holding an item a choice
 * leaves out, so every later member moves; and forwarded values holding
 * choices of their own.
 */
export function liftedForwardViews(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: LiftedViews }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref wrapped",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapped }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    mode: { type: boolean, x-telo-eval: compile }",
    "    steps: { type: array }",
    "    other: { type: array }",
    "    jobs: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    "    steps: !if",
    `      if: !cel "self.mode"`,
    `      then: !cel "self.steps"`,
    `      else: !cel "self.other"`,
    "  - !if",
    "    metadata: { name: chosen }",
    `    if: !cel "self.mode"`,
    "    then:",
    "      kind: Run.Sequence",
    `      steps: !cel "self.other"`,
    "  - !for-each",
    "    metadata: { name: job }",
    `    in: !cel "self.jobs"`,
    "    emit:",
    "      kind: Run.Sequence",
    `      steps: !cel "each.value.steps"`,
    "run: !ref sequence",
    "---",
    "kind: LiftedViews.Wrapped",
    "metadata: { name: wrapped }",
    "mode: !if",
    `  if: !cel "variables.flag2"`,
    "  then: true",
    "  else: false",
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.flag1"`,
    "      then: 1",
    `      else: "off"`,
    "other:",
    "  - name: second",
    "    value: 2",
    "jobs:",
    "  - steps:",
    "      - { name: a, value: 1 }",
    "  - !if",
    `    if: !cel "variables.flag1"`,
    "    then:",
    "      steps:",
    "        - { name: b, value: 2 }",
    "  - steps:",
    "      - name: c",
    "        value: !if",
    `          if: !cel "variables.flag2"`,
    "          then: 3",
    "          else: 4",
    "",
  ].join("\n");
}

/**
 * A consumer whose steps are forwarded through two templated kinds — the outer
 * kind's body forwards them into an entry of the inner kind, whose body
 * forwards them into a sequence — holding an inline declaration the sequence's
 * step slot draws out, a step reading another where both flags say so, and a
 * branch no configuration takes, holding a type error — inside a forwarded
 * value, and as the whole value forwarded.
 */
export function nestedForwardViews(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: NestedViews, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref outer",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Inner }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    steps: { type: array }",
    "    extra: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.steps"`,
    "  - kind: Run.Sequence",
    "    metadata: { name: more }",
    `    steps: !cel "self.extra"`,
    "run: !ref sequence",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Outer }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    steps: { type: array }",
    "    extra: { type: array }",
    "resources:",
    "  - kind: NestedViews.Inner",
    "    metadata: { name: inner }",
    `    steps: !cel "self.steps"`,
    `    extra: !cel "self.extra"`,
    "run: !ref inner",
    "---",
    "kind: NestedViews.Outer",
    "metadata: { name: outer }",
    "steps:",
    "  - name: first",
    "    invoke:",
    "      kind: Run.Value",
    "      value: !if",
    `        if: !cel "variables.flag1"`,
    "        then: 1",
    `        else: "off"`,
    "  - name: second",
    "    value: !if",
    `      if: !cel "variables.flag2"`,
    `      then: !cel "string(steps.first.result) + 1"`,
    "      else: 0",
    "  - name: third",
    "    value: !if",
    `      if: !cel "module.version == '1.0.0'"`,
    "      then: 3",
    `      else: !cel "1 + 'x'"`,
    "extra: !if",
    `  if: !cel "module.version == '1.0.0'"`,
    "  then: []",
    "  else:",
    "    - name: unused",
    `      value: !cel "2 + 'y'"`,
    "",
  ].join("\n");
}

/**
 * A consumer whose forwarded values hold expressions typed differently by the
 * entries receiving them, at written places several sites share, each judged
 * in a branch no configuration takes (where a plain analysis of the expansion
 * taking it is the oracle) and feeding a call's input there: two sibling body
 * entries of different kinds forwarding the same `self.<path>`, one binding
 * `iteration`; an exact forward through a reference holding several
 * expressions of different types, each candidate referent holding a choice of
 * its own; and an inline declaration inside the forwarded value, drawn out at
 * the first entry and held in place by the second. With `extraction` off the
 * last is left out.
 */
export function mergedPlaceViews(extraction = true): string {
  const forwarding = (name: string, entries: string[]) => [
    "kind: Telo.Definition",
    `metadata: { name: ${name} }`,
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    steps: { type: array }",
    "resources:",
    ...entries,
  ];
  const sequence = (name: string) => [
    "  - kind: Run.Sequence",
    `    metadata: { name: ${name} }`,
    `    steps: !cel "self.steps"`,
  ];
  const holders = ["holder", "spare"].flatMap((name) => [
    "kind: MergedPlaces.Holder",
    `metadata: { name: ${name} }`,
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.flag2"`,
    `      then: !cel "'one'"`,
    `      else: !cel "1"`,
    "  - name: second",
    `    value: !cel "'two'"`,
    "  - name: third",
    "    invoke: !ref taker",
    `    inputs: { a: !cel "steps.first.result" }`,
    "---",
  ]);
  return [
    "kind: Telo.Application",
    "metadata: { name: MergedPlaces, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref siblings",
    "  - !ref viaRef",
    ...(extraction ? ["  - !ref extracted"] : []),
    "---",
    "kind: Run.Value",
    "metadata: { name: taker }",
    "inputType:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: string } } }",
    "value: 1",
    "---",
    ...forwarding("Pair", [
      ...sequence("left"),
      "  - kind: Run.Loop",
      "    metadata: { name: right }",
      "    maxIterations: 1",
      `    steps: !cel "self.steps"`,
    ]),
    "targets:",
    "  - !ref left",
    "  - !ref right",
    "---",
    ...forwarding("Holder", sequence("inner")),
    "run: !ref inner",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: ViaRef }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: MergedPlaces.Holder, use: dependency } }",
    "    tag: { type: integer }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.src.steps"`,
    "run: !ref sequence",
    "---",
    "kind: MergedPlaces.Pair",
    "metadata: { name: siblings }",
    "steps:",
    "  - name: one",
    "    invoke: !ref taker",
    "    inputs:",
    "      a: !if",
    `        if: !cel "module.version == '1.0.0'"`,
    "        then: x",
    `        else: !cel "iteration"`,
    "---",
    ...holders,
    "kind: MergedPlaces.ViaRef",
    "metadata: { name: viaRef }",
    "src: !if",
    `  if: !cel "module.version == '1.0.0'"`,
    "  then: !ref holder",
    "  else: !ref spare",
    "tag: !if",
    `  if: !cel "variables.flag1"`,
    "  then: 1",
    "  else: 2",
    ...(extraction
      ? [
          "---",
          ...forwarding("Drawn", [
            ...sequence("left"),
            "  - kind: Run.Value",
            "    metadata: { name: right }",
            `    value: !cel "self.steps"`,
          ]),
          "targets:",
          "  - !ref left",
          "---",
          "kind: MergedPlaces.Drawn",
          "metadata: { name: extracted }",
          "steps:",
          "  - name: one",
          "    invoke:",
          "      kind: Run.Value",
          "      inputType:",
          "        kind: Telo.JsonSchema",
          "        schema: { type: object, properties: { a: { type: string } } }",
          "      outputType:",
          "        kind: Telo.JsonSchema",
          "        schema: { type: integer }",
          "      value: !if",
          `        if: !cel "module.version == '1.0.0'"`,
          "        then: 1",
          `        else: !cel "inputs.a"`,
        ]
      : []),
    "",
  ].join("\n");
}

/**
 * Fixture P: `mergedPlaceViews()`'s exact forward through a reference alone —
 * `viaRef` forwards the steps of the `Holder` its `src` names, each candidate
 * holding a choice and a call's input reading it — each candidate also holding
 * `p` steps under `parked`, which nothing forwards.
 */
export function crossedReferentPadding(p: number): string {
  const holders = ["holder", "spare"].flatMap((name) => [
    "---",
    "kind: CrossedPadding.Holder",
    `metadata: { name: ${name} }`,
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.flag2"`,
    `      then: !cel "'one'"`,
    `      else: !cel "1"`,
    "  - name: second",
    `    value: !cel "'two'"`,
    "  - name: third",
    "    invoke: !ref taker",
    `    inputs: { a: !cel "steps.first.result" }`,
    ...(p > 0 ? ["parked:", ...Array.from({ length: p }, (_, i) => `  - { name: parked${i}, value: ${i} }`)] : ["parked: []"]),
  ]);
  return [
    "kind: Telo.Application",
    "metadata: { name: CrossedPadding, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref viaRef",
    "---",
    "kind: Run.Value",
    "metadata: { name: taker }",
    "inputType:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: string } } }",
    "value: 1",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Holder }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    steps: { type: array }",
    "    parked: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: inner }",
    `    steps: !cel "self.steps"`,
    "run: !ref inner",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: ViaRef }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: CrossedPadding.Holder, use: dependency } }",
    "    tag: { type: integer }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.src.steps"`,
    "run: !ref sequence",
    ...holders,
    "---",
    "kind: CrossedPadding.ViaRef",
    "metadata: { name: viaRef }",
    "src: !if",
    `  if: !cel "module.version == '1.0.0'"`,
    "  then: !ref holder",
    "  else: !ref spare",
    "tag: !if",
    `  if: !cel "variables.flag1"`,
    "  then: 1",
    "  else: 2",
    "",
  ].join("\n");
}

/**
 * A branch no configuration takes (an `!if` on the module's own version)
 * nested in the `flag2=false` option of a choice, holding a call's input of
 * the wrong type, a step field its schema refuses and an ill-typed expression
 * — each found in no configuration, whatever an analysis narrowed to `flag2`
 * keeps. The input reads a step whose expression `flag1` chooses, so a
 * narrowing to `flag1=true` leaves the expression the branch reads at its
 * baseline outside every configuration it keeps.
 */
export function nestedDeadBranch(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: NestedDeadBranch, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref sequence",
    "---",
    "kind: Run.Value",
    "metadata: { name: taker }",
    "inputType:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: string }, b: { type: string } } }",
    "value: 1",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.flag1"`,
    `      then: !cel "'one'"`,
    `      else: !cel "1"`,
    "  - !if",
    `    if: !cel "variables.flag2"`,
    "    then: { name: second, value: 2 }",
    "    else: !if",
    `      if: !cel "module.version == '1.0.0'"`,
    "      then: { name: second, value: 3 }",
    "      else:",
    "        name: second",
    "        invoke: !ref taker",
    "        when: 5",
    "        inputs:",
    `          a: !cel "steps.first.result"`,
    `          b: !cel "1 + 'x'"`,
    "",
  ].join("\n");
}

/**
 * `k` branches no configuration takes (an `!if` on the module's own version),
 * each in the `flag1=false` option of a step choice — so all share the
 * baseline `flag1=false` — and each reading the last of `l` producers: a
 * first step `flag1` chooses (text where it holds, a number where not), then
 * steps each forwarding the result before it.
 */
export function deadReaders(k: number, l: number): string {
  const lines = [
    "kind: Telo.Application",
    "metadata: { name: DeadReaders, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
    "  - name: p1",
    "    value: !if",
    `      if: !cel "variables.flag1"`,
    `      then: !cel "'one'"`,
    `      else: !cel "1"`,
  ];
  for (let i = 2; i <= l; i++) lines.push(`  - name: p${i}`, `    value: !cel "steps.p${i - 1}.result"`);
  for (let j = 1; j <= k; j++) {
    lines.push(
      "  - !if",
      `    if: !cel "variables.flag1"`,
      `    then: { name: r${j}, value: 0 }`,
      "    else: !if",
      `      if: !cel "module.version == '1.0.0'"`,
      `      then: { name: r${j}, value: 0 }`,
      `      else: { name: r${j}, value: !cel "steps.p${l}.result" }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A named shape declared only where `flag2` holds types the result of a step
 * `q` invoking a resource whose `outputType` names it, and a step `p` forwards
 * that result; a branch no configuration takes (an `!if` on the module's own
 * version), in the `flag2=false` option, reads a member only the shape
 * declares. At that branch's baseline the shape is absent, so the member is
 * unknown there — whatever an analysis narrowed to `flag2` keeps.
 */
export function careIdentity(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: CareIdentity, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    "  flag2: { env: FLAG_2, type: boolean, default: false }",
    "targets:",
    "  - !ref sequence",
    "--- !if",
    "metadata: { name: Shape }",
    `if: !cel "variables.flag2"`,
    "then:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: string }, c: { type: string } }, additionalProperties: false }",
    "---",
    "kind: Run.Value",
    "metadata: { name: producer }",
    "outputType: !ref Shape",
    "value: { a: x }",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
    "  - name: q",
    "    invoke: !ref producer",
    "  - name: p",
    `    value: !cel "steps.q.result"`,
    "  - !if",
    `    if: !cel "variables.flag2"`,
    "    then: { name: r, value: 0 }",
    "    else: !if",
    `      if: !cel "module.version == '1.0.0'"`,
    "      then: { name: r, value: 0 }",
    `      else: { name: r, value: !cel "steps.p.result.c" }`,
    "",
  ].join("\n");
}

/**
 * Consumers of a local templated kind that are no top-level declaration: one
 * declared inline as a step's target, one as a `with:` member of the sequence
 * holding that step. Each forwards steps holding a choice into a body entry
 * and binds the field a body `!if` chooses an entry on to a flag.
 */
export function nestedConsumers(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: NestedConsumers }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref main",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapped }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    extra: { type: boolean, x-telo-eval: compile }",
    "    steps: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.steps"`,
    "  - !if",
    "    metadata: { name: chosen }",
    `    if: !cel "self.extra"`,
    "    then: { kind: Run.Value, value: 1 }",
    `    else: { kind: Run.Value, value: "off" }`,
    "run: !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: main }",
    "with:",
    "  - kind: NestedConsumers.Wrapped",
    "    metadata: { name: member }",
    `    extra: !cel "variables.flag2"`,
    "    steps:",
    "      - name: a",
    "        value: !if",
    `          if: !cel "variables.flag2"`,
    `          then: !cel "1 + 'x'"`,
    "          else: 2",
    "steps:",
    "  - name: inline",
    "    invoke:",
    "      kind: NestedConsumers.Wrapped",
    `      extra: !cel "variables.flag1"`,
    "      steps:",
    "        - name: b",
    "          value: !if",
    `            if: !cel "variables.flag1"`,
    "            then: 1",
    `            else: "off"`,
    "        - name: c",
    `          value: !cel "steps.b.result + 1"`,
    "  - name: viaMember",
    "    invoke: !ref member",
    "",
  ].join("\n");
}

/**
 * {@link careIdentity}'s steps written in a consumer of a local templated kind
 * declared inline as a step's target, whose body forwards them into a
 * sequence: the branch no configuration takes reads `p` through that nested
 * consumer's view, a declaration other than the one its choice is written in.
 */
export function careIdentityNested(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: CareIdentityNested, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    "  flag2: { env: FLAG_2, type: boolean, default: false }",
    "targets:",
    "  - !ref main",
    "--- !if",
    "metadata: { name: Shape }",
    `if: !cel "variables.flag2"`,
    "then:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: string }, c: { type: string } }, additionalProperties: false }",
    "---",
    "kind: Run.Value",
    "metadata: { name: producer }",
    "outputType: !ref Shape",
    "value: { a: x }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapped }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    steps: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.steps"`,
    "run: !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: main }",
    "steps:",
    "  - name: wrapped",
    "    invoke:",
    "      kind: CareIdentityNested.Wrapped",
    "      steps:",
    "        - name: q",
    "          invoke: !ref producer",
    "        - name: p",
    `          value: !cel "steps.q.result"`,
    "        - !if",
    `          if: !cel "variables.flag2"`,
    "          then: { name: r, value: 0 }",
    "          else: !if",
    `            if: !cel "module.version == '1.0.0'"`,
    "            then: { name: r, value: 0 }",
    `            else: { name: r, value: !cel "steps.p.result.c" }`,
    "",
  ].join("\n");
}

/**
 * A `with:` member consumer of a local templated kind whose body forwards
 * `self.src.steps` exactly, `src` naming a sibling `with:` member whose step a
 * flag chooses, one option ill-typed. With `shadowed`, the module also declares
 * a top-level `src` of another shape — two steps holding no expression — which
 * the member shadows in its scope.
 */
export function scopeMemberCrossing(shadowed: boolean): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ScopeCrossing }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: ViaRef }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: Run.Sequence, use: dependency } }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.src.steps"`,
    "run: !ref sequence",
    ...(shadowed
      ? ["---", "kind: Run.Sequence", "metadata: { name: src }", "steps:", "  - { name: z, value: top }", "  - { name: y, value: 0 }"]
      : []),
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "with:",
    "  - kind: Run.Sequence",
    "    metadata: { name: src }",
    "    steps:",
    "      - name: a",
    "        value: !if",
    `          if: !cel "variables.flag1"`,
    `          then: !cel "1 + 'x'"`,
    "          else: 2",
    "  - kind: ScopeCrossing.ViaRef",
    "    metadata: { name: via }",
    "    src: !ref src",
    "steps:",
    "  - name: run",
    "    invoke: !ref via",
    "",
  ].join("\n");
}

/**
 * A step reading the result of a target declaring no output contract, which
 * its kind derives from the target's `value:` — a value a flag chooses, so the
 * member the step reads is there in one configuration only.
 */
export function derivedResultTarget(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: DerivedResult }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref sequence",
    "---",
    "kind: Run.Value",
    "metadata: { name: shaped }",
    "value: !if",
    `  if: !cel "variables.flag1"`,
    "  then: { x: 1 }",
    "  else: { y: 1 }",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: sequence }",
    "steps:",
    "  - name: made",
    "    invoke: !ref shaped",
    "  - name: read",
    `    value: !cel "steps.made.result.x"`,
    "",
  ].join("\n");
}

/**
 * Declarations a sequence reads by name, each one a flag varies and each padded
 * with `p` entries nothing reads: `holder`, read as `resources.holder.a` and as
 * `resources['holder']`; `pick`, a native function called with its kind's
 * signature; and `triple`, a function whose own `returns` types a call adding a
 * string to its integer result.
 */
export function nameReadPadding(p: number): string {
  const parked = (indent: string) =>
    p > 0 ? Array.from({ length: p }, (_, i) => `${indent}- { name: parked${i}, value: ${i} }`) : [];
  return [
    "kind: Telo.Application",
    "metadata: { name: NamePadding }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref reader",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Picker }",
    "capability: Telo.Callable",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "params:",
    "  - { name: x, schema: { type: integer } }",
    "returns: { schema: { type: integer } }",
    "schema:",
    "  type: object",
    "  properties:",
    "    mode: { type: integer }",
    "    parked: { type: array }",
    "---",
    "kind: NamePadding.Picker",
    "metadata: { name: pick }",
    "mode: !if",
    `  if: !cel "variables.flag2"`,
    "  then: 1",
    "  else: 2",
    ...(p > 0 ? ["parked:", ...parked("  ")] : ["parked: []"]),
    "---",
    "kind: Telo.Function",
    "metadata: { name: triple }",
    "params:",
    "  - { name: x, schema: { type: integer } }",
    "returns: { schema: { type: integer } }",
    "body: !if",
    `  if: !cel "variables.flag2"`,
    `  then: !cel "x * 3"`,
    `  else: !cel "x + x + x"`,
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.flag2"`,
    "      then: 1",
    "      else: 2",
    ...parked("  "),
    "---",
    "kind: Run.Sequence",
    "metadata: { name: reader }",
    "steps:",
    "  - name: field",
    `    value: !cel "resources.holder.a"`,
    "  - name: bare",
    `    value: !cel "resources['holder']"`,
    "  - name: called",
    `    value: !cel "Self.pick(1) + 1"`,
    "  - name: tripled",
    `    value: !cel "Self.triple(1) + 'x'"`,
    "",
  ].join("\n");
}

/** `p` entries nothing reads, under `parked:`. */
const parkedEntries = (p: number): string[] =>
  p > 0 ? ["parked:", ...Array.from({ length: p }, (_, i) => `  - { name: parked${i}, value: ${i} }`)] : ["parked: []"];

/**
 * A resource rule whose `resolve:` pointer continues past a reference slot:
 * `form`'s rule reads the label of the model its options name, `/options/model`
 * resolved hop by hop, and holds where it is the one the form expects. The options and
 * the model each hold a member a flag varies and `p` entries, none of which the
 * rule reads.
 */
export function rulePadding(p: number): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: RulePadding }",
    "variables:",
    ...flags(2),
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Model }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    label: { type: string }",
    "    note: { type: string }",
    "    parked: { type: array }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Options }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    model: { x-telo-ref: { kind: Self.Model, use: dependency } }",
    "    note: { type: string }",
    "    parked: { type: array }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Form }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    options: { x-telo-ref: { kind: Self.Options, use: dependency } }",
    "    expected: { type: string }",
    "  x-telo-resource-rules:",
    '    - resolve: ["/options/model"]',
    `      condition: !cel "self.options.model.label == self.expected"`,
    "      code: FORM_MODEL",
    "      message: The form's model is not the one it expects.",
    "---",
    "kind: Self.Model",
    "metadata: { name: model }",
    "label: first",
    "note: !if",
    `  if: !cel "variables.flag2"`,
    "  then: one",
    "  else: two",
    ...parkedEntries(p),
    "---",
    "kind: Self.Options",
    "metadata: { name: options }",
    "model: !ref model",
    "note: !if",
    `  if: !cel "variables.flag1"`,
    "  then: one",
    "  else: two",
    ...parkedEntries(p),
    "---",
    "kind: Self.Form",
    "metadata: { name: form }",
    "options: !ref options",
    "expected: first",
    "",
  ].join("\n");
}

/**
 * A text catalog set reaching on through the catalog set of a resource it
 * names: `set` holds `bundle`, whose own catalog translates a text `set`'s
 * inline catalog already translates. The bundle holds a member a flag varies
 * and `p` entries, none of which a catalog set reads.
 */
export function catalogSetPadding(p: number): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: CatalogPadding }",
    "lang: en",
    "variables:",
    ...flags(2),
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Catalog }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    'schema: { $ref: "telo://manifest#/$defs/TextCatalog" }',
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Bundle }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    catalogs:",
    "      type: array",
    "      x-telo-text-catalog-set: true",
    "      items: { x-telo-ref: { kind: Self.Catalog, use: dependency } }",
    "    note: { type: string }",
    "    parked: { type: array }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Set }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    sources:",
    "      type: array",
    "      x-telo-text-catalog-set: true",
    "      items:",
    "        anyOf:",
    '          - { $ref: "telo://manifest#/$defs/TextCatalog" }',
    "          - { x-telo-ref: { kind: Self.Bundle, use: dependency } }",
    "---",
    "kind: Self.Catalog",
    "metadata: { name: open }",
    "lang: pl",
    "texts:",
    '  - { text: "Open", translation: "Otwórz" }',
    "---",
    "kind: Self.Catalog",
    "metadata: { name: close }",
    "lang: pl",
    "texts:",
    '  - { text: "Close", translation: "Zamknij" }',
    "---",
    "kind: Self.Bundle",
    "metadata: { name: bundle }",
    "catalogs: [!ref open, !ref close]",
    "note: !if",
    `  if: !cel "variables.flag2"`,
    "  then: one",
    "  else: two",
    ...parkedEntries(p),
    "---",
    "kind: Self.Set",
    "metadata: { name: set }",
    "sources:",
    "  - lang: pl",
    "    texts:",
    '      - { text: "Open", translation: "Otwieraj" }',
    "  - !ref bundle",
    "",
  ].join("\n");
}

/**
 * A zone requirement whose correlation key crosses a reference: `work` must
 * run inside a `Tx` on the connection its settings name, and `tx` provides one
 * on another. The settings hold a member a flag varies and `p` entries, none
 * of which the zone reads.
 */
export function zonePadding(p: number): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ZonePadding }",
    "variables:",
    ...flags(2),
    "targets:",
    "  - { name: run, invoke: !ref tx }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Conn }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema: { type: object, properties: { label: { type: string } } }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Settings }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    connection: { x-telo-ref: { kind: Self.Conn, use: dependency } }",
    "    note: { type: string }",
    "    parked: { type: array }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Tx }",
    "capability: Telo.Invocable",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    connection: { x-telo-ref: { kind: Self.Conn, use: dependency } }",
    "    body: { x-telo-ref: { kind: Telo.Executable, use: call }, x-telo-provides-zone: /connection }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Work }",
    "capability: Telo.Invocable",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    settings: { x-telo-ref: { kind: Self.Settings, use: dependency } }",
    "  x-telo-requires-zone:",
    "    zone: Self.Tx",
    "    key: [/settings/connection]",
    "    reason: the work writes on the connection its settings name",
    "---",
    "kind: Self.Conn",
    "metadata: { name: primary }",
    "label: a",
    "---",
    "kind: Self.Conn",
    "metadata: { name: secondary }",
    "label: b",
    "---",
    "kind: Self.Settings",
    "metadata: { name: settings }",
    "connection: !ref secondary",
    "note: !if",
    `  if: !cel "variables.flag2"`,
    "  then: one",
    "  else: two",
    ...parkedEntries(p),
    "---",
    "kind: Self.Tx",
    "metadata: { name: tx }",
    "connection: !ref primary",
    "body: !ref work",
    "---",
    "kind: Self.Work",
    "metadata: { name: work }",
    "settings: !ref settings",
    "",
  ].join("\n");
}

/**
 * A value held to the type at a location past a reference: `agent`'s `context`
 * takes the type its resolver's `contextType` names, which a flag chooses —
 * a record its value fits, or an integer it does not. The resolver also holds
 * a member another flag varies, which nothing reads.
 */
export function valueSchemaCrossing(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ValueSchemaCrossing }",
    "variables:",
    ...flags(2),
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Resolver }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    contextType: { x-telo-ref: { kind: Telo.Type, use: schema } }",
    "    note: { type: string }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Agent }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    resolver: { x-telo-ref: { kind: Self.Resolver, use: dependency } }",
    "    context: { x-telo-value-schema-from: /resolver/contextType }",
    "---",
    "kind: Telo.JsonSchema",
    "metadata: { name: Ctx }",
    "schema: { type: object, properties: { a: { type: string } }, additionalProperties: false }",
    "---",
    "kind: Telo.JsonSchema",
    "metadata: { name: Count }",
    "schema: { type: integer }",
    "---",
    "kind: Self.Resolver",
    "metadata: { name: resolver }",
    "contextType: !if",
    `  if: !cel "variables.flag2"`,
    "  then: !ref Ctx",
    "  else: !ref Count",
    "note: !if",
    `  if: !cel "variables.flag1"`,
    "  then: one",
    "  else: two",
    "---",
    "kind: Self.Agent",
    "metadata: { name: agent }",
    "resolver: !ref resolver",
    "context: { a: x }",
    "",
  ].join("\n");
}

/**
 * One declaration read through every annotation that reads a reference without
 * following it on: `thing` holds a member a flag varies and `p` entries, none
 * of which any reader reads, and is named by a boot target (`x-telo-ref`), a
 * handler whose result types a region — `caller` reads a member its output
 * contract does not declare (`x-telo-context-ref-from`) — a slot whose
 * schema is the type `thing` declares (`x-telo-schema-from`), a sequence's step
 * a `with:` member is scoped against (`x-telo-scope`) and a function's
 * `returns` (`x-telo-returns-from`); and it references `field`, whose accessor
 * binding is typed from `thing`'s scope at that slot
 * (`x-telo-context-from-referrer`).
 */
export function referentPadding(p: number): string {
  return referentPaddingDocs(p, ["outputType: { type: object, properties: { count: { type: integer } }, additionalProperties: false }"]);
}

/**
 * {@link referentPadding} with the target's `outputType` under `!if
 * variables.flag2`, a flag the dispatch's `when` does not read, so a read of
 * that contract varies with a flag the application's own check never does.
 */
export function referentPaddingFlaggedOutput(p: number): string {
  return referentPaddingDocs(p, [
    "outputType: !if",
    `  if: !cel "variables.flag2"`,
    "  then: { type: object, properties: { count: { type: integer } }, additionalProperties: false }",
    "  else: { type: object }",
  ]);
}

function referentPaddingDocs(p: number, thingOutputType: string[]): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ReferentPadding }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - name: run",
    "    invoke: !ref thing",
    `    when: !cel "variables.flag1"`,
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Field }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    show:",
    "      x-telo-eval: accessor",
    "      x-telo-context:",
    "        type: object",
    "        properties:",
    "          values: { x-telo-context-from-referrer: values, x-telo-context-eval: accessor }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Thing }",
    "capability: Telo.Invocable",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    outputType: { type: object }",
    "    record: { type: object }",
    "    field:",
    "      x-telo-ref: { kind: Self.Field, use: dependency }",
    "      x-telo-context:",
    "        type: object",
    "        properties:",
    "          values: { x-telo-context-from-root: record }",
    "    note: { type: string }",
    "    parked: { type: array }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Caller }",
    "capability: Telo.Invocable",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    handler: { x-telo-ref: { kind: Self.Thing, use: call } }",
    "    map:",
    "      x-telo-eval: runtime",
    "      x-telo-context:",
    "        type: object",
    "        properties:",
    '          result: { x-telo-context-ref-from: "handler/outputType" }',
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Shaped }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: Self.Thing, use: dependency } }",
    '    payload: { x-telo-schema-from: "src/outputType" }',
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Memo }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema: { type: object, properties: { text: { type: string } } }",
    "---",
    "kind: Self.Field",
    "metadata: { name: field }",
    `show: !cel "values.a"`,
    "---",
    "kind: Self.Thing",
    "metadata: { name: thing }",
    ...thingOutputType,
    "record: { type: object, properties: { a: { type: string } } }",
    "field: !ref field",
    "note: !if",
    `  if: !cel "variables.flag2"`,
    "  then: one",
    "  else: two",
    ...parkedEntries(p),
    "---",
    "kind: Self.Caller",
    "metadata: { name: caller }",
    "handler: !ref thing",
    `map: !cel "result.total"`,
    "---",
    "kind: Self.Shaped",
    "metadata: { name: shaped }",
    "src: !ref thing",
    "payload:",
    `  count: !cel "variables.flag1 ? 1 : 2"`,
    "---",
    "kind: Run.Sequence",
    "metadata: { name: scoped }",
    "with:",
    "  - kind: Self.Memo",
    "    metadata: { name: memo }",
    `    text: !cel "string(variables.flag1)"`,
    "steps:",
    "  - name: call",
    "    invoke: !ref thing",
    "---",
    "kind: Telo.Function",
    "metadata: { name: measure }",
    "params:",
    "  - { name: x, schema: { type: integer } }",
    "returns: { schema: !ref thing }",
    `body: !cel "x + 1"`,
    "",
  ].join("\n");
}

/** Shapes and kinds the relation-read rows share: `Thing` a referent with a
 *  shape, a projected field map, and members nothing reads; `Form` a kind
 *  whose input contract is the shape of the thing its `model` names; and one
 *  kind per relation reading through a reference. */
const RELATION_READ_KINDS: readonly string[] = [
  "kind: Telo.JsonSchema",
  "metadata: { name: Ctx }",
  "schema: { type: object, properties: { a: { type: string } }, additionalProperties: false }",
  "---",
  "kind: Telo.JsonSchema",
  "metadata: { name: Count }",
  "schema: { type: integer }",
  "---",
  "kind: Telo.Definition",
  "metadata: { name: Thing }",
  "capability: Telo.Provider",
  "controllers:",
  "  - pkg:npm/none@0.0.0",
  "x-telo-schema-projection: { entries: /fields, key: type }",
  "schema:",
  "  type: object",
  "  properties:",
  "    shape: { x-telo-ref: { kind: Telo.Type, use: schema } }",
  "    fields:",
  "      type: object",
  "      additionalProperties:",
  "        type: object",
  "        properties:",
  "          type: { type: string, x-telo-schema-map: { text: { type: string }, number: { type: number } } }",
  "    note: { type: string }",
  "    parked: { type: array }",
  "---",
  "kind: Telo.Definition",
  "metadata: { name: Form }",
  "capability: Telo.Invocable",
  "controllers:",
  "  - pkg:npm/none@0.0.0",
  "inputType:",
  "  type: object",
  "  x-telo-value-schema-from: /model/shape",
  "schema:",
  "  type: object",
  "  properties:",
  "    model: { x-telo-ref: { kind: Self.Thing, use: dependency } }",
  "---",
  "kind: Telo.Definition",
  "metadata: { name: User }",
  "capability: Telo.Invocable",
  "controllers:",
  "  - pkg:npm/none@0.0.0",
  "schema:",
  "  type: object",
  "  properties:",
  "    src: { x-telo-ref: { kind: Self.Thing, use: dependency } }",
  "---",
  "kind: Telo.Definition",
  "metadata: { name: Projector }",
  "capability: Telo.Invocable",
  "controllers:",
  "  - pkg:npm/none@0.0.0",
  "schema:",
  "  type: object",
  "  properties:",
  "    src: { x-telo-ref: { kind: Self.Thing, use: dependency } }",
  "    outputType: { type: object }",
  "---",
  "kind: Telo.Definition",
  "metadata: { name: Fitted }",
  "capability: Telo.Provider",
  "controllers:",
  "  - pkg:npm/none@0.0.0",
  "schema:",
  "  type: object",
  "  properties:",
  "    src: { x-telo-ref: { kind: Self.Thing, use: dependency } }",
  "    value: { x-telo-value-schema-from: /src/shape }",
  "---",
  "kind: Telo.Definition",
  "metadata: { name: Caller }",
  "capability: Telo.Invocable",
  "controllers:",
  "  - pkg:npm/none@0.0.0",
  "schema:",
  "  type: object",
  "  properties:",
  "    handler: { x-telo-ref: { kind: Self.Form, use: call, inputs: /inputs } }",
  "    inputs: { type: object }",
];

/** A `Thing` named `name` whose shape is `shape` — YAML lines under `shape:` —
 *  holding a member a flag varies and `p` entries, none of which is read. */
const thingDocs = (name: string, shape: readonly string[], p: number): string[] => [
  "kind: Self.Thing",
  `metadata: { name: ${name} }`,
  ...shape,
  "fields: { email: { type: text } }",
  "note: !if",
  `  if: !cel "variables.flag2"`,
  "  then: one",
  "  else: two",
  ...parkedEntries(p),
];

/** A shape a flag chooses: a record the rows' values fit, or an integer. */
const CHOSEN_SHAPE = ["shape: !if", `  if: !cel "variables.flag1"`, "  then: !ref Ctx", "  else: !ref Count"];

/** A template kind dispatching its body entry `inner` with an argument the
 *  entry's input contract types; `spare`, when given, is a second entry
 *  nothing dispatches. */
const wrapperDocs = (inner: string, spare?: string): string[] => [
  "kind: Telo.Definition",
  "metadata: { name: Wrapper }",
  "capability: Telo.Invocable",
  "resources:",
  "  - kind: Self.Form",
  "    metadata: { name: inner }",
  `    model: !ref ${inner}`,
  ...(spare ? ["  - kind: Self.Form", "    metadata: { name: spare }", `    model: !ref ${spare}`] : []),
  "invoke: !ref inner",
  "inputs: { a: x }",
];

/** A step and a slot passing an argument to `form`, a `Form` of `thing`. */
const DISPATCH_DOCS: readonly string[] = [
  "kind: Self.Form",
  "metadata: { name: form }",
  "model: !ref thing",
  "---",
  "kind: Run.Sequence",
  "metadata: { name: stepping }",
  "steps:",
  "  - name: call",
  "    invoke: !ref form",
  "    inputs: { a: x }",
  "---",
  "kind: Self.Caller",
  "metadata: { name: slotting }",
  "handler: !ref form",
  "inputs: { a: x }",
];

const relationReadApplication = (name: string, docs: readonly string[]): string =>
  [
    "kind: Telo.Application",
    `metadata: { name: ${name} }`,
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "---",
    ...RELATION_READ_KINDS,
    "---",
    ...docs,
    "",
  ].join("\n");

/**
 * One referent read through every relation reading a declaration by name:
 * `thing` holds a member a flag varies and `p` entries, none of which any
 * relation reads, and is read by an inline declaration left in place at an
 * unnamed step (`nesting`), a contract projected from it (`projected`), a template's
 * dispatched entry whose input contract is its shape (`Wrapper`), a value
 * typed across a reference to it (`fitted`), and a step and a slot passing an
 * argument to a declaration whose input contract is its shape (`stepping`,
 * `slotting`).
 */
export function relationPadding(p: number): string {
  return relationReadApplication("RelationPadding", [
    ...thingDocs("thing", ["shape: !ref Ctx"], p),
    "---",
    "kind: Run.Sequence",
    "metadata: { name: nesting }",
    "steps:",
    "  - invoke: { kind: Self.User, src: !ref thing }",
    "---",
    "kind: Self.Projector",
    "metadata: { name: projected }",
    "src: !ref thing",
    "outputType: { x-telo-schema-projection-from: /src }",
    "---",
    ...wrapperDocs("thing"),
    "---",
    "kind: Self.Fitted",
    "metadata: { name: fitted }",
    "src: !ref thing",
    `value: !cel "{'a': 'x'}"`,
    "---",
    ...DISPATCH_DOCS,
  ]);
}

/** A template's dispatched entry whose input contract is the shape of a thing
 *  a flag chooses: its `inputs:` fit one shape and not the other. */
export function derivedEntryChoice(): string {
  return relationReadApplication("DerivedEntryChoice", [...thingDocs("thing", CHOSEN_SHAPE, 0), "---", ...wrapperDocs("thing")]);
}

/** {@link derivedEntryChoice} with the varying thing behind an entry nothing
 *  dispatches: the dispatched entry's thing has one shape. */
export function derivedEntrySibling(): string {
  return relationReadApplication("DerivedEntrySibling", [
    ...thingDocs("steady", ["shape: !ref Ctx"], 0),
    "---",
    ...thingDocs("thing", CHOSEN_SHAPE, 0),
    "---",
    ...wrapperDocs("steady", "thing"),
  ]);
}

/** A step and a slot passing an argument to a declaration whose input
 *  contract is the shape of a thing a flag chooses. */
export function dispatchDerivedInput(): string {
  return relationReadApplication("DispatchDerivedInput", [...thingDocs("thing", CHOSEN_SHAPE, 0), "---", ...DISPATCH_DOCS]);
}

/** An expression held to the type at a location past a reference, whose
 *  target's shape a flag chooses. */
export function valueSchemaCrossingFit(): string {
  return relationReadApplication("ValueSchemaCrossingFit", [
    ...thingDocs("thing", CHOSEN_SHAPE, 0),
    "---",
    "kind: Self.Fitted",
    "metadata: { name: fitted }",
    "src: !ref thing",
    `value: !cel "{'a': 'x'}"`,
  ]);
}

/** A matcher naming a shape declared under a flag, an integer in one option
 *  and a string in the other, against an accessor typed as an integer. */
export function matchShapeChoice(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: MatchShape }",
    "variables:",
    ...flags(1),
    "--- !if",
    "metadata: { name: Amount }",
    `if: !cel "variables.flag1"`,
    "then:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: integer }",
    "else:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: string }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Show }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    shown:",
    "      type: object",
    "      x-telo-context:",
    "        type: object",
    "        properties:",
    "          row:",
    "            x-telo-context-eval: accessor",
    "            type: object",
    "            properties:",
    "              amount: { type: integer }",
    "      properties:",
    "        at: { x-telo-eval: accessor }",
    "        matches: { type: object, x-telo-match-for: /at }",
    "---",
    "kind: Self.Show",
    "metadata: { name: show }",
    "shown:",
    `  at: !cel "row.amount"`,
    '  matches: { $ref: "telo:MatchShape/Amount" }',
    "",
  ].join("\n");
}

/** A templated kind whose body entry names a module declaration holding a
 *  member a flag varies, which nothing reads. */
export function kindDocumentReferentChoice(): string {
  return relationReadApplication("KindDocumentReferentChoice", [
    "kind: Self.Thing",
    "metadata: { name: thing }",
    "shape: !ref Ctx",
    "note: !if",
    `  if: !cel "variables.flag1"`,
    "  then: one",
    "  else: two",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Holder }",
    "capability: Telo.Invocable",
    "resources:",
    "  - kind: Self.User",
    "    metadata: { name: inner }",
    "    src: !ref thing",
    "invoke: !ref inner",
  ]);
}

/**
 * The flat twin of {@link scopeMemberCrossing}: a top-level `src` whose step a
 * flag chooses, one option ill-typed, a top-level `via` of a templated kind
 * forwarding `self.src.steps`, and the holder invoking `via`.
 */
export function topLevelCrossing(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: TopLevelCrossing }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: ViaRef }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: Run.Sequence, use: dependency } }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.src.steps"`,
    "run: !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: src }",
    "steps:",
    "  - name: a",
    "    value: !if",
    `      if: !cel "variables.flag1"`,
    `      then: !cel "1 + 'x'"`,
    "      else: 2",
    "---",
    "kind: TopLevelCrossing.ViaRef",
    "metadata: { name: via }",
    "src: !ref src",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "steps:",
    "  - name: run",
    "    invoke: !ref via",
    "",
  ].join("\n");
}

/**
 * A crossing onward from a scope member: `with:` members `leaf` (a step a flag
 * chooses, one option ill-typed), `mid` of a kind with no body holding
 * `src: !ref leaf` (so no consumer of its own), and `via` of a templated kind
 * forwarding `self.src.src.steps` with `src: !ref mid` — so the reference
 * `via`'s forward reads on is held by the member `mid`, written after a member
 * the flag chooses. With `topLevel`, `leaf` and `mid` are top-level
 * declarations instead.
 */
export function scopeMemberOnwardCrossing(topLevel: boolean): string {
  const leaf = [
    "kind: Run.Sequence",
    "metadata: { name: leaf }",
    "steps:",
    "  - name: a",
    "    value: !if",
    `      if: !cel "variables.flag1"`,
    `      then: !cel "1 + 'x'"`,
    "      else: 2",
  ];
  const mid = ["kind: OnwardCrossing.Hold", "metadata: { name: mid }", "src: !ref leaf"];
  const member = (lines: string[]) => lines.map((line, i) => `${i === 0 ? "  - " : "    "}${line}`);
  return [
    "kind: Telo.Application",
    "metadata: { name: OnwardCrossing }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Hold }",
    "extends: Run.Value",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: Run.Sequence, use: dependency } }",
    "base:",
    "  value: 1",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: ViaMid }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    src: { x-telo-ref: { kind: OnwardCrossing.Hold, use: dependency } }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.src.src.steps"`,
    "run: !ref sequence",
    ...(topLevel ? ["---", ...leaf, "---", ...mid] : []),
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "with:",
    ...(topLevel
      ? []
      : [
          ...member(leaf),
          "  - !if",
          `    if: !cel "variables.flag1"`,
          "    then: { kind: Run.Sequence, metadata: { name: spare }, steps: [{ name: s, value: 0 }] }",
          ...member(mid),
        ]),
    ...member(["kind: OnwardCrossing.ViaMid", "metadata: { name: via }", "src: !ref mid"]),
    "steps:",
    "  - name: run",
    "    invoke: !ref via",
    "",
  ].join("\n");
}

/**
 * A misspelled `resources.<name>` read in a sequence whose `with:` scope holds
 * the member it meant, under a flag: refused naming every name in scope, the
 * member's among them — what a region holding the scope as its members'
 * identities still answers.
 */
export function scopeMemberMisspelled(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ScopeMisspelled }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Run.Value",
    "metadata: { name: other }",
    "value: 1",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "with:",
    "  - kind: Run.Sequence",
    "    metadata: { name: inner }",
    "    steps:",
    "      - { name: x, value: 1 }",
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.flag1"`,
    `      then: !cel "resources.innr"`,
    "      else: 3",
    "",
  ].join("\n");
}

/**
 * A sequence `holder` whose `with:` scope holds `other`, a member a step
 * invokes, and `padded`, a member nothing outside it reads holding `p` steps
 * each a `value: !if` on its own flag; the holder's own steps compute a value,
 * invoke `other` and read its result, the first choosing its value on
 * `variables.base`, so the holder has a choice whatever `p` is.
 */
export function scopePadding(p: number): string {
  const padded: string[] = [];
  for (let k = 1; k <= p; k++) {
    padded.push(
      `      - name: p${k}`,
      "        value: !if",
      `          if: !cel "variables.flag${k}"`,
      `          then: ${k}`,
      `          else: "off"`,
    );
  }
  return [
    "kind: Telo.Application",
    "metadata: { name: ScopePadding }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    "  base: { env: BASE, type: boolean, default: false }",
    ...flags(p),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "with:",
    "  - kind: Run.Sequence",
    "    metadata: { name: other }",
    "    steps:",
    "      - name: x",
    `        value: !cel "2 + 3"`,
    "  - kind: Run.Sequence",
    "    metadata: { name: padded }",
    "    steps:",
    "      - name: fixed",
    "        value: 0",
    ...padded,
    "steps:",
    "  - name: first",
    "    value: !if",
    `      if: !cel "variables.base"`,
    `      then: !cel "1 + 1"`,
    "      else: 3",
    "  - name: call",
    "    invoke: !ref other",
    "  - name: reader",
    `    value: !cel "steps.call.result"`,
    "",
  ].join("\n");
}

/**
 * A local templated kind whose body entry is of a local kind declaring
 * `status:` and receives a forwarded `self.text`, one consumer of it chosen by
 * a flag, and no other declaration of a kind that reports: only the consumer's
 * forward view makes the application report observed state.
 */
export function viewOnlyStatus(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ViewOnlyStatus }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Reporter }",
    "capability: Telo.Invocable",
    "schema:",
    "  type: object",
    "  properties:",
    "    text: { type: string }",
    "status:",
    "  type: object",
    "  properties:",
    "    ready: { type: boolean }",
    "resources:",
    "  - kind: Run.Value",
    "    metadata: { name: inner }",
    "    value: ok",
    "invoke: !ref inner",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapper }",
    "capability: Telo.Invocable",
    "schema:",
    "  type: object",
    "  properties:",
    "    text: { type: string }",
    "resources:",
    "  - kind: ViewOnlyStatus.Reporter",
    "    metadata: { name: reporter }",
    `    text: !cel "self.text"`,
    "invoke: !ref reporter",
    "--- !if",
    "metadata: { name: main }",
    `if: !cel "variables.flag1"`,
    "then:",
    "  kind: ViewOnlyStatus.Wrapper",
    "  text: hello",
    "",
  ].join("\n");
}

/**
 * A step a flag declares, before a step whose target is an inline consumer of
 * a local templated kind — no name of its own — forwarding steps into its body,
 * one of them ill-typed: the name a run gives the consumer holds its step's
 * index, so it differs between the flag's values.
 */
export function shiftedConsumerName(): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: ShiftedName }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(1),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapped }",
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    "    steps: { type: array }",
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "self.steps"`,
    "run: !ref sequence",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "steps:",
    "  - !if",
    `    if: !cel "variables.flag1"`,
    "    then: { name: first, value: 0 }",
    "  - name: call",
    "    invoke:",
    "      kind: ShiftedName.Wrapped",
    "      steps:",
    "        - name: a",
    `          value: !cel "1 + 'x'"`,
    "",
  ].join("\n");
}

/**
 * A consumer whose body forwards `self.src.steps` exactly, `src` naming — in a
 * branch no configuration takes (an `!if` on the module's own version) — a
 * consumer of another local templated kind whose steps target an inline
 * sequence A, which holds an inline value B as the target of its own step,
 * written before A's own expression: the view draws A out and A draws B out,
 * so a run meets A's expression before B's although B's is written first.
 * Every expression is reported at the reference, and each fills a result slot
 * of its own type there.
 */
export function drawnOutOrder(): string {
  const forwarding = (name: string, field: string, kind: string, source: string) => [
    "kind: Telo.Definition",
    `metadata: { name: ${name} }`,
    "capability: Telo.Runnable",
    "schema:",
    "  type: object",
    "  properties:",
    `    ${field}: ${kind}`,
    "resources:",
    "  - kind: Run.Sequence",
    "    metadata: { name: sequence }",
    `    steps: !cel "${source}"`,
    "run: !ref sequence",
  ];
  return [
    "kind: Telo.Application",
    "metadata: { name: DrawnOrder, version: 1.0.0 }",
    "imports:",
    `  Run: ${RUN}`,
    "targets:",
    "  - !ref viaRef",
    "---",
    ...forwarding("Holder", "steps", "{ type: array }", "self.steps"),
    "---",
    ...forwarding("ViaRef", "src", "{ x-telo-ref: { kind: DrawnOrder.Holder, use: dependency } }", "self.src.steps"),
    "---",
    "kind: DrawnOrder.Holder",
    "metadata: { name: spare }",
    "steps:",
    "  - { name: idle, value: 0 }",
    "---",
    "kind: DrawnOrder.Holder",
    "metadata: { name: holder }",
    "steps:",
    "  - name: outer",
    "    invoke:",
    "      kind: Run.Sequence",
    "      steps:",
    "        - name: inner",
    "          invoke:",
    "            kind: Run.Value",
    "            outputType: { kind: Telo.JsonSchema, schema: { type: integer } }",
    `            value: !cel "1"`,
    "      outputType:",
    "        kind: Telo.JsonSchema",
    "        schema: { type: object, properties: { r: { type: string } } }",
    `      outputs: { r: !cel "'text'" }`,
    "---",
    "kind: DrawnOrder.ViaRef",
    "metadata: { name: viaRef }",
    "src: !if",
    `  if: !cel "module.version == '1.0.0'"`,
    "  then: !ref spare",
    "  else: !ref holder",
    "",
  ].join("\n");
}

/**
 * A step a flag declares, then a step whose `invoke:` is an inline sequence —
 * with or without a leading step — holding the places a relation reader
 * declares: a call input against its type, the same under an inner flag, and
 * the sequence's own outputs against its `outputType`, ill-typed in one
 * option; and, beside them, the places the step readers declare (its own
 * `inputType`, an earlier step's result) and an inline value against its
 * `outputType`, and a plain CEL type error and a schema violation. The inline
 * sequence sits at a projected index of its holder that differs between the
 * outer flag's values. The inline declarations are nameless unless `named`.
 */
export function nestedInlinePlaces(lead: boolean, named = false): string {
  const name = (n: string, indent: string) => (named ? [`${indent}metadata: { name: ${n} }`] : []);
  return [
    "kind: Telo.Application",
    "metadata: { name: NestedPlaces }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    ...flags(2),
    "targets:",
    "  - !ref holder",
    "---",
    "kind: Run.Value",
    "metadata: { name: taker }",
    "inputType:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: string } } }",
    "value: 1",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: holder }",
    "steps:",
    "  - !if",
    `    if: !cel "variables.flag1"`,
    "    then: { name: first, value: 0 }",
    "  - name: outer",
    "    invoke:",
    "      kind: Run.Sequence",
    ...name("inner", "      "),
    "      inputType:",
    "        kind: Telo.JsonSchema",
    "        schema: { type: object, properties: { x: { type: integer } } }",
    "      steps:",
    ...(lead ? ["        - { name: lead, value: 0 }"] : []),
    "        - name: plain",
    "          invoke: !ref taker",
    `          inputs: { a: !cel "1" }`,
    "        - !if",
    `          if: !cel "variables.flag2"`,
    "          then:",
    "            name: guarded",
    "            invoke: !ref taker",
    `            inputs: { a: !cel "1" }`,
    "        - name: forward",
    "          invoke: !ref taker",
    `          inputs: { a: !cel "inputs.x" }`,
    "        - name: chained",
    "          invoke: !ref taker",
    `          inputs: { a: !cel "steps.plain.result" }`,
    `        - { name: broken, value: !cel "1 + 'x'" }`,
    `        - { name: slow, invoke: !ref taker, timeout: 0, inputs: { a: !cel "'text'" } }`,
    "        - name: valued",
    "          invoke:",
    "            kind: Run.Value",
    ...name("valuedInline", "            "),
    "            outputType: { kind: Telo.JsonSchema, schema: { type: integer } }",
    `            value: !cel "'text'"`,
    "        - !if",
    `          if: !cel "variables.flag2"`,
    "          then:",
    "            name: guardedValue",
    "            invoke:",
    "              kind: Run.Value",
    ...name("guardedInline", "              "),
    "              outputType: { kind: Telo.JsonSchema, schema: { type: integer } }",
    `              value: !cel "'text'"`,
    "      outputType:",
    "        kind: Telo.JsonSchema",
    "        schema: { type: object, properties: { r: { type: integer } } }",
    "      outputs:",
    "        r: !if",
    `          if: !cel "variables.flag2"`,
    `          then: !cel "'text'"`,
    `          else: !cel "1"`,
    "",
  ].join("\n");
}

/** The most choices a per-fixture sweep (the parity, differential and
 *  quoted-place checks) reads of a generated fixture: each analyses every
 *  configuration, 2^N of them. The cost tests measure past it. */
export const SWEPT_CHOICES = 3;

/** Every generated application the corpus records: name → text. */
export function generatedCorpus(maxChoices = 4): Map<string, string> {
  const out = new Map<string, string>();
  for (const shape of ["isolated", "reached"] as const) {
    for (const n of [0, 1, 2, 4] as const) {
      if (n <= maxChoices) out.set(`configuration-cost-${shape}-${n}.yaml`, costApplication(shape, n));
    }
  }
  for (const n of [1, 8, 16]) out.set(`template-definition-cost-${n}.yaml`, costLibrary(n));
  for (let n = 1; n <= maxChoices; n++) {
    out.set(`flag-sequence-${n}.yaml`, flagSequence(n));
    out.set(`flag-targets-${n}.yaml`, flagTargets(n));
  }
  out.set("nested-dead-branch.yaml", nestedDeadBranch());
  out.set("care-identity.yaml", careIdentity());
  return out;
}

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/** `text` loaded as `tests/__generated__/<name>`, with every module it imports. */
export async function loadGenerated(name: string, text: string) {
  const entry = join(GENERATED, name);
  const source: ManifestSource = {
    supports: fileSource.supports,
    read: async (url) => (url === entry ? { text, source: entry } : fileSource.read(url)),
    resolveRelative: fileSource.resolveRelative,
  };
  const graph = await new Loader([source]).loadGraph(entry, { desugarImports: true });
  return { graph, manifests: flattenForAnalyzer(graph), moduleDocuments: collectModuleDocuments(graph) };
}
