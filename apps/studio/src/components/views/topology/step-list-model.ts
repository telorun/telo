import { isRecord } from "../../../lib/utils";
import {
  branchListBranchKey,
  branchListPredicateKey,
  buildEditableSchema,
  buildUnclassifiedSchema,
  getVariantSymbol,
  matchVariant,
  stepInputsField,
  type VariantMeta,
} from "../../../schema-utils";
import type { TypeSignature } from "./application-canvas-model";
import { refTargetName } from "./overview-graph";
import { authoredText } from "./value-summary";

/**
 * A step body, read as the ordered thing it is.
 *
 * A step array and an Application's `targets:` are the same shape — the shared
 * `InvokeStep` fragment, `{ invoke, inputs, when, retry, name? }` — so this is
 * {@link readBootTarget} generalized rather than a second reader: what a body
 * adds is NESTING (`then` / `else` / `cases` / `elseif`), not a different entry.
 * `boot-model.ts` stays the flat special case and reads its expression text from
 * here, which is the direction that keeps one answer to "what did the author
 * write in this slot".
 *
 * Every row carries the JSON POINTER of the entry and of the array holding it,
 * because that is what an edit needs: a reorder is confined to one array, and a
 * removal names one node. Nothing here rebuilds the array from data — see
 * `RootLevel`'s note on why a positional field diff loses `!ref` tags, quote
 * styles and comments.
 *
 * Fully annotation-driven (`x-telo-topology-role`), so it reads any kind that
 * carries a step body — `Run.Sequence`, `Sql.Transaction`, a durable workflow —
 * and names none of them.
 */

/** Where a step's arguments live and what they must satisfy. Present only when
 *  the invoked resource declares an input contract: with no `properties` and no
 *  value schema the form falls through to its JSON-SCHEMA editor, which would
 *  write a schema declaration where arguments belong. */
export interface StepInputs {
  pointer: string;
  schema: Record<string, unknown>;
}

/** A body this step COULD still declare but has not.
 *
 *  The list renders only what is in the manifest, which is right for reading it
 *  and is what left an optional branch — an `else`, a `default`, a `catch` —
 *  with no way into the document at all: the step form deliberately leaves
 *  bodies out, and the list had nothing to show. So the vocabulary the variant
 *  allows is carried here, with the value that creates each one. */
export interface StepAddition {
  /** The field to write. */
  field: string;
  /** How that field holds bodies, which decides what creating one means: a
   *  `branch` is written whole, a `case-map` gains an author-named key, a
   *  `branch-list` gains one more condition/body pair. */
  form: "branch" | "case-map" | "branch-list";
  /** What to write — an empty body, or a fresh else-if pair. */
  seed: unknown;
}

/** One nested body owned by a control-flow step. */
export interface StepBranch {
  /** How the branch reads — its field name (`then`, `else`, `do`), a case key,
   *  or an else-if's own condition. */
  label: string;
  /** JSON pointer to the ARRAY, which is the scope a reorder inside it stays
   *  within. */
  pointer: string;
  entries: StepEntry[];
}

export interface StepEntry {
  /** JSON pointer to this entry, e.g. `/steps/0/then/1`. Identity and the
   *  target of every edit this row makes. */
  pointer: string;
  /** JSON pointer to the array this entry lives in. */
  containerPointer: string;
  index: number;
  depth: number;
  /** `name:`, when the author gave one — what makes the result reachable as
   *  `steps.<name>.result`. */
  stepName?: string;
  /** The resource this step invokes, when it invokes one. */
  target?: string;
  /** The step names a resource this module does not declare. Reported rather
   *  than hidden: a body pointing at nothing is why a run fails. */
  unresolved: boolean;
  /** Control-flow keyword (`if`, `while`, `switch`, `try`) — absent for a
   *  dispatch, which is named by its target instead. */
  keyword?: string;
  /** Single-character glyph for the keyword, from the variant's role pattern. */
  symbol?: string;
  /** The predicate, discriminator or guard as authored. */
  when?: string;
  inputs?: StepInputs;
  /** Argument names currently written, so a row can say whether it carries any
   *  without the reader opening it. */
  inputKeys?: string[];
  /** What the step produces, when its target declares it. */
  output?: TypeSignature;
  /** The schema the detail panel edits this step through — the step's own
   *  fields, with the bodies the list already renders left out. A step that
   *  matches no variant is edited through the vocabulary that would make it one
   *  (see {@link buildUnclassifiedSchema}). */
  schema: Record<string, unknown>;
  /** False when the step declares nothing that says what it does — a fresh
   *  dispatch before its target is picked, or an author's half-written step.
   *  Rendered as unfinished rather than as unreadable: the two look identical
   *  in the manifest and only one of them is the reader's fault. */
  classified: boolean;
  branches: StepBranch[];
  /** Bodies this step can still be given — see {@link StepAddition}. */
  additions: StepAddition[];
}

