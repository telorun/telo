/**
 * The rule vocabulary and the scan. Pure: text in, positions out — never the
 * matched text, so a finding can be logged, returned to a model or shown in an
 * editor without re-leaking the secret it describes.
 */

export type Charset = "alphanumeric" | "upperAlphanumeric" | "hex" | "base64" | "base64url";

export interface TokenRule {
  name: string;
  token: { prefixes: string[]; charset: Charset; minLength: number | bigint; maxLength?: number | bigint };
}

export interface MarkerRule {
  name: string;
  marker: { text: string };
}

export interface EntropyRule {
  name: string;
  entropy: { charset: Charset; minLength: number | bigint; minBitsPerChar: number | bigint; except?: string[] };
}

export type DetectionRule = TokenRule | MarkerRule | EntropyRule;

export interface Finding {
  rule: string;
  line: bigint;
  column: bigint;
}

const CHARSETS: Readonly<Record<Charset, RegExp>> = {
  alphanumeric: /[A-Za-z0-9]/,
  upperAlphanumeric: /[A-Z0-9]/,
  hex: /[0-9A-Fa-f]/,
  base64: /[A-Za-z0-9+/=]/,
  base64url: /[A-Za-z0-9_-]/,
};

/** log2 of the alphabet size: the most bits per character a run can carry. */
export const CHARSET_MAX_BITS: Readonly<Record<Charset, number>> = {
  alphanumeric: Math.log2(62),
  upperAlphanumeric: Math.log2(36),
  hex: 4,
  base64: 6,
  base64url: 6,
};

/** A prefix must start a word: a letter, digit, `_` or `-` before it means it
 *  is the middle of an identifier (`task-…` holds `sk-`), not a credential. */
const WORD = /[A-Za-z0-9_-]/;

/**
 * The contradictions the kind's `x-telo-resource-rules` refuse at `telo check`,
 * refused again at creation for a declaration no check reached. Each entry is
 * `<CODE>: <what>`, the code matching the resource rule's.
 */
export function ruleProblems(rules: readonly DetectionRule[]): string[] {
  const problems: string[] = [];
  rules.forEach((rule, index) => {
    const at = `rules[${index}] ('${rule.name}')`;
    if ("token" in rule) {
      if (rule.token.prefixes.length === 0) {
        problems.push(`SECRET_SCAN_PREFIXES_EMPTY: ${at} lists no prefixes`);
      }
      if (rule.token.maxLength !== undefined && Number(rule.token.maxLength) < Number(rule.token.minLength)) {
        problems.push(
          `SECRET_SCAN_LENGTH_RANGE_EMPTY: ${at} sets maxLength ${rule.token.maxLength} below minLength ${rule.token.minLength}`,
        );
      }
    } else if ("entropy" in rule) {
      const max = CHARSET_MAX_BITS[rule.entropy.charset];
      if (Number(rule.entropy.minBitsPerChar) > max) {
        problems.push(
          `SECRET_SCAN_ENTROPY_UNREACHABLE: ${at} asks for ${rule.entropy.minBitsPerChar} bits per character, ` +
            `more than the ${max.toFixed(3)} a ${rule.entropy.charset} run can carry`,
        );
      }
    }
  });
  return problems;
}

/** Positions are 1-based; a column counts characters (code points), not bytes. */
class LineIndex {
  private readonly starts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.starts.push(i + 1);
  }

  at(offset: number): { line: bigint; column: bigint } {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    const column = Array.from(this.text.slice(this.starts[low], offset)).length + 1;
    return { line: BigInt(low + 1), column: BigInt(column) };
  }
}

/** Offset one past the maximal run of `charset` characters starting at `from`. */
function runEnd(text: string, from: number, charset: RegExp): number {
  let end = from;
  while (end < text.length && charset.test(text[end]!)) end++;
  return end;
}

function shannonBitsPerChar(run: string): number {
  const counts = new Map<string, number>();
  for (const c of run) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / run.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function tokenOffsets(text: string, rule: TokenRule): number[] {
  const charset = CHARSETS[rule.token.charset];
  const min = Number(rule.token.minLength);
  const max = rule.token.maxLength === undefined ? Infinity : Number(rule.token.maxLength);
  const offsets = new Set<number>();
  for (const prefix of rule.token.prefixes) {
    for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
      if (at > 0 && WORD.test(text[at - 1]!)) continue;
      const bodyStart = at + prefix.length;
      const length = runEnd(text, bodyStart, charset) - bodyStart;
      if (length >= min && length <= max) offsets.add(at);
    }
  }
  return [...offsets];
}

function markerOffsets(text: string, rule: MarkerRule): number[] {
  const offsets: number[] = [];
  const needle = rule.marker.text;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    offsets.push(at);
  }
  return offsets;
}

function entropyOffsets(text: string, rule: EntropyRule): number[] {
  const charset = CHARSETS[rule.entropy.charset];
  const min = Number(rule.entropy.minLength);
  const bits = Number(rule.entropy.minBitsPerChar);
  const except = rule.entropy.except ?? [];
  const offsets: number[] = [];
  let at = 0;
  while (at < text.length) {
    if (!charset.test(text[at]!)) {
      at++;
      continue;
    }
    const end = runEnd(text, at, charset);
    const run = text.slice(at, end);
    const exempt = except.some((literal) => run.startsWith(literal) || (at >= literal.length && text.startsWith(literal, at - literal.length)));
    if (!exempt && run.length >= min && shannonBitsPerChar(run) >= bits) {
      offsets.push(at);
    }
    at = end;
  }
  return offsets;
}

/** Every finding, ordered by position and then by rule order. */
export function scan(text: string, rules: readonly DetectionRule[]): Finding[] {
  const index = new LineIndex(text);
  const found: Array<{ offset: number; order: number; rule: string }> = [];
  rules.forEach((rule, order) => {
    const offsets =
      "token" in rule
        ? tokenOffsets(text, rule)
        : "marker" in rule
          ? markerOffsets(text, rule)
          : entropyOffsets(text, rule);
    for (const offset of offsets) found.push({ offset, order, rule: rule.name });
  });
  found.sort((a, b) => a.offset - b.offset || a.order - b.order);
  return found.map(({ offset, rule }) => ({ rule, ...index.at(offset) }));
}
