/**
 * **The built-in text vocabulary at creation** — the runtime half of
 * `validate-texts.ts`, over the analyzer's readers (`text-slot.ts`,
 * `text-judgement.ts`, `text-schemas.ts`).
 *
 * At the kernel's single instance-production site every text a resource holds is
 * judged as the module that WROTE it writes, and every `Text` its controller
 * receives is handed over as the closed record `{ text, context, lang, computed }`.
 *
 * WHO WROTE A VALUE is a PROVENANCE: per field path, the language of the module
 * whose document holds the value and whether an expression produced it. A
 * resource's own fields are its declaring module's — for a template body's entry
 * the library defining the template, for the parent instance a `base:` child
 * builds the module declaring the child — except where a value was FORWARDED: a
 * bare `self.<path>` in a template body or a `base:` mapping carries the
 * consumer's origin through every hop. The forwarding controller records the
 * provenance of the manifest it hands on; it is internal, keyed by object
 * identity, and never written into a manifest.
 *
 * A controller that forwards — a template's, an inherited `base:` child's —
 * receives the text as written; every other controller receives records. A
 * declaration, and what Phase-5 injection mutates, keeps the text as written: the
 * records live on a copy the controller holds, kept in step with the declaration's
 * injected references by {@link syncInjectedReferences}.
 *
 * A value still compiled after creation — a field the controller evaluates per
 * call — is settled when it is evaluated ({@link LateTexts}): which expressions
 * bear text, and who wrote them, is fixed at creation.
 */
import {
  isCelRecord,
  isCompiledValue,
  isTextRecord,
  readMessage,
  readText,
  RuntimeError,
  type Message,
  type MessageSource,
  type ResourceManifest,
  type TextRecord,
} from "@telorun/sdk";
import {
  catalogComputedProblem,
  catalogsComputedAbove,
  judgeCatalog,
  isTextOrRecordUnion,
  judgeDataValues,
  judgeDeclaredValues,
  judgeMessage,
  judgeText,
  judgeValues,
  recordLangOf,
  renderValuePath,
  runtimeValueKind,
  schemaValueSites,
  SELF_PATH,
  siteValueOf,
  TEXT_CONTEXT_ANNOTATION,
  TEXT_VALUES_FOR_ANNOTATION,
  textAnnotationProblems,
  textSites,
  type KnownValues,
  type TextFragment,
  type TextProblem,
  type TextSite,
  type TextWalk,
  type TextWalkOptions,
  type ValuePath,
} from "@telorun/analyzer";
import { instanceDeclaration } from "./instance-declaration.js";

/** Who wrote a value: the writing module's `lang:` (`null` when it declares none,
 *  absent for the module creating the resource) and whether it was computed. */
export interface TextOrigin {
  readonly lang?: string | null;
  readonly computed: boolean;
}

interface ProvenanceNode {
  origin?: TextOrigin;
  children?: Map<string | number, ProvenanceNode>;
}

/** Origins by field path; a path takes the deepest origin recorded along it. */
export class TextProvenance {
  private constructor(private readonly root: ProvenanceNode) {}

  /** A provenance whose every path has `origin`. */
  static of(origin: TextOrigin): TextProvenance {
    return new TextProvenance({ origin });
  }

  /** The origin in force at `path`: the deepest computed flag recorded along it,
   *  and the deepest language. */
  at(path: ValuePath): TextOrigin {
    let lang: string | null | undefined;
    let computed = false;
    const apply = (node: ProvenanceNode) => {
      if (!node.origin) return;
      computed = node.origin.computed;
      if (node.origin.lang !== undefined) lang = node.origin.lang;
    };
    let node: ProvenanceNode | undefined = this.root;
    apply(node);
    for (const key of path) {
      node = node.children?.get(key);
      if (!node) break;
      apply(node);
    }
    return lang === undefined ? { computed } : { lang, computed };
  }

