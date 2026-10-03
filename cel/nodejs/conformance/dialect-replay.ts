/**
 * Replaying the conformance vectors' **dialect** rows: `catalog.json` and `types.json`.
 *
 * A dialect row is a row about what the engine answers once a host has registered its own
 * vocabulary onto it — the function catalog, and the host's nominal value types. So this
 * driver is the same shape as the two language drivers beside it, with one difference that
 * decides its whole design: **the host's vocabulary is a parameter, never a name written
 * here.** The nominal types come in as `NominalTypeDefinition`s, which is the engine's own
 * public registration shape, and the driver refuses a row declaring a type name neither
 * the engine nor the parameter knows rather than inventing one. That is what keeps the
 * package free of a host type name while still being held to the host's rows.
 *
 * **A row's two halves are independent, as the format says.** The static half checks
 * against the row's declarations plus the nominal types; the runtime half evaluates
 * against the bindings with **neither** — at runtime a value of a nominal type IS its
 * base, which is exactly why a row can record a refusal at check and a value at
 * evaluation (`p + 1` over a port). Checking first, as the language rows are driven, would
 * make every such row answer an error and compare nothing.
 *
 * What it holds the engine to, per row:
 *
 * 1. A row recorded as checking checks, **to the recorded type**; a row recorded as
 *    refused is refused.
 * 2. A row whose recorded diagnostic is one the CATALOG words — `CEL_INVALID_ARGUMENT`,
 *    the verdict of a literal-argument guard — is held to that code and that message **byte
 *    for byte**, the `(in \`…\`)` suffix included. Every other recorded diagnostic is the
 *    engine being replaced speaking and is not comparable.
 * 3. A row recorded with a value answers that value, written canonically.
 * 4. A row recorded with an error fails — and where the recorded message is one the catalog
 *    itself words (`<function>: <what is wrong>`), the engine's message must be that text
 *    exactly. That is the vectors' own rule for a catalog refusal: it is Telo's words, the
 *    same on every engine, and recorded verbatim.
 *
 * Anything else is `unaccounted` and the gate fails naming the row, exactly as at the
 * language level; a listed row that now agrees fails too.
 */

import {
  CelEnvironment,
  CelEvaluationError,
  functionCatalog,
  registerFunctionCatalog,
  type CelCatalogHandlers,
  type CelCheckDiagnostic,
  type CelValue,
  type NominalTypeDefinition,
} from "../src/index.js";
import {
  conformanceText,
  decodeConformanceValue,
  describeValue,
  type ConformanceValue,
} from "./conformance-value.js";

/** A recorded diagnostic or error: a Telo code, or `null` where the engine's own is not recorded. */
export interface RecordedVerdict {
  readonly code: string | null;
  readonly message: string;
}

export interface DialectRow {
  readonly id: string;
  readonly tag: string;
  readonly source: string;
  readonly declarations?: Readonly<Record<string, unknown>>;
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly context?: unknown;
  readonly explain?: unknown;
  readonly rootsDeclared?: boolean;
  readonly couldNameModule?: readonly string[];
  readonly modules?: unknown;
  readonly expect: {
    readonly check?: {
      readonly diagnostics?: readonly RecordedVerdict[];
      readonly type?: string;
      readonly calls?: readonly unknown[];
      readonly readTypes?: readonly string[];
      readonly stringLiteral?: string;
      readonly regions?: readonly unknown[];
      readonly refs?: readonly string[];
      readonly volatile?: boolean;
    };
    readonly value?: unknown;
    readonly error?: RecordedVerdict;
  };
}

/**
 * The conformance handler set: each of the nine host-backed functions answers with its own
 * name and each argument's typed-frame text. A row then pins exactly what the engine hands
 * the host, and a second engine reproduces the text with its own frame writer.
 */
