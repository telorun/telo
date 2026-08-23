/**
 * The one renderer for AJV validation failures.
 *
 * Browser-safe and re-imported by the kernel — the split `buildEvalPaths` and
 * the redaction path parser already use — so a failure is phrased identically
 * under `telo check` and at runtime. Three implementations used to answer this
 * (the analyzer's keyword prose, the kernel's raw `instancePath + message`
 * join, and observed state's own inline variant), so a developer who fixed what
 * the analyzer told them met a different sentence describing the same thing.
 *
 * UNION REDUCTION is the second half. A union must attempt every branch, and
 * AJV cannot know which one was intended — `discriminator: true` works only
 * against an explicit OpenAPI-style discriminator property, which would mean
 * changing what every module's authors write. So branch selection is a
 * reporting concern and lives here.
 *
 * It narrows the error SET, never just the sentence: every consumer maps the
 * surviving errors to manifest paths to anchor a diagnostic, so reducing at the
 * prose layer alone would move the soup out of the message and into the
 * problems list, one entry per branch on a different line.
 *
 * Selection is made from the ERRORS ALONE, never from the schema. A branch
 * whose discriminating key is present emits no complaint at the union's own
 * instancePath; one whose key is absent says `required`, and one that forbids a
 * key the value carries says `additionalProperties`. That is the whole signal,
 * and reading it off the errors is what lets reduction work across a `$ref`
 * into another registered schema, where navigating to the branch subschema
 * would mean re-implementing AJV's resolution.
 */

/** An AJV error object. Structurally typed — the analyzer and the kernel hand
 *  over errors from their own AJV instances. */
export interface AjvErrorLike {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  params?: Record<string, any>;
  data?: unknown;
}

/** A schema validation issue with a dotted-path pointer to the offending field. */
export interface SchemaIssue {
  message: string;
  /** Dotted path to the field (e.g. "config.handler"). Empty string means root. */
  path: string;
}

const UNION_KEYWORDS = new Set(["anyOf", "oneOf"]);

/** Keywords a branch raises at the union's OWN instancePath when the value is
 *  not of that branch's shape at all — as opposed to being that shape and wrong
 *  further in. These are what make a branch implausible. */
const SHAPE_KEYWORDS = new Set(["required", "type", "additionalProperties", "enum", "const"]);

/* ------------------------------------------------------------------ prose */

export function formatSingleError(err: AjvErrorLike): string {
  const p = err.instancePath || "/";
  const params = err.params ?? {};
  switch (err.keyword) {
    case "additionalProperties":
      return `${p} must NOT have additional properties ('${params.additionalProperty}' is not allowed)`;
    case "required":
      return `${p} is missing required property '${params.missingProperty}'`;
    case "enum":
      return `${p} ${err.message ?? "is invalid"} (${(params.allowedValues as unknown[])?.join(" | ")})`;
    case "type":
      return `${p} must be ${params.type}${describeActual(err)}`;
    default:
      return `${p} ${err.message ?? "is invalid"}`;
  }
}

/** ` (got string)`, or nothing when the value is not in hand. AJV carries
 *  `data` only under `verbose`, and a reducer that navigated the root value
 *  would have to be given it at every call site; an absent actual type is worth
 *  less than a wrong one. */
function describeActual(err: AjvErrorLike): string {
  if (!("data" in err)) return "";
  const d = err.data;
  if (d === null) return " (got null)";
  if (Array.isArray(d)) return " (got array)";
  return ` (got ${typeof d})`;
}

/* -------------------------------------------------------------- reduction */

/** The branch index a `schemaPath` sits under, for a union whose own schemaPath
 *  is `unionPath` (`…/anyOf`): a child is `…/anyOf/<i>/…` and nothing else can
 *  collide with it. */
function branchIndexUnder(unionPath: string, schemaPath: string | undefined): number | undefined {
  if (!schemaPath || !schemaPath.startsWith(unionPath + "/")) return undefined;
  const rest = schemaPath.slice(unionPath.length + 1);
  const slash = rest.indexOf("/");
  const head = slash === -1 ? rest : rest.slice(0, slash);
  const index = Number(head);
  return Number.isInteger(index) ? index : undefined;
}