  /** Where an expression produced the value at `path` or a value beneath it:
   *  the path it was recorded at, or undefined when the whole value was written. */
  computedWithin(path: ValuePath): ValuePath | undefined {
    let node: ProvenanceNode | undefined = this.root;
    let computedAt: ValuePath | undefined = node.origin?.computed ? [] : undefined;
    for (let index = 0; index < path.length && node; index++) {
      node = node.children?.get(path[index]!);
      if (node?.origin) computedAt = node.origin.computed ? path.slice(0, index + 1) : undefined;
    }
    if (computedAt || !node) return computedAt;
    const pending: { node: ProvenanceNode; at: ValuePath }[] = [{ node, at: path }];
    while (pending.length > 0) {
      const { node: next, at } = pending.shift()!;
      for (const [key, child] of next.children ?? []) {
        if (child.origin?.computed) return [...at, key];
        pending.push({ node: child, at: [...at, key] });
      }
    }
    return undefined;
  }

  /** The provenance of the value at `path`. */
  below(path: ValuePath): TextProvenance {
    let node: ProvenanceNode | undefined = this.root;
    for (const key of path) node = node?.children?.get(key);
    return new TextProvenance({ origin: this.at(path), ...(node?.children ? { children: node.children } : {}) });
  }

  /** `other`, in place of whatever was recorded at `path`. */
  graft(path: ValuePath, other: TextProvenance): void {
    const node = this.ensure(path);
    node.origin = other.root.origin;
    node.children = other.root.children ? copyChildren(other.root.children) : undefined;
  }

  /** Mark the value at `path` as produced by an expression. */
  markComputed(path: ValuePath): void {
    const node = this.ensure(path);
    node.origin = { ...(node.origin?.lang !== undefined ? { lang: node.origin.lang } : {}), computed: true };
    node.children = undefined;
  }

  /** This provenance with `lang` as the language of every path that names none. */
  withDefaultLang(lang: string | null): TextProvenance {
    const root: ProvenanceNode = {
      origin: { lang: this.root.origin?.lang !== undefined ? this.root.origin.lang : lang, computed: this.root.origin?.computed ?? false },
      ...(this.root.children ? { children: copyChildren(this.root.children) } : {}),
    };
    return new TextProvenance(root);
  }

  private ensure(path: ValuePath): ProvenanceNode {
    let node = this.root;
    for (const key of path) {
      node.children ??= new Map();
      let next = node.children.get(key);
      if (!next) node.children.set(key, (next = {}));
      node = next;
    }
    return node;
  }
}

function copyChildren(children: Map<string | number, ProvenanceNode>): Map<string | number, ProvenanceNode> {
  const out = new Map<string | number, ProvenanceNode>();
  for (const [key, node] of children) {
    out.set(key, {
      ...(node.origin ? { origin: node.origin } : {}),
      ...(node.children ? { children: copyChildren(node.children) } : {}),
    });
  }
  return out;
}

const provenances = new WeakMap<object, TextProvenance>();

/** Record who wrote the values of `manifest` — set by a forwarding controller on
 *  the manifest it hands on, and by creation on every declaration. */
export function recordTextProvenance(manifest: object, provenance: TextProvenance): void {
  provenances.set(manifest, provenance);
}

/** Who wrote the values of `manifest`, if anything recorded it. */
export function textProvenanceOf(manifest: object): TextProvenance | undefined {
  return provenances.get(manifest);
}

/**
 * The provenance of what a bare `self.<path>` reads, step by step as the
 * forwarding controller reads it: past a live instance, off its outermost
 * declaration, whose provenance creation recorded — never off a member of the
 * instance.
 */
export function provenanceAlong(
  value: unknown,
  provenance: TextProvenance,
  keys: readonly string[],
): TextProvenance {
  let current: unknown = value;
  let at = provenance;
  for (const key of keys) {
    const declaration = instanceDeclaration(current);
    if (declaration) {
      const declared = textProvenanceOf(declaration);
      if (!declared) return TextProvenance.of({ computed: true });
      at = declared;
      current = declaration;
    }
    at = at.below([key]);
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }
  return at;
}

/** True when a text annotation is written anywhere in `value` — the only case
 *  the schemas a resource holds need reading, which most resources never are. */