export function conformanceHandlers(): CelCatalogHandlers {
  const answer = (name: string, args: readonly CelValue[]): string =>
    `${name}(${args.map((value) => conformanceText(value)).join(", ")})`;
  return {
    sha256: (text) => answer("sha256", [text]),
    md5: (text) => answer("md5", [text]),
    sha1: (text) => answer("sha1", [text]),
    sha512: (text) => answer("sha512", [text]),
    hmac: (algorithm, key, message) => answer("hmac", [algorithm, key, message]),
    base64Encode: (text) => answer("base64Encode", [text]),
    base64Decode: (text) => answer("base64Decode", [text]),
    json: (value) => answer("json", [value]),
    joinPath: (base, relative) => answer("joinPath", [base, relative]),
  };
}

/**
 * The dialect environment: the language environment plus the function catalog, with the
 * conformance handler set installed. The nominal types are NOT here — they belong to the
 * static half alone, which is the one place a row declares one.
 */
export function dialectEnvironment(): CelEnvironment {
  const environment = new CelEnvironment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
  registerFunctionCatalog(environment, { handlers: conformanceHandlers() });
  return environment;
}

/** Every function name the catalog declares — what decides whether it words a refusal. */
const CATALOG_NAMES = new Set(functionCatalog().map((entry) => entry.name));

/**
 * The refusal a recorded message holds, where the catalog is what words it.
 *
 * The rule is the vectors' own: a catalog refusal reads `<function>: <what is wrong>` and
 * is recorded verbatim, so those messages bind every engine. Every other recorded message
 * is the engine being replaced's own wording — `found no matching overload for …`, `No
 * such key: …` — and is compared as "an error" alone.
 */
function catalogRefusal(message: string): string | undefined {
  const summary = message.split("\n")[0]!;
  const named = /^([A-Za-z][A-Za-z0-9]*): /.exec(summary);
  if (!named || !CATALOG_NAMES.has(named[1]!)) return undefined;
  return summary;
}

/** What the engine answered when it evaluated a row. */
type Answer =
  | { readonly kind: "value"; readonly value: CelValue }
  | { readonly kind: "error"; readonly why: string; readonly message: string };

export interface DialectReplayFailure {
  readonly id: string;
  readonly source: string;
  readonly reason: string;
}

/** An expectation this driver does not answer, and what owns it. */
export interface DialectElsewhere {
  readonly expectation: string;
  readonly rows: number;
  readonly answeredBy: string;
  readonly because: string;
}

export interface DialectReplayReport {
  readonly file: string;
  readonly rows: number;
  readonly driven: number;
  /** Rows whose verdict, type, value and refusal all agree with the recording. */
  readonly matched: number;
  /** Rows whose recorded type the engine checked to. */
  readonly typesCompared: number;
  /** Rows whose recorded catalog refusal the engine reproduced byte for byte. */
  readonly refusalsPinned: readonly string[];
  /** Rows whose recorded literal-guard diagnostic the engine reproduced byte for byte. */
  readonly guardsPinned: readonly string[];
  readonly correctionsSeen: readonly string[];
  readonly exclusionsSeen: readonly string[];
  readonly unaccounted: readonly string[];
  readonly failures: readonly DialectReplayFailure[];
  readonly correctionCounts: readonly { readonly cause: string; readonly rows: number; readonly pinned: number }[];
  readonly exclusionCounts: readonly { readonly reason: string; readonly rows: number; readonly pinned: number }[];
  readonly answeredElsewhere: readonly DialectElsewhere[];
  readonly notCompared: readonly { readonly expectation: string; readonly rows: number; readonly because: string }[];
}

/**
 * Where this engine's answer differs from the recorded one, and the authority for it. The
 * set is asserted **exact**: a new disagreement fails, and one that goes away fails too.
 */
export interface DialectCorrectionGroup {
  readonly cause: string;
  readonly authority: string;
  readonly rows: readonly string[];
}

/**
 * The reasons a recorded answer stands although the engine would differ — **the same five
 * the language level declares, and the set does not grow.** Every one is a fact about the
 * row's INPUT or about which SEAM answers it, never about what the engine computes: a
 * disagreement about the engine's own answer is a correction with a cited authority, or a
 * defect.
 */
export type DialectExclusionReason =
  | "extension-library"
  | "feature-not-carried"
  | "container-not-declared"
  | "uncarried-input"
  | "evaluation-answer";