function instanceDepth(path: string | undefined): number {
  if (!path) return 0;
  return path.split("/").filter((s) => s !== "").length;
}

/**
 * How the alternatives at a union node are described, one phrase each.
 *
 * Read off the complaints made at the union's own node, and deliberately ONE
 * PHRASE PER MISSING KEY rather than one per error group. AJV inlines most
 * `$ref` branches and reports them all under the same bare `schemaPath`, so
 * several branches are genuinely indistinguishable in the error set — joining
 * their keys into a single phrase would read as one alternative demanding all
 * of them, which is a claim about the schema that is simply false. Listing them
 * separately under-specifies a branch that requires two keys at once, and each
 * clause is still a true necessary condition; asserting a conjunction that does
 * not exist is not.
 */
function describeAlternatives(errors: AjvErrorLike[], unionInstancePath: string): string[] {
  const own = errors.filter((e) => (e.instancePath || "") === unionInstancePath);
  const phrases: string[] = [];
  for (const e of own) {
    if (e.keyword === "required") phrases.push(`one with '${e.params?.missingProperty}'`);
    else if (e.keyword === "type") phrases.push(`a ${e.params?.type}`);
    else if (e.keyword === "enum") {
      phrases.push(`one of ${(e.params?.allowedValues as unknown[])?.join(" | ")}`);
    }
  }
  return phrases.length > 0 ? phrases : ["another shape"];
}

/** Is this branch a plausible reading of the value — does it accept the value's
 *  shape at the union node itself, and only disagree further in? */
function isPlausible(errors: AjvErrorLike[], unionInstancePath: string): boolean {
  return !errors.some(
    (e) => (e.instancePath || "") === unionInstancePath && SHAPE_KEYWORDS.has(e.keyword ?? ""),
  );
}

/**
 * A union OCCURRENCE — one union node reached at one place in the value.
 *
 * `schemaPath` alone does not identify one. A self-recursive shape (`$ref` back
 * to the carrier root, which is how a container node holds children) reaches the
 * SAME union schema at every depth, so every level's errors carry the identical
 * `#/anyOf/<i>/…`. What separates them is `instancePath`, and an occurrence is
 * therefore the pair.
 */
interface Occurrence {
  error: AjvErrorLike;
  schemaPath: string;
  instancePath: string;
  /** Errors this occurrence's own branches raised. */
  owned: AjvErrorLike[];
  /** Occurrences reached THROUGH one of this one's branches. */
  children: Occurrence[];
}

function isUnder(child: string, parent: string): boolean {
  return parent === "" ? child !== "" : child.startsWith(parent + "/");
}

/** The value path one level up, or undefined at the root. `""` is the root, so
 *  a non-empty path with no separator has the root as its parent. */