/** The declared call signature of one resource, as the canvas already resolved
 *  it. Passed in rather than re-derived so the list and the canvas cannot
 *  disagree about what a step's target takes and returns. */
export interface StepTargetSignature {
  input?: TypeSignature;
  output?: TypeSignature;
}

/** A `when:` / `if:` / `switch:` as the author wrote it — a CEL sentinel's
 *  source, or a literal. The sentinel's shape is templating's to know, so the
 *  test goes through its own predicate rather than being spelled out again. */
export const conditionText = authoredText;

/** Escapes one JSON Pointer segment — a case key is author-written and may hold
 *  a `/` or a `~`. */
function segment(key: string | number): string {
  return typeof key === "number"
    ? String(key)
    : key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export interface StepListOptions {
  /** The step array, as authored. */
  steps: readonly unknown[];
  /** Resolved items schema of the steps field. */
  stepSchema: Record<string, unknown>;
  variants: VariantMeta[];
  /** The kind schema the step schema was resolved against — `$ref` root. */
  root: Record<string, unknown>;
  /** JSON pointer to the steps array itself, e.g. `/steps`. */
  pointer: string;
  /** Every resource this module declares, for the unresolved check. */
  declared: ReadonlySet<string>;
  /** A step target's declared input / output shapes, when the host can resolve
   *  them. Optional: the panel that renders this list has no module graph to
   *  read them from, and a row without a signature is a row that says less
   *  rather than one that says something wrong. */
  signatureOf?: (resourceName: string) => StepTargetSignature | undefined;
}

/** Reads one step body into ordered rows, descending into every branch. */
export function buildStepList(options: StepListOptions): StepEntry[] {
  return readContainer(options.steps, options.pointer, 0, options);
}

function readContainer(
  steps: readonly unknown[],
  containerPointer: string,
  depth: number,
  options: StepListOptions,
): StepEntry[] {
  return steps.map((step, index) =>
    readEntry(step, containerPointer, index, depth, options),
  );
}

function readEntry(
  step: unknown,
  containerPointer: string,
  index: number,
  depth: number,
  options: StepListOptions,
): StepEntry {
  const { stepSchema, variants, root, declared, signatureOf } = options;
  const data = isRecord(step) ? step : {};
  const variant = matchVariant(data, variants);
  const pointer = `${containerPointer}/${index}`;

  const target = variant?.invokeField ? refTargetName(data[variant.invokeField]) : undefined;
  const signature = target ? signatureOf?.(target) : undefined;
  const inputsField = stepInputsField(stepSchema, variant);
  const written = isRecord(data[inputsField]) ? (data[inputsField] as Record<string, unknown>) : null;
  const inputSchema = signature?.input?.schema;

  // A dispatch is named by its target; a control-flow block by its keyword,
  // which is the first segment of the variant's title (`if/then/else` → `if`).
  const keyword = variant && !variant.invokeField ? keywordOf(variant) : undefined;
  const symbol = variant ? getVariantSymbol(variant) : null;
  const guard = guardOf(data, variant);

  return {
    pointer,
    containerPointer,
    index,
    depth,
    ...(typeof data.name === "string" && data.name ? { stepName: data.name } : {}),
    ...(target ? { target } : {}),
    unresolved: !!target && !declared.has(target),
    ...(keyword ? { keyword } : {}),
    ...(symbol ? { symbol } : {}),
    ...(guard ? { when: guard } : {}),
    ...(inputSchema ? { inputs: { pointer: `${pointer}/${inputsField}`, schema: inputSchema } } : {}),
    ...(written ? { inputKeys: Object.keys(written) } : {}),
    ...(signature?.output ? { output: signature.output } : {}),
    classified: variant !== null,
    schema: variant
      ? buildEditableSchema(stepSchema, variant, root)
      : buildUnclassifiedSchema(stepSchema, root),
    branches: variant ? readBranches(data, variant, pointer, depth, options) : [],
    additions: variant ? readAdditions(data, variant, root) : [],
  };
}

/** The control-flow keyword a variant introduces. A title reads `if/then/else`
 *  or `while/do`, so the first segment is the keyword and the rest names the
 *  branches this list already labels itself. */
function keywordOf(variant: VariantMeta): string | undefined {
  const title = variant.title.trim();
  if (!title) return undefined;
  return title.split("/")[0]!.trim() || undefined;
}

/** The expression that decides whether — or how long — this step runs. The
 *  variant's own predicate / discriminator first, since that is the one the
 *  schema named; a plain dispatch's `when:` guard otherwise. */
function guardOf(
  data: Record<string, unknown>,
  variant: VariantMeta | null,
): string | undefined {
  const field = variant?.predicateFields[0] ?? variant?.discriminatorFields[0];
  if (field) return conditionText(data[field]);
  return conditionText(data.when);
}

/** What the variant allows that the step has not written. A case map is always
 *  offerable — its keys are the author's, so there is no "already has them"
 *  state — and so is an else-if list, which is a sequence rather than a slot. */
function readAdditions(
  data: Record<string, unknown>,
  variant: VariantMeta,
  root: Record<string, unknown>,
): StepAddition[] {
  const out: StepAddition[] = [];
  for (const field of variant.branchFields) {
    if (Array.isArray(data[field])) continue;
    out.push({ field, form: "branch", seed: [] });
  }
  for (const field of variant.caseMaps) {
    out.push({ field, form: "case-map", seed: [] });
  }
  for (const field of variant.branchLists) {
    out.push({
      field,
      form: "branch-list",
      seed: {
        [branchListPredicateKey(variant, field, root)]: false,
        [branchListBranchKey(variant, field, root)]: [],
      },
    });
  }
  return out;
}

function readBranches(
  data: Record<string, unknown>,
  variant: VariantMeta,
  pointer: string,
  depth: number,
  options: StepListOptions,
): StepBranch[] {
  const branches: StepBranch[] = [];

  // Only a branch the author actually WROTE is rendered. An optional one the
  // variant merely allows (a `switch` with no `default:`, an `if` with no
  // `else:`) has no array in the manifest, so a row dropped into it would name a
  // path that is not there — an edit that silently does nothing. Creating the
  // branch is the step form's job; this list shows what the body contains.
  for (const field of variant.branchFields) {
    if (!Array.isArray(data[field])) continue;
    const at = `${pointer}/${segment(field)}`;
    branches.push({
      label: field,
      pointer: at,
      entries: readContainer(data[field] as unknown[], at, depth + 1, options),
    });
  }

  // A case map's keys are the author's, so they are the labels — and they are
  // escaped into the pointer rather than interpolated, since a key may hold a
  // `/` and would otherwise name a path that is not there.
  for (const field of variant.caseMaps) {
    const cases = isRecord(data[field]) ? data[field] : {};
    for (const [key, value] of Object.entries(cases)) {
      if (!Array.isArray(value)) continue;
      const at = `${pointer}/${segment(field)}/${segment(key)}`;
      branches.push({
        label: `${field}: ${key}`,
        pointer: at,
        entries: readContainer(value, at, depth + 1, options),
      });
    }
  }

  // An else-if is a list of condition/branch pairs, so its label carries the
  // CONDITION: `elseif 1` says nothing a reader wants, and the branches are
  // otherwise indistinguishable from each other.
  for (const field of variant.branchLists) {
    const branchKey = branchListBranchKey(variant, field, options.root);
    const predicateKey = branchListPredicateKey(variant, field, options.root);
    asArray(data[field]).forEach((entry, k) => {
      const record = isRecord(entry) ? entry : {};
      if (!Array.isArray(record[branchKey])) return;
      const at = `${pointer}/${segment(field)}/${k}/${segment(branchKey)}`;
      const condition = conditionText(record[predicateKey]);
      branches.push({
        label: condition ? `${field}: ${condition}` : `${field} ${k + 1}`,
        pointer: at,
        entries: readContainer(record[branchKey] as unknown[], at, depth + 1, options),
      });
    });
  }

  return branches;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