export interface DialectExclusionGroup {
  readonly reason: DialectExclusionReason;
  readonly because: string;
  readonly ids: readonly string[];
  /** Pinned: a row that joins or leaves the group fails the gate. */
  readonly rows: number;
}

export interface DialectReplayOptions {
  readonly file: string;
  /**
   * The nominal types the host registers, by name — the engine's own registration shape,
   * supplied from outside because the type names are the host's vocabulary and not this
   * package's.
   */
  readonly hostTypes: readonly NominalTypeDefinition[];
  readonly corrections: readonly DialectCorrectionGroup[];
  readonly exclusions: readonly DialectExclusionGroup[];
}

/** The environment a row is CHECKED in: the host's nominal types, then its declarations. */
function staticEnvironment(
  base: CelEnvironment,
  row: DialectRow,
  hostTypes: readonly NominalTypeDefinition[],
): CelEnvironment {
  const environment = base.clone();
  for (const definition of hostTypes) environment.registerType(definition);
  for (const [name, declaration] of Object.entries(row.declarations ?? {})) {
    environment.registerVariable(name, declaration as never);
  }
  return environment;
}

function activationOf(row: DialectRow): Record<string, CelValue> {
  const activation: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [name, node] of Object.entries(row.bindings ?? {})) {
    activation[name] = decodeConformanceValue(node as ConformanceValue);
  }
  return activation;
}

function evaluated(base: CelEnvironment, row: DialectRow): Answer {
  try {
    return { kind: "value", value: base.evaluate(row.source, activationOf(row)) };
  } catch (cause) {
    if (cause instanceof CelEvaluationError) {
      return { kind: "error", why: `${cause.code}: ${cause.message}`, message: cause.message };
    }
    if (cause instanceof Error) {
      return { kind: "error", why: `${cause.name}: ${cause.message}`, message: cause.message };
    }
    throw cause;
  }
}

/** Every type name a row's declarations mention, so a missing host type is named. */
function declaredTypeNames(rows: readonly DialectRow[]): readonly string[] {
  const names = new Set<string>();
  const read = (declaration: unknown): void => {
    if (typeof declaration === "string") {
      for (const name of declaration.split(/[<>,\s]+/)) {
        if (/^[A-Z]/.test(name) && !/^[A-Z]$/.test(name)) names.add(name);
      }
      return;
    }
    if (declaration !== null && typeof declaration === "object" && "fields" in declaration) {
      for (const field of Object.values((declaration as { fields: Record<string, unknown> }).fields)) {
        read(field);
      }
    }
  };
  for (const row of rows) for (const declaration of Object.values(row.declarations ?? {})) read(declaration);
  return [...names].sort();
}

/**
 * Which type names a row declares that neither the engine nor the supplied host types
 * account for. A row the driver cannot build an environment for would otherwise be
 * "answered" by whatever an undeclared name reads as, which is not an answer at all.
 */
export function unknownDeclaredTypes(
  rows: readonly DialectRow[],
  hostTypes: readonly NominalTypeDefinition[],
): readonly string[] {
  const known = new Set(hostTypes.map((definition) => definition.name));
  return declaredTypeNames(rows).filter((name) => !known.has(name));
}