function parentPath(path: string): string | undefined {
  if (path === "") return undefined;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/**
 * Replace each failing union with the errors of the branch the author plainly
 * meant, recursively, outside in.
 *
 * Attribution runs to the DEEPEST occurrence that could own an error, which is
 * what keeps a container's own complaint apart from its child's when both carry
 * the same `schemaPath`. An occurrence reached through a branch becomes a
 * candidate branch of its own — it raised nothing at the parent's node, so it is
 * plausible exactly when the value really did take that shape and fail further
 * in, and reducing it recursively is what stops an inner union's alternatives
 * from surviving inside the outer one's selection.
 */
export function reduceSchemaErrors(errors: AjvErrorLike[] | null | undefined): AjvErrorLike[] {
  if (!errors || errors.length === 0) return [];

  const occurrences: Occurrence[] = errors
    .filter((e) => UNION_KEYWORDS.has(e.keyword ?? "") && typeof e.schemaPath === "string")
    .map((e) => ({
      error: e,
      schemaPath: e.schemaPath!,
      instancePath: e.instancePath || "",
      owned: [],
      children: [],
    }));
  if (occurrences.length === 0) return errors;

  // The VALUE NODE is the claim, not the schemaPath. A branch written as a
  // `$ref` is reported by AJV under the TARGET's schemaPath — and AJV inlines
  // some of them, reporting several branches under one identical path — so
  // nothing in such an error points back at the union that dispatched to it. A
  // large union is written exactly that way, a branch per `$defs` entry, so
  // claiming by schemaPath alone would leave the biggest unions unreduced.
  //
  // Indexed by instancePath rather than scanned: an error is claimed by the
  // DEEPEST occurrence enclosing it, which is found by walking that error's own
  // path upwards — bounded by the path's depth instead of by the number of
  // unions. The scan this replaced was O(errors × occurrences), and both grow
  // with nesting depth on a recursive shape, on a path the editor runs per
  // keystroke.
  const byPath = new Map<string, Occurrence>();
  const isOccurrence = new Set<AjvErrorLike>();
  for (const o of occurrences) {
    isOccurrence.add(o.error);
    // Several unions can occur at ONE value node (a union inside a union
    // branch); the first is kept, and the rest nest under it below.
    if (!byPath.has(o.instancePath)) byPath.set(o.instancePath, o);
  }

  /** The nearest occurrence at or above `path`, excluding `path` itself when
   *  `strict` — which is how an occurrence finds its parent rather than itself. */
  const enclosing = (path: string, strict: boolean): Occurrence | undefined => {
    let current = strict ? parentPath(path) : path;
    while (current !== undefined) {
      const hit = byPath.get(current);
      if (hit) return hit;
      current = parentPath(current);
    }
    return undefined;
  };

  const owner = new Map<AjvErrorLike, Occurrence>();
  for (const err of errors) {
    if (isOccurrence.has(err)) continue;
    const best = enclosing(err.instancePath || "", false);
    if (best) {
      best.owned.push(err);
      owner.set(err, best);
    }
  }

  // Nest occurrences the same way: an occurrence deeper in the value was reached
  // through some branch of the nearest one enclosing it.
  const roots: Occurrence[] = [];
  for (const o of occurrences) {
    const parent = o === byPath.get(o.instancePath)
      ? enclosing(o.instancePath, true)
      : byPath.get(o.instancePath);
    if (parent && parent !== o) parent.children.push(o);
    else roots.push(o);
  }

  const replaced = new Map<AjvErrorLike, AjvErrorLike[]>();
  for (const root of roots) replaced.set(root.error, resolveOccurrence(root));

  const out: AjvErrorLike[] = [];
  for (const err of errors) {
    const replacement = replaced.get(err);
    if (replacement) {
      out.push(...replacement);
      continue;
    }
    // Everything an occurrence owns is spoken for by whichever branch survived,
    // and a nested occurrence is carried inside its parent's selection.
    if (owner.has(err)) continue;
    if (occurrences.some((o) => o.error === err)) continue;
    out.push(err);
  }
  return out;
}

interface Branch {
  /** Declaration order, or `Infinity` for a nested occurrence, which has none. */
  index: number;
  errors: AjvErrorLike[];
  /** True when this candidate is a nested occurrence rather than a branch that
   *  complained here — it is already reduced, so it is not reduced again. */
  nested: boolean;
}

/** Groups one union's complaints into candidate readings of the value.
 *
 *  The branch INDEX is used wherever the error carries it. It does not when the
 *  branch is a `$ref` — AJV reports under the target's schemaPath — so the
 *  fallback groups by the VALUE NODE each complaint is about: everything said
 *  about the union node itself is one candidate (those are the branches that
 *  rejected the value's shape outright), and each child node complained about is
 *  its own. That is the same question asked of the data instead of the schema,
 *  and it is what the ordering below actually reads. */
function groupCandidates(occurrence: Occurrence): Branch[] {
  const byIndex = new Map<number, AjvErrorLike[]>();
  const byNode = new Map<string, AjvErrorLike[]>();
  for (const err of occurrence.owned) {
    const index = branchIndexUnder(occurrence.schemaPath, err.schemaPath);
    const bucket =
      index === undefined
        ? mapBucket(byNode, childSegment(err.instancePath || "", occurrence.instancePath))
        : mapBucket(byIndex, index);
    bucket.push(err);
  }
  return [...byIndex]
    .map(([index, errs]) => ({ index, errors: errs, nested: false }))
    .concat([...byNode].map(([, errs]) => ({ index: Number.MAX_SAFE_INTEGER, errors: errs, nested: false })))
    .concat(
      occurrence.children.map((child) => ({
        index: Number.POSITIVE_INFINITY,
        errors: resolveOccurrence(child),
        nested: true,
      })),
    );
}

function mapBucket<K>(map: Map<K, AjvErrorLike[]>, key: K): AjvErrorLike[] {
  const existing = map.get(key);
  if (existing) return existing;
  const created: AjvErrorLike[] = [];
  map.set(key, created);
  return created;
}

/** The first value-path segment below `parent`, or "" for the node itself. */
function childSegment(instancePath: string, parent: string): string {
  if (!isUnder(instancePath, parent)) return "";
  const rest = instancePath.slice(parent.length + 1);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function resolveOccurrence(occurrence: Occurrence): AjvErrorLike[] {
  const candidates = groupCandidates(occurrence);

  // `oneOf` matching SEVERAL branches emits the union error with no branch
  // errors at all — nothing was rejected, so there is no branch to select.
  if (candidates.length === 0) return [occurrence.error];

  const plausible = candidates.filter(
    (c) => c.nested || isPlausible(c.errors, occurrence.instancePath),
  );
  if (plausible.length === 0) {
    return [alternativesError(candidates, occurrence)];
  }

  // Deepest agreement first — a branch that matched further into the value is
  // the one the author was writing — then the fewest complaints, then the
  // declaration order, so the choice is stable.
  plausible.sort((a, b) => {
    const depth = maxDepth(b.errors) - maxDepth(a.errors);
    if (depth !== 0) return depth;
    if (a.errors.length !== b.errors.length) return a.errors.length - b.errors.length;
    return a.index - b.index;
  });
  const winner = plausible[0];
  return winner.nested ? winner.errors : reduceSchemaErrors(winner.errors);
}

function maxDepth(errors: AjvErrorLike[]): number {
  let max = 0;
  for (const e of errors) max = Math.max(max, instanceDepth(e.instancePath));
  return max;
}

/** One error anchored at the union node, listing what could have gone there.
 *  The honest fallback: a confident wrong message is worse than the
 *  concatenation this replaces, so when no branch is a plausible reading the
 *  reader is told what the alternatives are rather than shown one branch's
 *  complaints as if it were the intended one. */
function alternativesError(candidates: Branch[], occurrence: Occurrence): AjvErrorLike {
  const seen = new Set<string>();
  const described: string[] = [];
  for (const text of describeAlternatives(
    candidates.flatMap((c) => c.errors),
    occurrence.instancePath,
  )) {
    if (seen.has(text)) continue;
    seen.add(text);
    described.push(text);
  }
  return {
    ...occurrence.error,
    instancePath: occurrence.instancePath,
    message: `matches no alternative — expected ${described.join(", or ")}`,
  };
}

/* --------------------------------------------------------------- rendering */

/** Converts an AJV error to a dotted path compatible with PositionIndex keys.
 *  e.g. instancePath "/config/routes/0/handler" → "config.routes[0].handler"
 *  For "required" keyword errors, appends the missing property to the parent path. */
export function ajvErrorToPath(err: AjvErrorLike): string {
  const instancePath = err.instancePath ?? "";
  const parts = instancePath.split("/").filter((p) => p !== "");
  let result = "";
  for (const part of parts) {
    if (/^\d+$/.test(part)) result += `[${part}]`;
    else result += result ? `.${part}` : part;
  }
  if (err.keyword === "required" && err.params?.missingProperty) {
    const missing = err.params.missingProperty as string;
    result += result ? `.${missing}` : missing;
  }
  return result;
}

/** Reduced, path-anchored issues — what a diagnostic list is built from. */
export function schemaIssues(errors: AjvErrorLike[] | null | undefined): SchemaIssue[] {
  return reduceSchemaErrors(errors).map((err) => ({
    message: formatSingleError(err),
    path: ajvErrorToPath(err),
  }));
}

/** Reduced, rendered as one sentence — what a thrown runtime error carries. */
export function formatAjvErrors(errors: AjvErrorLike[] | null | undefined): string {
  const reduced = reduceSchemaErrors(errors);
  if (reduced.length === 0) return "Unknown schema error";
  return reduced.map(formatSingleError).join("; ");
}
