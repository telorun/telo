/**
 * The schema carve: a reference beneath a keyword relating members (`anyOf`,
 * `oneOf`, `not`, `if` / `then` / `else`, `dependentSchemas` / `dependencies`,
 * `contains`, tuple `items`) to a named shape some configuration varies.
 *
 * In a key's door the reference resolves to a stand-in holding the validator
 * keyword `schemaCarve`, which answers the carve's sub-verdict at each data
 * position from the decision summary the door's carve table holds there: valid
 * where the class is clean, else one error naming the carve, which the union
 * judge (`schema-findings-judge.ts`) turns into the carve's own findings. The
 * keyword answers only for the stand-in tokens a door issued, recognised by
 * identity; any other value — an authored `schemaCarve`, whatever it holds —
 * contributes nothing, as an unknown keyword does.
 *
 * Browser-safe; imports only the union reading, so the registry and the judge
 * import it alone.
 */
import { constrainedPlaces, jsonTypeOf, refusesJsonType, type ReferenceReader } from "./union-tags.js";

/** One finding a carve's class reports at its own position or a constrained
 *  place: the keyword, its place relative to the carve's position, and the
 *  union reporting it there, if one did. */
export interface CarveFinding {
  readonly keyword: string;
  readonly at: string;
  readonly via?: { readonly at: string; readonly outcome: string };
}

/** What a {@link CarveFinding} reads as: its params, message and, for a union
 *  reporting its alternatives, their phrases. */
export interface CarveLiteralText {
  readonly params: Record<string, unknown>;
  readonly message: string;
  readonly phrases?: readonly string[];
}

/** A carve read at a data position, by the summary it answers there. */
export interface CarvePlace {
  readonly carve: string;
  readonly place: string;
}

/** The summaries, text resolved, of the carves a text reads. */
export type CarveTextResolver = (carve: string, place: string) => SchemaCarveSummary;

/** A finding phrased over carves' texts: what it reads, and its text once
 *  each of those is resolved. */
export interface CarveTextRead<T> {
  readonly reads: readonly CarvePlace[];
  render(resolve: CarveTextResolver): T;
}

/**
 * The text of a {@link CarveFinding}: its own class's literal, a reference to
 * the finding of an inner carve it passes through, or — a finding of its own
 * phrased over inner carves' texts, a union's alternatives or tag — that
 * phrasing, resolved where the text is read.
 */
export type CarveFindingText =
  | CarveLiteralText
  | { readonly ref: CarvePlace & { readonly index: number } }
  | { readonly rebuild: CarveTextRead<CarveLiteralText> };

/** A reported finding phrased over carves' texts, as its message reads. */
export interface CarveTextReading extends CarveTextRead<string> {
  readonly old: string;
}

export function isLiteralCarveText(text: CarveFindingText): text is CarveLiteralText {
  return "params" in text;
}

/** What a relating keyword reads of a carve at one data position. */
export interface SchemaCarveSummary {
  /** The validator raised nothing at or beneath the position. */
  readonly clean: boolean;
  /** The class does not refuse the value's JSON type there. */
  readonly candidate: boolean;
  /** The places, relative to the position, the class constrains by `const` / `enum`. */
  readonly constrained: readonly string[];
  /** The members the class requires at the position. */
  readonly required: readonly string[];
  /** The class reports anything at or beneath the position. */
  readonly reports: boolean;
  readonly findings: readonly CarveFinding[];
  /** The text of each of {@link findings}, in order. */
  readonly text: readonly CarveFindingText[];
}

export const SCHEMA_CARVE_KEYWORD = "schemaCarve";

/** The decision part of a summary: all a key splits on. */
export function carveDecisionText(summary: SchemaCarveSummary): string {
  return JSON.stringify([
    summary.clean,
    summary.candidate,
    summary.constrained,
    summary.required,
    summary.reports,
    summary.findings.map((f) => [f.keyword, f.at, f.via?.at ?? null, f.via?.outcome ?? null]),
  ]);
}

/** The schema a union's candidates, tags and selectors are read from for a
 *  carve at one position: its decision part as schema keywords. */
export function carveReadingSchema(summary: SchemaCarveSummary): Record<string, unknown> {
  const node: Record<string, any> = {};
  if (!summary.candidate) node.type = [];
  if (summary.required.length > 0) node.required = [...summary.required];
  for (const place of summary.constrained) {
    let at = node;
    for (const raw of place.split("/").slice(1)) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      at.properties ??= {};
      at = at.properties[segment] ??= {};
    }
    at.const = null;
  }
  return node;
}

/** One door's carves: the tokens it issued, what each answers per data
 *  position, and what its judgement observed. */