export function replayDialectRows(
  rows: readonly DialectRow[],
  options: DialectReplayOptions,
): DialectReplayReport {
  const failures: DialectReplayFailure[] = [];
  const correctionsSeen: string[] = [];
  const exclusionsSeen: string[] = [];
  const unaccounted: string[] = [];
  const refusalsPinned: string[] = [];
  const guardsPinned: string[] = [];
  const correctedRows = new Set<string>();
  const excludedRows = new Map<DialectExclusionGroup, number>();
  const corrections = new Map(
    options.corrections.flatMap((group) =>
      group.rows.map((row) => [row, `${group.cause}: ${group.authority}`] as const),
    ),
  );
  const base = dialectEnvironment();
  let driven = 0;
  let matched = 0;
  let typesCompared = 0;

  for (const row of rows) {
    driven += 1;
    const problems: string[] = [];
    const recorded = row.expect.check?.diagnostics ?? [];
    const refusedByVectors = recorded.length > 0;

    const checked = staticEnvironment(base, row, options.hostTypes).check(row.source);
    const refused = checked.diagnostics.length > 0;
    if (refused !== refusedByVectors) {
      problems.push(
        refused
          ? `refused (${checked.diagnostics[0]!.code}: ${checked.diagnostics[0]!.message.split("\n")[0]}) a row the vectors check as ${row.expect.check?.type}`
          : `checked clean as ${checked.typeName} where the vectors refuse: ${recorded[0]!.message.split("\n")[0]}`,
      );
    } else if (refused) {
      const guard = guardDisagreement(recorded[0]!, checked.diagnostics[0]!);
      if (guard !== undefined) problems.push(guard);
      else if (recorded[0]!.code === "CEL_INVALID_ARGUMENT") guardsPinned.push(row.id);
    } else if (row.expect.check?.type !== undefined) {
      if (checked.typeName !== row.expect.check.type) {
        problems.push(`checked to ${checked.typeName} where the vectors record ${row.expect.check.type}`);
      } else typesCompared += 1;
    }

    const answer = evaluated(base, row);
    const disagreement = agreementWith(answer, row.expect);
    if (disagreement !== undefined) problems.push(disagreement);
    else if (row.expect.error !== undefined) {
      const refusal = catalogRefusal(row.expect.error.message);
      if (refusal !== undefined) {
        if (answer.kind === "error" && answer.message === refusal) refusalsPinned.push(row.id);
        else {
          problems.push(
            `is held to the catalog's own refusal and answered ${JSON.stringify(
              answer.kind === "error" ? answer.message : describeValue(answer.value),
            )} where the row records ${JSON.stringify(refusal)}`,
          );
        }
      }
    }

    const corrected = corrections.get(row.id);
    const exclusion = options.exclusions.find((group) => group.ids.includes(row.id));
    if (corrected !== undefined) {
      correctionsSeen.push(row.id);
      correctedRows.add(row.id);
      if (problems.length === 0) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: "listed as a correction, but the engine now answers the row — remove the entry",
        });
      }
      continue;
    }
    if (exclusion) {
      exclusionsSeen.push(row.id);
      excludedRows.set(exclusion, (excludedRows.get(exclusion) ?? 0) + 1);
      if (problems.length === 0) {
        failures.push({
          id: row.id,
          source: row.source,
          reason: `excluded as ${exclusion.reason}, and the engine answers the row — remove the entry`,
        });
      }
      continue;
    }
    if (problems.length > 0) {
      unaccounted.push(row.id);
      for (const reason of problems) failures.push({ id: row.id, source: row.source, reason });
      continue;
    }
    matched += 1;
  }

  return {
    file: options.file,
    rows: rows.length,
    driven,
    matched,
    typesCompared,
    refusalsPinned,
    guardsPinned,
    correctionsSeen,
    exclusionsSeen,
    unaccounted,
    failures,
    correctionCounts: options.corrections.map((group) => ({
      cause: group.cause,
      rows: group.rows.filter((row) => correctedRows.has(row)).length,
      pinned: group.rows.length,
    })),
    exclusionCounts: options.exclusions.map((group) => ({
      reason: group.reason,
      rows: excludedRows.get(group) ?? 0,
      pinned: group.rows,
    })),
    answeredElsewhere: answeredElsewhere(rows),
    notCompared: notCompared(rows),
  };
}

/**
 * Whether the engine's first diagnostic is the one a recorded literal-guard verdict asks
 * for. Only `CEL_INVALID_ARGUMENT` is compared, and it is compared whole: it is the
 * catalog's own words, and the suffix naming the call as written is part of them.
 */
function guardDisagreement(
  recorded: RecordedVerdict,
  mine: CelCheckDiagnostic,
): string | undefined {
  if (recorded.code !== "CEL_INVALID_ARGUMENT") return undefined;
  if (mine.code !== "CEL_INVALID_ARGUMENT") {
    return `refused with ${mine.code} where the vectors record a literal-argument refusal`;
  }
  if (mine.message !== recorded.message) {
    return `reported ${JSON.stringify(mine.message)} where the vectors record ${JSON.stringify(recorded.message)}`;
  }
  return undefined;
}

