/**
 * Runs the conformance vectors (`message-format/conformance/`) against a core.
 *
 * The core is a parameter and the vectors are data handed in, so the same runner
 * holds the package's source, its built output or a bundle that inlines it (a
 * browser entry) to one answer. It reads no file and imports nothing at runtime.
 * The CLDR samples are expanded here from `message-format/cldr/plurals.json`: every
 * sample of every locale must select the category whose rule lists it.
 */

import type * as Core from "../src/index.js";

export type MessageFormatCore = Pick<
  typeof Core,
  | "parsePattern"
  | "serializePattern"
  | "readMessage"
  | "readText"
  | "messageIdentity"
  | "textIdentity"
  | "messageVariables"
  | "unknownVariables"
  | "invalidPluralCategories"
  | "pluralCategories"
  | "formatNumber"
  | "pluralCategory"
  | "pluralCategoryOfDecimal"
  | "formatMessage"
  | "truncationChain"
  | "lookupLanguage"
>;

export type TypedValue = { string: string } | { int: string } | { uint: string } | { double: string };

interface Row {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface VectorSet {
  readonly patterns: { rows: readonly Row[] };
  readonly messages: { rows: readonly Row[] };
  readonly numbers: { rows: readonly Row[] };
  readonly format: { rows: readonly Row[] };
  readonly checks: { categories: readonly Row[]; categoryProblems: readonly Row[]; unknownVariables: readonly Row[] };
  readonly lookup: { chains: readonly Row[]; lookups: readonly Row[] };
  readonly workingGroup: { rows: readonly Row[] };
  /** `message-format/cldr/plurals.json`. */
  readonly plurals: { rules: Readonly<Record<string, Readonly<Record<string, string>>>> };
}

export interface VectorReport {
  /** Rows checked per set; the CLDR samples counted one per expanded sample. */
  readonly counts: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
}

export function hostValue(value: TypedValue): string | number | bigint {
  if ("string" in value) return value.string;
  if ("double" in value) return Number(value.double);
  return BigInt("int" in value ? value.int : value.uint);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => sameValue(item, other[index]));
  }
  const left = Object.keys(a);
  const right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every((key) => Object.hasOwn(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

/** Answers what `run` returns, or the code and message of the `MessageFormatError` it throws. */
function outcome<T>(run: () => T): { value: T } | { error: { code: unknown; message: unknown } } {
  try {
    return { value: run() };
  } catch (error) {
    const coded = error as { code?: unknown; message?: unknown };
    if (typeof coded?.code !== "string") throw error;
    return { error: { code: coded.code, message: coded.message } };
  }
}

/**
 * The samples a UTS #35 rule lists after `@integer` / `@decimal`, one decimal each:
 * `a~b` is every value from `a` to `b` at the precision `a` is written with, and `…`
 * (more beyond) is not a sample.
 */
export function expandSamples(rule: string): readonly string[] {
  const samples: string[] = [];
  const at = rule.indexOf("@");
  if (at === -1) return samples;
  for (const list of rule.slice(at).split("@").slice(1)) {
    const items = list.replace(/^(integer|decimal)/, "").split(",");
    for (const raw of items) {
      const item = raw.trim();
      if (item === "" || item === "…" || item === "...") continue;
      const [low, high] = item.split("~");
      if (high === undefined) {
        samples.push(low);
        continue;
      }
      const digits = (low.split(".")[1] ?? "").length;
      if ((high.split(".")[1] ?? "").length !== digits) throw new Error(`the sample range ${item} mixes precisions`);
      const toScaled = (text: string): bigint => BigInt(text.replace(".", ""));
      for (let value = toScaled(low); value <= toScaled(high); value += 1n) {
        const text = value.toString().padStart(digits + 1, "0");
        samples.push(digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`);
      }
    }
  }
  return samples;
}

export function runVectors(core: MessageFormatCore, vectors: VectorSet): VectorReport {
  const failures: string[] = [];
  const counts: Record<string, number> = {};
  const expect = (set: string, id: string, actual: unknown, expected: unknown): void => {
    if (!sameValue(actual, expected)) {
      failures.push(`${set} ${id}: answered ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };
  const count = (set: string): void => {
    counts[set] = (counts[set] ?? 0) + 1;
  };
  const readOk = (data: unknown) => {
    const read = core.readMessage(data);
    if (!read.ok) throw new Error(`a vector's message does not read: ${JSON.stringify(read.problems)}`);
    return read.message;
  };

  for (const row of vectors.patterns.rows) {
    count("patterns");
    const result = core.parsePattern(row.source as string);
    if (result.ok) {
      expect("patterns", row.id, { pattern: result.pattern, canonical: core.serializePattern(result.pattern) }, {
        pattern: row.pattern,
        canonical: row.canonical,
      });
      const again = core.parsePattern(core.serializePattern(result.pattern));
      expect("patterns", `${row.id} (round trip)`, again.ok ? again.pattern : again.problem, result.pattern);
    } else {
      expect("patterns", row.id, { problem: result.problem }, { problem: row.problem });
    }
  }

  for (const row of vectors.messages.rows) {
    count("messages");
    if (row.read === "message") {
      const result = core.readMessage(row.data);
      expect(
        "messages",
        row.id,
        result.ok
          ? { message: result.message, identity: core.messageIdentity(result.message), variables: core.messageVariables(result.message) }
          : { problems: result.problems },
        row.problems !== undefined
          ? { problems: row.problems }
          : { message: row.message, identity: row.identity, variables: row.variables },
      );
    } else {
      const result = core.readText(row.data);
      expect(
        "messages",
        row.id,
        result.ok
          ? { text: result.text, identity: core.textIdentity(result.text), variables: core.messageVariables(result.text.message) }
          : { problems: result.problems },
        row.problems !== undefined ? { problems: row.problems } : { text: row.text, identity: row.identity, variables: row.variables },
      );
    }
  }

  for (const row of vectors.numbers.rows) {
    count("numbers");
    const value = hostValue(row.value as TypedValue) as number | bigint;
    const text = outcome(() => core.formatNumber(value, row.lang as string));
    if ("error" in text) {
      expect("numbers", row.id, text.error, row.refusal);
      expect("numbers", `${row.id} (category)`, outcome(() => core.pluralCategory(value, row.lang as string)), {
        error: row.refusal,
      });
    } else {
      expect("numbers", row.id, { text: text.value, category: core.pluralCategory(value, row.lang as string) }, {
        text: row.text,
        category: row.category,
      });
    }
  }

  for (const row of vectors.format.rows) {
    count("format");
    const values = Object.fromEntries(
      Object.entries(row.values as Record<string, TypedValue>).map(([name, value]) => [name, hostValue(value)]),
    );
    const result = outcome(() => core.formatMessage(readOk(row.message), row.lang as string, values));
    expect("format", row.id, result, row.error !== undefined ? { error: row.error } : { value: row.output });
  }

  for (const row of vectors.checks.categories) {
    count("categories");
    expect("categories", row.id, core.pluralCategories(row.lang as string), row.categories);
  }
  for (const row of vectors.checks.categoryProblems) {
    count("categoryProblems");
    expect("categoryProblems", row.id, core.invalidPluralCategories(readOk(row.message), row.lang as string), row.problems);
  }
  for (const row of vectors.checks.unknownVariables) {
    count("unknownVariables");
    expect("unknownVariables", row.id, core.unknownVariables(readOk(row.translation), readOk(row.source)), row.problems);
  }

  for (const row of vectors.lookup.chains) {
    count("chains");
    expect("chains", row.id, core.truncationChain(row.tag as string), row.chain);
  }
  for (const row of vectors.lookup.lookups) {
    count("lookups");
    expect("lookups", row.id, core.lookupLanguage(row.requested as string, row.available as string[]), row.result);
  }

  for (const row of vectors.workingGroup.rows) {
    count("workingGroup");
    const read = core.readMessage(row.src);
    if (!read.ok) {
      expect("workingGroup", row.id, { problem: read.problems[0] }, { problem: row.problem });
      continue;
    }
    const values = Object.fromEntries(
      Object.entries(row.params as Record<string, TypedValue>).map(([name, value]) => [name, hostValue(value)]),
    );
    const result = outcome(() => core.formatMessage(read.message, row.locale as string, values));
    expect("workingGroup", row.id, result, row.error !== undefined ? { error: row.error } : { value: row.output });
  }

  for (const [locale, rules] of Object.entries(vectors.plurals.rules)) {
    for (const [category, rule] of Object.entries(rules)) {
      for (const sample of expandSamples(rule)) {
        count("cldrSamples");
        expect("cldrSamples", `${locale} ${sample}`, core.pluralCategoryOfDecimal(sample, locale), category);
      }
    }
  }

  return { counts, failures };
}