export interface CarveContext {
  /** Each issued stand-in token, by identity, and the carve it stands for. */
  readonly tokens: Map<object, string>;
  /** Each carve's summary, by absolute JSON Pointer of its data position. */
  readonly table: Map<string, Map<string, SchemaCarveSummary>>;
  /** Where the value a branch is validated alone lies in the judged value. */
  offset: string;
  /** Each carve whose findings an enclosing keyword reported, as
   *  `JSON.stringify([carve, place])`: its pass-through. */
  readonly passed: Set<string>;
  /** Each finding it reports phrased over carves' texts: its text as judged
   *  and as each resolution of those texts renders it. */
  readonly textReads: CarveTextReading[];
  /** A sub-verdict's position: its summary is recorded off the validation
   *  made while {@link recording}. */
  readonly focus?: { readonly pointer: string; recording: boolean; summary?: SchemaCarveSummary };
}

const issued = new WeakSet<object>();
const contexts: CarveContext[] = [];

export function newCarveContext(focus?: string): CarveContext {
  return {
    tokens: new Map(),
    table: new Map(),
    offset: "",
    passed: new Set(),
    textReads: [],
    ...(focus !== undefined ? { focus: { pointer: focus, recording: false } } : {}),
  };
}

/** A fresh stand-in token of `ctx` for `carve`. */
export function issueCarveToken(ctx: CarveContext, carve: string): object {
  const token = {};
  issued.add(token);
  ctx.tokens.set(token, carve);
  return token;
}

/** Whether `value` is a token some door issued: kept as it is by every copy a
 *  schema takes on its way into a validator. */
export function isCarveToken(value: unknown): boolean {
  return typeof value === "object" && value !== null && issued.has(value);
}

export function withCarveContext<T>(ctx: CarveContext, body: () => T): T {
  contexts.push(ctx);
  try {
    return body();
  } finally {
    contexts.pop();
  }
}

export function currentCarveContext(): CarveContext | undefined {
  return contexts[contexts.length - 1];
}

/** `body`, a branch validated alone at `at` of the judged value. */
export function withCarveOffset<T>(at: string | undefined, body: () => T): T {
  const ctx = currentCarveContext();
  if (!ctx || at === undefined) return body();
  const outer = ctx.offset;
  ctx.offset = at;
  try {
    return body();
  } finally {
    ctx.offset = outer;
  }
}

/** Whether the current door is reading a sub-verdict's summary off the
 *  validation now being made: it is judged even where the validator passed. */
export function isRecordingCarveFocus(): boolean {
  return currentCarveContext()?.focus?.recording === true;
}

/** `body`, the validation a sub-verdict's summary is read off. */
export function recordingCarveFocus<T>(body: () => T): T {
  const focus = currentCarveContext()?.focus;
  if (!focus) return body();
  focus.recording = true;
  try {
    return body();
  } finally {
    focus.recording = false;
  }
}

/** The summary `ctx` holds for the token `value` at `place`, if any. */
export function carveSummaryAt(value: unknown, place: string): { carve: string; summary: SchemaCarveSummary } | undefined {
  const ctx = currentCarveContext();
  if (!ctx || typeof value !== "object" || value === null) return undefined;
  const carve = ctx.tokens.get(value);
  if (carve === undefined) return undefined;
  const summary = ctx.table.get(carve)?.get(place);
  return summary ? { carve, summary } : undefined;
}

/** Registers the `schemaCarve` keyword on `ajv`: valid wherever the current
 *  door holds no refusing summary for the token at the data position. */
export function registerSchemaCarveKeyword(ajv: { addKeyword(definition: any): unknown }): void {
  ajv.addKeyword({
    keyword: SCHEMA_CARVE_KEYWORD,
    compile(value: unknown) {
      // AJV passes the data first and the data context second.
      const validate = (...args: [unknown, { instancePath?: string }?]): boolean => {
        const cxt = args[1];
        const ctx = currentCarveContext();
        const found = ctx ? carveSummaryAt(value, `${ctx.offset}${cxt?.instancePath ?? ""}`) : undefined;
        if (!found || found.summary.clean) return true;
        (validate as { errors?: unknown }).errors = [
          { keyword: SCHEMA_CARVE_KEYWORD, params: { carve: found.carve }, message: "is refused by a schema carve" },
        ];
        return false;
      };
      return validate;
    },
  });
}

/** A judged finding as the judge shows it to {@link observeCarveJudgement}. */
export interface ObservedFinding {
  readonly finding: {
    readonly keyword?: string;
    readonly instancePath?: string;
    readonly params?: Record<string, unknown>;
    readonly message?: string;
  };
  readonly via?: { readonly place: string; readonly outcome: string; readonly phrases?: readonly string[] };
  readonly carve?: { readonly carve: string; readonly place: string; readonly marker: boolean; readonly index?: number };
  /** A finding of its own phrased over carves' texts: how it is phrased once
   *  they are resolved. */
  readonly textRead?: CarveTextRead<{ readonly finding: ObservedFinding["finding"]; readonly phrases?: readonly string[] }>;
}