function agreementWith(
  answer: Answer,
  expected: { readonly value?: unknown; readonly error?: unknown },
): string | undefined {
  if (expected.error !== undefined) {
    return answer.kind === "error" ? undefined : `answered ${describeValue(answer.value)} where the row fails`;
  }
  if (answer.kind === "error") return `failed (${answer.why}) where the row answers a value`;
  let recorded: string;
  try {
    recorded = conformanceText(decodeConformanceValue(expected.value as ConformanceValue));
  } catch (cause) {
    return `the row's own value cannot be read: ${(cause as Error).message}`;
  }
  let written: string;
  try {
    written = conformanceText(answer.value);
  } catch (cause) {
    return `answered a value the encoding refuses: ${(cause as Error).message}`;
  }
  return written === recorded ? undefined : `answered ${written} where the row records ${recorded}`;
}

function countRows(rows: readonly DialectRow[], holds: (row: DialectRow) => boolean): number {
  return rows.filter(holds).length;
}

/**
 * What this driver does not answer, and who does. Every one of them is a TAG engine's
 * answer about a scalar rather than CEL's answer about an expression: where a tag's CEL
 * sits in the text, which roots a compiled value reads, whether it is volatile, what the
 * call listing looks like at the offsets of the scalar, and what a site's own context
 * schema makes of a member chain. A driver that answers half a file without naming the
 * half is how a gap survives to a later gate.
 */
function answeredElsewhere(rows: readonly DialectRow[]): DialectElsewhere[] {
  return [
    {
      expectation: "check.calls",
      rows: countRows(rows, (row) => row.expect.check?.calls !== undefined),
      answeredBy: "the tag engine's own suite",
      because:
        "a call listing at a scalar's offsets, including what the reader's own macro expansion made of it; the engine's listing is the checker's lowering and is not the same artifact",
    },
    {
      expectation: "check.regions, check.refs, check.volatile",
      rows: countRows(rows, (row) => row.expect.check?.regions !== undefined),
      answeredBy: "the tag engine's own suite",
      because:
        "where a tag's CEL sits in a scalar, and what compiling one answers about it, are facts about the tag and not about the expression",
    },
    {
      expectation: "check.readTypes, check.stringLiteral",
      rows: countRows(
        rows,
        (row) => row.expect.check?.readTypes !== undefined || row.expect.check?.stringLiteral !== undefined,
      ),
      answeredBy: "the tag engine's own suite",
      because: "both are summaries a consumer builds for an editor, from the types this driver does compare",
    },
    {
      expectation: "context, explain, rootsDeclared, couldNameModule",
      rows: countRows(
        rows,
        (row) =>
          row.context !== undefined ||
          row.explain !== undefined ||
          row.rootsDeclared !== undefined ||
          row.couldNameModule !== undefined,
      ),
      answeredBy: "the host that supplies a site's schema",
      because:
        "a site's context schema and its naming rule are manifest context; the engine is typed from them by whoever holds them",
    },
  ].filter((held) => held.rows > 0);
}

function notCompared(rows: readonly DialectRow[]): DialectReplayReport["notCompared"] {
  return [
    {
      expectation: "check.diagnostics[].code and .message, except a literal-argument refusal",
      rows: countRows(rows, (row) => (row.expect.check?.diagnostics?.length ?? 0) > 0),
      because:
        "a recorded diagnostic is the engine being replaced speaking, and its code is the tag engine's vocabulary rather than this engine's; what is compared instead is that the row is refused. A CEL_INVALID_ARGUMENT is the exception: the catalog words it, so it is compared whole",
    },
    {
      expectation: "expect.error.code and .message, except a catalog refusal",
      rows: countRows(rows, (row) => row.expect.error !== undefined),
      because:
        "a recorded error's code is always null and its wording is the engine being replaced's; a row recorded as failing is held to failing, at a code this engine decides. A refusal the catalog words is the exception and is compared byte for byte",
    },
  ];
}