function holdsTextAnnotation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsTextAnnotation);
  if (!value || typeof value !== "object" || isCompiledValue(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (TEXT_CONTEXT_ANNOTATION in value || TEXT_VALUES_FOR_ANNOTATION in value) return true;
  return Object.values(value).some(holdsTextAnnotation);
}

/** Every path below `value` holding a compiled expression, plain containers only. */
function expressionPaths(value: unknown, path: (string | number)[] = [], out: ValuePath[] = []): ValuePath[] {
  if (isCompiledValue(value)) {
    out.push([...path]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => expressionPaths(item, [...path, index], out));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return out;
  for (const [key, child] of Object.entries(value)) expressionPaths(child, [...path, key], out);
  return out;
}

/** What judging and handing over a resource's texts reads. */
export interface ResourceTextSite {
  /** `<Kind>/<name>`, prefixing every refusal. */
  readonly label: string;
  /** The kind's configuration schema. */
  readonly schema: Record<string, any>;
  readonly resolveRef: (ref: string) => Record<string, any> | undefined;
}

function walkOptions(site: ResourceTextSite, isExpression: (value: unknown) => boolean): TextWalkOptions {
  return {
    isExpression,
    resolveRef: (ref) => {
      const schema = site.resolveRef(ref);
      return schema ? { schema, root: schema } : undefined;
    },
  };
}

function refusal(site: ResourceTextSite, problem: TextProblem, base: ValuePath, what: string): RuntimeError {
  const path = renderValuePath([...base, ...problem.path]);
  return new RuntimeError(`ERR_${problem.code}`, `${site.label}: ${what} at '${path}' is refused: ${problem.message}.`);
}

/**
 * Before the resource's expressions are expanded: the two text annotations in
 * every schema it holds, every `TextCatalog` it holds (which may hold no
 * expression at all), and who wrote each of its values — `inherited` being what a
 * forwarding controller recorded for this manifest, `lang` its declaring
 * module's `lang:`.
 */
export function prepareResourceTexts(
  resource: ResourceManifest,
  site: ResourceTextSite,
  lang: string | null,
  inherited: TextProvenance | undefined,
): TextProvenance {
  const annotated = holdsTextAnnotation(resource)
    ? schemaValueSites(site.schema, resource, isCompiledValue)
    : [];
  for (const held of annotated) {
    for (const problem of textAnnotationProblems(held)) {
      const path = renderValuePath([...held.path, ...problem.path]);
      throw new RuntimeError(
        problem.code === "SCHEMA_VIOLATION" ? "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED" : `ERR_${problem.code}`,
        `${site.label}: ${path}: ${problem.message}.`,
      );
    }
  }
  const options = walkOptions(site, isCompiledValue);
  const walk = textSites(site.schema, resource, options);
  for (const text of walk.texts) {
    if (text.fragment !== "TextCatalog") continue;
    const [problem] = judgeCatalog(siteValueOf(text), isCompiledValue).problems;
    if (problem) throw refusal(site, problem, text.path, "the text catalog entry");
  }
  const [above] = catalogsComputedAbove(walk, options);
  if (above) throw refusal(site, catalogComputedProblem(), above, "the value");
  const provenance = (inherited ?? TextProvenance.of({ computed: false })).withDefaultLang(lang);
  for (const path of expressionPaths(resource)) provenance.markComputed(path);
  return provenance;
}

/** What creation settled: the copy a controller receives with each `Text` as its
 *  record, and what is left to settle when the controller evaluates the rest. */
export interface SettledTexts {
  readonly copy?: { resource: ResourceManifest; textPaths: ValuePath[] };
  readonly late?: LateTexts;
}

/**
 * After expansion: every text judged in its writer's language, every values
 * pairing judged against its text, and — for a controller that receives them —
 * the resource with each `Text` replaced by its record on a copy, and the
 * expressions still compiled that bear text, to settle when they are evaluated.
 * `accessorPaths` are the resource's accessor fields, which hold bindings.
 */
export function settleResourceTexts(
  resource: ResourceManifest,
  site: ResourceTextSite,
  provenance: TextProvenance,
  receivesRecords: boolean,
  accessorPaths: ReadonlySet<string>,
): SettledTexts | undefined {
  const walk = textSites(site.schema, resource, walkOptions(site, isCompiledValue));
  const records: { path: ValuePath; record: TextRecord }[] = [];
  let lateFound = walk.expressions.length > 0;
  for (const text of walk.texts) {
    if (text.fragment === "TextCatalog") {
      // A catalog a forwarding controller computed before handing it on.
      const computed = provenance.computedWithin(text.path);
      if (computed) throw refusal(site, catalogComputedProblem(), computed, "the value");
      continue;
    }
    if (containsExpression(text.value)) {
      lateFound = true;
      continue;
    }
    const origin = provenance.at(text.path);
    const settled = settleText(
      site,
      text.fragment,
      text.value,
      text.path,
      origin.lang ?? null,
      origin.computed,
      text.declaredValues,
      text.valuesFrom,
    );
    if (receivesRecords && settled !== text.value) records.push({ path: text.path, record: settled as TextRecord });
  }
  for (const pairing of walk.values) {
    if (containsExpression(pairing.values) || containsExpression(pairing.text) || pairing.text === undefined) {
      lateFound = true;
      continue;
    }
    judgePairing(site, pairing.path, pairing.textPath, pairing.values, pairing.text, accessorPaths);
  }
  let copy: unknown = resource;
  for (const { path, record } of records) copy = setCopied(copy, path, record);
  const held = copy as ResourceManifest;
  const late =
    receivesRecords && lateFound ? lateTextsOf(walk, held, site, provenance, accessorPaths) : undefined;
  if (records.length === 0 && !late) return undefined;
  return {
    ...(records.length > 0 ? { copy: { resource: held, textPaths: records.map(({ path }) => path) } } : {}),
    ...(late ? { late } : {}),
  };
}

function refuseFirst(site: ResourceTextSite, problems: readonly TextProblem[], path: ValuePath, what: string): void {
  const [problem] = problems;
  if (problem) throw refusal(site, problem, path, what);
}

/**
 * One text judged in its writer's language — `ERR_MESSAGE_SYNTAX_INVALID`,
 * `_SOURCE_LANGUAGE_MISSING`, `_PLURAL_CATEGORY_INVALID` — and what its holder
 * receives: a `Text` as its record, a `Message` as it is. A record already built
 * is passed through as it is.
 */
function settleText(
  site: ResourceTextSite,
  fragment: Exclude<TextFragment, "TextCatalog">,
  value: unknown,
  path: ValuePath,
  lang: string | null,
  computed: boolean,
  declared: Readonly<Record<string, unknown>> | undefined,
  valuesFrom?: TextSite["valuesFrom"],
): unknown {
  const what = fragment === "Message" ? "the message" : "the text";
  const judgeDeclared = (message: Message | undefined) => {
    if (message && declared) refuseFirst(site, judgeDeclaredValues(message, declared), path, what);
    if (message && valuesFrom) refuseFirst(site, judgeDataValues(message, valuesFrom.schema, valuesFrom.path), path, what);
  };
  if (isTextRecord(value)) {
    judgeDeclared(messageOf(value));
    return value;
  }
  if (fragment === "Message") {
    const read = judgeMessage(value);
    refuseFirst(site, read.problems, path, what);
    judgeDeclared(read.message);
    return value;
  }
  const read = judgeText(value, lang);
  refuseFirst(site, read.problems, path, what);
  judgeDeclared(read.text?.message);
  return textRecordOf(value, lang, computed);
}

/** The message a text holds — written, or already its record — or undefined for
 *  one that does not read, which is its own refusal. */
function messageOf(text: unknown): Message | undefined {
  if (isTextRecord(text)) {
    const read = readMessage(text.text);
    return read.ok ? read.message : undefined;
  }
  const read = readText(text);
  return read.ok ? read.text.message : undefined;
}

/** What each value bound to a message is. An accessor field holds a binding: a
 *  literal's `{ value }` is that value, a chain's `{ root, path }` a value its
 *  consumer resolves. Undefined when the values themselves are not known. */
function knownValuesOf(
  values: unknown,
  path: ValuePath,
  accessorPaths: ReadonlySet<string>,
): KnownValues | undefined {
  let map = values;
  if (accessorPaths.has(renderValuePath(path))) {
    if (!isBinding(map) || !("value" in map)) return undefined;
    map = map.value;
  }
  if (!map || typeof map !== "object" || Array.isArray(map) || isCompiledValue(map)) return undefined;
  return new Map(
    Object.entries(map as Record<string, unknown>).map(([key, value]) => {
      if (!accessorPaths.has(renderValuePath([...path, key])) || !isBinding(value)) {
        return [key, runtimeValueKind(value)];
      }
      return [
        key,
        "value" in value
          ? runtimeValueKind(value.value)
          : { kind: "unknown" as const, describe: "a value its consumer resolves" },
      ];
    }),
  );
}

function isBinding(value: unknown): value is { value: unknown } | { root: string; path: string[] } {
  return !!value && typeof value === "object" && !Array.isArray(value) && ("value" in value || "root" in value);
}

/** A message's values judged against its text — `ERR_MESSAGE_PLACEHOLDER_UNBOUND`,
 *  `_VALUE_UNSUPPORTED`. A text that does not read is refused as itself. */
function judgePairing(
  site: ResourceTextSite,
  path: ValuePath,
  textPath: ValuePath,
  values: unknown,
  text: unknown,
  accessorPaths: ReadonlySet<string>,
): void {
  const message = messageOf(text);
  const known = message ? knownValuesOf(values, path, accessorPaths) : undefined;
  if (!message || !known) return;
  refuseFirst(site, judgeValues(message, known), path, `the values for the text at '${renderValuePath(textPath)}'`);
}

/** A text an evaluation produces, where it lands. */
interface LateText {
  readonly role: "text";
  readonly fragment: Exclude<TextFragment, "TextCatalog">;
  readonly path: ValuePath;
  readonly lang: string | null;
  readonly declaredValues?: Readonly<Record<string, unknown>>;
  readonly valuesFrom?: TextSite["valuesFrom"];
}

/** An expression above text: what it produces is walked by the schemas it fills. */
interface LateRegion {
  readonly role: "region";
  readonly path: ValuePath;
  readonly schemas: { schema: Record<string, any>; root: Record<string, any> }[];
  readonly lang: string | null;
}

/** One half of a pairing an evaluation completes: the node it is produced at, and
 *  the members below that node it lies at. */
interface PairingHalf {
  readonly node?: object;
  readonly rest: readonly (string | number)[];
  readonly literal?: unknown;
}

interface LatePairing {
  readonly path: ValuePath;
  readonly textPath: ValuePath;
  readonly values: PairingHalf;
  readonly text: PairingHalf;
}

/** The half of a pairing at `path` in `held`: the first expression on the way to
 *  it and the members past that expression, or the literal held there. */
function pairingHalf(held: unknown, path: ValuePath): PairingHalf {
  let at: unknown = held;
  for (let index = 0; index < path.length; index++) {
    if (isCompiledValue(at)) return { node: at, rest: path.slice(index) };
    at = at && typeof at === "object" ? (at as Record<string | number, unknown>)[path[index]!] : undefined;
  }
  if (isCompiledValue(at) || containsExpression(at)) return { node: at as object, rest: [] };
  return { rest: [], literal: at };
}

function valueAt(container: unknown, path: ValuePath): unknown {
  let at = container;
  for (const key of path) at = at && typeof at === "object" ? (at as Record<string | number, unknown>)[key] : undefined;
  return at;
}

function lateTextsOf(
  walk: TextWalk,
  held: ResourceManifest,
  site: ResourceTextSite,
  provenance: TextProvenance,
  accessorPaths: ReadonlySet<string>,
): LateTexts | undefined {
  const nodes = new Map<object, (LateText | LateRegion)[]>();
  const add = (path: ValuePath, role: LateText | LateRegion) => {
    const node = valueAt(held, path);
    if (!node || typeof node !== "object") return;
    const roles = nodes.get(node);
    if (roles) roles.push(role);
    else nodes.set(node, [role]);
  };
  for (const text of walk.texts) {
    if (text.fragment === "TextCatalog" || !containsExpression(text.value)) continue;
    add(text.path, {
      role: "text",
      fragment: text.fragment,
      path: text.path,
      lang: provenance.at(text.path).lang ?? null,
      ...(text.declaredValues ? { declaredValues: text.declaredValues } : {}),
      ...(text.valuesFrom ? { valuesFrom: text.valuesFrom } : {}),
    });
  }
  const pairings: LatePairing[] = [];
  const valuesPaths = new Set<string>();
  for (const pairing of walk.values) {
    valuesPaths.add(renderValuePath(pairing.path));
    const values = pairingHalf(held, pairing.path);
    const text = pairingHalf(held, pairing.textPath);
    if (values.node || text.node) pairings.push({ path: pairing.path, textPath: pairing.textPath, values, text });
  }
  const regions = new Map<string, LateRegion>();
  for (const expression of walk.expressions) {
    const at = renderValuePath(expression.path);
    if (valuesPaths.has(at)) continue;
    const region = regions.get(at);
    if (region) region.schemas.push({ schema: expression.schema, root: expression.root });
    else {
      regions.set(at, {
        role: "region",
        path: expression.path,
        schemas: [{ schema: expression.schema, root: expression.root }],
        lang: provenance.at(expression.path).lang ?? null,
      });
    }
  }
  for (const region of regions.values()) add(region.path, region);
  if (nodes.size === 0 && pairings.length === 0) return undefined;
  return new LateTexts(site, nodes, pairings, accessorPaths);
}

/**
 * The texts a controller's own evaluation produces, settled as creation settles
 * them: each text judged in its writer's language and handed over as its record
 * (`computed: true` — an expression produced it), each values pairing the
 * evaluation completes judged. Keyed by the identity of the nodes the
 * controller's manifest holds, so a value it builds around them is settled too.
 */
export class LateTexts {
  /** The nodes a pairing's halves are produced at. */
  private readonly halves = new Set<object>();

  constructor(
    private readonly site: ResourceTextSite,
    private readonly nodes: ReadonlyMap<object, readonly (LateText | LateRegion)[]>,
    private readonly pairings: readonly LatePairing[],
    private readonly accessorPaths: ReadonlySet<string>,
  ) {
    for (const pairing of pairings) {
      if (pairing.values.node) this.halves.add(pairing.values.node);
      if (pairing.text.node) this.halves.add(pairing.text.node);
    }
  }

  /** `output`, what evaluating `input` produced, with every text in it settled. */
  settle(input: unknown, output: unknown): unknown {
    const produced = new Map<object, unknown>();
    const settled = this.walk(input, output, produced);
    if (produced.size > 0) for (const pairing of this.pairings) this.judge(pairing, produced);
    return settled;
  }

  private walk(input: unknown, output: unknown, produced: Map<object, unknown>): unknown {
    if (!input || typeof input !== "object") return output;
    const roles = this.nodes.get(input);
    let value = output;
    if (roles) for (const role of roles) value = this.apply(role, value);
    else if (!isCompiledValue(input)) value = this.descend(input, output, produced);
    if (this.halves.has(input)) produced.set(input, value);
    return value;
  }

  private descend(input: object, output: unknown, produced: Map<object, unknown>): unknown {
    // The evaluation built a fresh container for each plain one it walked.
    if (output === input || !output || typeof output !== "object") return output;
    if (Array.isArray(input)) {
      if (!Array.isArray(output)) return output;
      input.forEach((item, index) => (output[index] = this.walk(item, output[index], produced)));
      return output;
    }
    if (!isCelRecord(input)) return output;
    const out = output as Record<string, unknown>;
    for (const [key, item] of Object.entries(input)) {
      if (key in out) out[key] = this.walk(item, out[key], produced);
    }
    return out;
  }

  private apply(role: LateText | LateRegion, value: unknown): unknown {
    if (role.role === "text") {
      return settleText(this.site, role.fragment, value, role.path, role.lang, true, role.declaredValues, role.valuesFrom);
    }
    let out = value;
    const seen = new Set<string>();
    const options = walkOptions(this.site, isCompiledValue);
    if (
      value !== null &&
      value !== undefined &&
      !isTextRecord(value) &&
      role.schemas.some(({ schema, root }) => isTextOrRecordUnion(schema, root, options.resolveRef))
    ) {
      throw new RuntimeError(
        "ERR_TEXT_ARGUMENT_COMPUTED",
        `${this.site.label}: the value at '${renderValuePath(role.path)}' is computed, and this slot takes a literal ` +
          `text or the record of a text already shown (\`!cel "error.displayMessage"\`): a text an expression produces can be ` +
          `neither checked nor translated. Write the text itself, with its values beside it.`,
      );
    }
    for (const { schema, root } of role.schemas) {
      const walk = textSites(schema, value, walkOptions(this.site, isCompiledValue), root);
      for (const text of walk.texts) {
        const at = renderValuePath(text.path);
        if (text.fragment === "TextCatalog" || seen.has(at)) continue;
        seen.add(at);
        const path = [...role.path, ...text.path];
        const settled = settleText(this.site, text.fragment, text.value, path, role.lang, true, text.declaredValues, text.valuesFrom);
        if (settled !== text.value) out = setCopied(out, text.path, settled);
      }
      for (const pairing of walk.values) {
        judgePairing(
          this.site,
          [...role.path, ...pairing.path],
          [...role.path, ...pairing.textPath],
          pairing.values,
          pairing.text,
          this.accessorPaths,
        );
      }
    }
    return out;
  }

  private judge(pairing: LatePairing, produced: ReadonlyMap<object, unknown>): void {
    const read = (half: PairingHalf): { value?: unknown; produced: boolean; known: boolean } => {
      if (!half.node) return { value: half.literal, produced: false, known: true };
      if (!produced.has(half.node)) return { produced: false, known: false };
      return { value: valueAt(produced.get(half.node), half.rest), produced: true, known: true };
    };
    const values = read(pairing.values);
    const text = read(pairing.text);
    if (!values.known || !text.known || (!values.produced && !text.produced)) return;
    judgePairing(this.site, pairing.path, pairing.textPath, values.value, text.value, this.accessorPaths);
  }
}

/** The record a controller receives for a `Text` written `value`. */
export function textRecordOf(value: unknown, lang: string | null, computed: boolean): TextRecord {
  const objectForm =
    !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "text");
  const text = (objectForm ? (value as { text: unknown }).text : value) as MessageSource;
  const context = objectForm ? ((value as { context?: unknown }).context as string | undefined) ?? null : null;
  return { text, context, lang: recordLangOf(lang), computed };
}

function containsExpression(value: unknown): boolean {
  return expressionPaths(value).length > 0;
}

function setCopied(container: unknown, path: ValuePath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  const copy: any = Array.isArray(container) ? [...container] : { ...(container as object) };
  copy[key as string | number] = setCopied((container as any)?.[key as string | number], rest, value);
  return copy;
}

const controllerCopies = new WeakMap<object, { copy: object; textPaths: readonly ValuePath[] }>();

/** Remember that `declaration`'s controller holds `copy`, which differs from it
 *  only along `textPaths`. */
export function recordControllerCopy(declaration: object, copy: object, textPaths: readonly ValuePath[]): void {
  controllerCopies.set(declaration, { copy, textPaths });
}

/**
 * Carry what Phase-5 injection placed in `declaration` into the copy its
 * controller holds. The two share every container not on the way to a record, so
 * only a reference held directly by one of those containers — the resource's root
 * above all — has to be copied across.
 */
export function syncInjectedReferences(declaration: object): void {
  const held = controllerCopies.get(declaration);
  if (!held) return;
  const sync = (from: any, to: any, below: readonly ValuePath[]): void => {
    for (const key of Object.keys(from)) {
      if (from[key] === to[key]) continue;
      const deeper = below.filter((path) => path[0] === key || path[0] === Number(key));
      if (deeper.some((path) => path.length === 1)) continue;
      if (deeper.length > 0 && from[key] && to[key] && typeof from[key] === "object" && typeof to[key] === "object") {
        sync(from[key], to[key], deeper.map((path) => path.slice(1)));
        continue;
      }
      to[key] = from[key];
    }
  };
  sync(declaration, held.copy, held.textPaths);
}

/**
 * Who wrote what a mapping over `self` produces (a `base:` mapping): a node that
 * is exactly a bare `self.<path>` carries what `self` holds there, any other
 * expression is computed, and a literal is the mapping's own — the module that
 * declared it, which the manifest's creation supplies.
 */
export function mappingProvenance(
  mapping: unknown,
  self: unknown,
  selfProvenance: TextProvenance,
): TextProvenance {
  const out = TextProvenance.of({ computed: false });
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (isCompiledValue(value)) {
      const forwarded = typeof value.source === "string" ? value.source.trim().match(SELF_PATH) : null;
      if (forwarded) out.graft(path, provenanceAlong(self, selfProvenance, forwarded[1]!.split(".").slice(1)));
      else out.markComputed(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (value && typeof value === "object" && isCelRecord(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  };
  visit(mapping, []);
  return out;
}