function within(path: string, pointer: string): boolean {
  return pointer === "" || path === pointer || path.startsWith(`${pointer}/`);
}

function valueAtPointer(root: unknown, pointer: string): unknown {
  let at = root;
  for (const raw of pointer.split("/").slice(1)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at;
}

/** The node of a sub-verdict's focused schema at `pointer`: the reference. */
function focusedNodeAt(schema: unknown, pointer: string): object | undefined {
  let at = schema as Record<string, any> | undefined;
  for (const raw of pointer.split("/").slice(1)) {
    if (!at) return undefined;
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    at = /^\d+$/.test(segment) && Array.isArray(at.items) ? at.items[Number(segment)] : at.properties?.[segment];
  }
  return at && typeof at === "object" ? at : undefined;
}

/** The members `node` requires at its own node, through `$ref` and `allOf`. */
function requiredAt(node: object, read: ReferenceReader): string[] {
  const out: string[] = [];
  const visit = (each: unknown, seen: Set<object>): void => {
    if (!each || typeof each !== "object" || Array.isArray(each) || seen.has(each)) return;
    seen.add(each);
    const schema = each as Record<string, unknown>;
    if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === "string" && !out.includes(name)) out.push(name);
    if (typeof schema.$ref === "string") visit(read(schema, schema.$ref, ""), seen);
    if (Array.isArray(schema.allOf)) for (const member of schema.allOf) visit(member, seen);
  };
  visit(node, new Set());
  return out;
}

/**
 * What a door's judgement of one validation says of its carves: each carve
 * whose findings survive in what it reports, and — the validation a
 * sub-verdict's summary is read off — that summary at the focused position.
 */
export function observeCarveJudgement(
  ctx: CarveContext,
  judged: readonly ObservedFinding[],
  raised: readonly { readonly instancePath?: string }[],
  value: unknown,
  schema: object,
  read: ReferenceReader,
  /** What an absolute `$ref` in the validated schema itself names at `at`. */
  absolute: (ref: string, at: string) => object | undefined,
  /** A finding's message as the validation reports it. */
  issueText: (finding: ObservedFinding["finding"]) => string,
): void {
  for (const entry of judged) {
    if (entry.carve) ctx.passed.add(JSON.stringify([entry.carve.carve, entry.carve.place]));
    const read = entry.textRead;
    if (read && !entry.carve) {
      ctx.textReads.push({ old: issueText(entry.finding), reads: read.reads, render: (resolve) => issueText(read.render(resolve).finding) });
    }
  }
  const focus = ctx.focus;
  if (!focus?.recording) return;
  const pointer = focus.pointer;
  const node = focusedNodeAt(schema, pointer);
  const reader: ReferenceReader = (at, ref, below) =>
    at === node ? absolute(ref, `${pointer}${below ?? ""}`) : read(at, ref, `${pointer}${below ?? ""}`);
  const constrained = node ? [...constrainedPlaces(node, reader)] : [];
  const entries = judged.filter((entry) => within(entry.finding.instancePath ?? "", pointer));
  const findings: CarveFinding[] = [];
  const text: CarveFindingText[] = [];
  for (const { finding, via, carve, textRead } of entries) {
    if (carve?.marker) continue;
    const at = (finding.instancePath ?? "").slice(pointer.length);
    if (at !== "" && !constrained.includes(at)) continue;
    findings.push({
      keyword: finding.keyword ?? "",
      at,
      ...(via ? { via: { at: within(via.place, pointer) ? via.place.slice(pointer.length) : via.place, outcome: via.outcome } } : {}),
    });
    // An inner carve's finding is its summary's; one phrased over inner carves'
    // texts is phrased where it is read.
    if (carve && carve.index !== undefined) text.push({ ref: { carve: carve.carve, place: carve.place, index: carve.index } });
    else if (textRead) {
      text.push({
        rebuild: {
          reads: textRead.reads,
          render: (resolve) => {
            const rebuilt = textRead.render(resolve);
            return { params: rebuilt.finding.params ?? {}, message: rebuilt.finding.message ?? "", ...(rebuilt.phrases ? { phrases: rebuilt.phrases } : {}) };
          },
        },
      });
    } else text.push({ params: finding.params ?? {}, message: finding.message ?? "", ...(via?.phrases ? { phrases: via.phrases } : {}) });
  }
  focus.summary = {
    clean: !raised.some((error) => within(error.instancePath ?? "", pointer)),
    candidate: node ? !refusesJsonType(node, jsonTypeOf(valueAtPointer(value, pointer)), reader) : true,
    constrained,
    required: node ? requiredAt(node, reader) : [],
    reports: entries.length > 0,
    findings,
    text,
  };
}
