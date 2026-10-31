/**
 * A diagnostic whose message QUOTES places of its own declaration — a schema
 * finding's JSON pointer (`/steps/0/timeout must be >= 1`), a reference's dotted
 * path (`reference at 'targets[0]'`). Every place a message names is recorded as
 * a quote, in `data.quotedPlace` (an ordered list, one per place in the message),
 * and the message is rendered from them, so the text and the places it carries
 * name the same ones. Where a placement moves a
 * finding from where a configuration or a template variant projected it to where
 * it was written, {@link relocatedRendering} renders the message again from the
 * moved places, and nothing else touches the text; the keyed judgement and the
 * configuration runs both place through it, so a position a configuration
 * projects (an item after an `!if` item) never reaches the text. A move that
 * re-roots a declaration (an extracted inline declaration, a scope member)
 * keeps the text, which is relative to that declaration ({@link rerootedQuotes}).
 *
 * Browser-safe.
 */
import type { AnalysisDiagnostic } from "./types.js";
import type { SchemaIssue } from "./schema-error-report.js";
import { parseKeys, pathText } from "./template-expansion.js";

type Keys = readonly (string | number)[];

/** How a message quotes one place of its declaration. */
export interface QuotedPlace {
  /** The text between the previous quote (or the message start) and this one. */
  readonly before: string;
  /** The text after this quote: only the last quote of a message carries any. */
  readonly after: string;
  /** The quoted place, as a path in the coordinates of `data.path`. */
  readonly place: string;
  /** How many leading keys of `place` lie above the place the text is relative
   *  to: a template body entry's own keys. */
  readonly from: number;
  /** The `data.path` the message was rendered for. */
  readonly path: string;
  /** How the place is written: a JSON pointer (`/steps/0`, the default) or a
   *  dotted path (`steps[0]`). */
  readonly form?: "pointer" | "dotted";
}

/** The pointer a message quotes for `keys`: `/` for the root. */
export function quotedPointer(keys: Keys): string {
  return keys.length === 0 ? "/" : `/${keys.join("/")}`;
}

/** The place `keys` as a quote of `form` writes it. */
function quotedText(keys: Keys, form: QuotedPlace["form"]): string {
  return form === "dotted" ? pathText(keys) : quotedPointer(keys);
}

/** The text a quote writes for its place. */
export function quoteText(quote: QuotedPlace): string {
  return quotedText(parseKeys(quote.place).slice(quote.from), quote.form);
}

/** A message rendered from its quotes, in order. */
function renderedText(quotes: readonly QuotedPlace[]): string {
  return quotes.map((q) => `${q.before}${quoteText(q)}`).join("") + (quotes.at(-1)?.after ?? "");
}

/**
 * A message quoting a schema issue's place, prefixed by `label` and followed by
 * `suffix`, for a diagnostic at `path` whose first `from` keys lie above the
 * value the issue was found in: the message, and the quotes it is rendered from.
 * An issue whose text quotes no place is its message as it is.
 */
export function quotingIssue(
  label: string,
  issue: SchemaIssue,
  path: string,
  suffix = "",
  from = 0,
): { message: string; quotedPlace?: QuotedPlace[] } {
  if (issue.prose === undefined) {
    const message = `${label}${issue.message}${suffix}`;
    if (!issue.places) return { message };
    return quotingWritten(message, issue.places.map((text, i) => ({ text, mark: "`", anywhere: i > 0 })), path);
  }
  const keys = parseKeys(path);
  const place = pathText(keys.slice(0, keys.length - (issue.quoteTrail ?? 0)));
  const quote: QuotedPlace = { before: label, after: ` ${issue.prose}${suffix}`, place, from, path };
  return { message: renderedText([quote]), quotedPlace: [quote] };
}

/**
 * A message quoting, as dotted paths, places of its diagnostic's declaration
 * — `before`, the first place, the text between, … , `after` — and the quotes it
 * is rendered from. `texts` is what stands between the places: one more than
 * `quoted`. A quoted place that does not round-trip through the path grammar is
 * text like any other.
 */
export function quotingPaths(
  texts: readonly string[],
  quoted: readonly string[],
  path: string,
  from: number | readonly number[] = 0,
): { message: string; quotedPlace?: QuotedPlace[] } {
  const fromOf = (i: number) => (typeof from === "number" ? from : from[i]!);
  const plain = () => ({ message: texts.map((t, i) => `${t}${pathText(parseKeys(quoted[i] ?? "").slice(fromOf(i)))}`).join("") });
  if (quoted.some((q) => pathText(parseKeys(q)) !== q)) return plain();
  const quotes: QuotedPlace[] = quoted.map((q, i) => ({
    before: texts[i]!,
    after: i === quoted.length - 1 ? texts[quoted.length]! : "",
    place: q,
    from: fromOf(i),
    path,
    form: "dotted",
  }));
  return { message: renderedText(quotes), quotedPlace: quotes };
}

/** {@link quotingPaths} of one place at or above `path`. A place `path` does not
 *  lie beneath is text like any other. */
export function quotingPath(
  before: string,
  quoted: string,
  after: string,
  path: string,
): { message: string; quotedPlace?: QuotedPlace[] } {
  const keys = parseKeys(quoted);
  const under = parseKeys(path);
  const above = keys.length <= under.length && keys.every((key, i) => String(key) === String(under[i]));
  if (!above) return { message: `${before}${quoted}${after}` };
  return quotingPaths([before, after], [quoted], path);
}

/** The `data` fields a quote adds to a diagnostic. */
export function quoteData(quoted: { quotedPlace?: QuotedPlace[] }): { quotedPlace?: QuotedPlace[] } {
  return quoted.quotedPlace ? { quotedPlace: quoted.quotedPlace } : {};
}

/** The quotes a diagnostic's message is rendered from, if it quotes places. */
export function quotedPlacesOf(d: AnalysisDiagnostic): QuotedPlace[] | undefined {
  const quotes = (d.data as { quotedPlace?: unknown } | undefined)?.quotedPlace;
  return Array.isArray(quotes) && quotes.length > 0 ? (quotes as QuotedPlace[]) : undefined;
}

function pathOf(d: AnalysisDiagnostic): string | undefined {
  const path = (d.data as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

/**
 * `d` labelled by the declaration it is now reported at: the `<kind>/<name>: `
 * its message opens with, and its first quote opens with, names `to` instead of
 * the declaration the passes judged — an extraction's generated name never
 * reaches a message.
 */
export function relabelled(
  d: AnalysisDiagnostic,
  from: { readonly kind?: string; readonly name?: string },
  to: { readonly kind?: string; readonly name?: string },
): AnalysisDiagnostic {
  if (from.kind === undefined || from.name === undefined || to.kind === undefined || to.name === undefined) return d;
  const was = `${from.kind}/${from.name}: `;
  const now = `${to.kind}/${to.name}: `;
  if (was === now) return d;
  const swap = (text: string) => (text.startsWith(was) ? `${now}${text.slice(was.length)}` : text);
  const quotes = quotedPlacesOf(d);
  return {
    ...d,
    message: swap(d.message),
    ...(quotes
      ? { data: { ...(d.data as Record<string, unknown>), quotedPlace: quotes.map((q, i) => (i === 0 ? { ...q, before: swap(q.before) } : q)) } }
      : {}),
  };
}

/**
 * `d` after an EXTRACTED declaration's finding is reported where the author
 * wrote the declaration, at `path` in its holder: labelled by the holder
 * ({@link relabelled}) and each quoted place written in full from it. A place
 * relative to a template body entry stays relative to it.
 */
export function reportedAtHolder(
  d: AnalysisDiagnostic,
  path: string,
  from: { readonly kind?: string; readonly name?: string },
  to: { readonly kind?: string; readonly name?: string },
): AnalysisDiagnostic {
  const labelled = relabelled(d, from, to);
  const quotes = quotedPlacesOf(labelled);
  const was = pathOf(labelled);
  if (!quotes || was === undefined || path === quotes[0]!.path) return labelled;
  const shift = Math.max(0, parseKeys(path).length - parseKeys(quotes[0]!.path).length);
  const above = parseKeys(path).slice(0, shift);
  const next = quotes.map((q) => ({
    ...q,
    from: q.from === 0 ? 0 : q.from + shift,
    place: pathText([...above, ...parseKeys(q.place)]),
    path,
  }));
  return { ...labelled, message: renderedText(next), data: { ...(labelled.data as Record<string, unknown>), quotedPlace: next } };
}

/**
 * `diagnostics` after a move that RE-ROOTS a declaration — a scope member or a
 * forward view reported where its holder writes it: each quoted place keeps its
 * text, which is relative to the declaration it was found in, and that
 * declaration now begins deeper in the path.
 */
export function rerootedQuotes(diagnostics: AnalysisDiagnostic[]): AnalysisDiagnostic[] {
  return diagnostics.map((d) => {
    const quotes = quotedPlacesOf(d);
    const path = pathOf(d);
    if (!quotes || path === undefined || path === quotes[0]!.path) return d;
    const moved = parseKeys(path);
    const shift = Math.max(0, moved.length - parseKeys(quotes[0]!.path).length);
    const above = moved.slice(0, shift);
    return {
      ...d,
      data: {
        ...(d.data as Record<string, unknown>),
        quotedPlace: quotes.map((q) => ({
          ...q,
          from: q.from + shift,
          place: pathText([...above, ...parseKeys(q.place)]),
          path,
        })),
      },
    };
  });
}

/**
 * `diagnostics` moved by `relocate` — a one-for-one move of each `data.path`
 * from where a configuration or a template variant projected it to where it
 * was written — each message quoting places rendered from where they now stand:
 * every quoted place moved by the same relocation, and the root of its
 * declaration moved too.
 */
export function relocatedRendering(
  diagnostics: AnalysisDiagnostic[],
  relocate: (diagnostics: AnalysisDiagnostic[]) => AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  const moved = relocate(diagnostics);
  const quoted = diagnostics.flatMap((d, i) => (quotedPlacesOf(d) ? [i] : []));
  if (quoted.length === 0) return moved;
  if (moved.length !== diagnostics.length) throw new Error("internal: a relocation added or dropped a diagnostic.");
  const probes = quoted.flatMap((i) =>
    quotedPlacesOf(diagnostics[i]!)!.flatMap((q) => {
      const keys = parseKeys(q.place);
      return [pathText(keys), pathText(keys.slice(0, q.from))].map((path) => ({
        ...diagnostics[i]!,
        data: { ...(diagnostics[i]!.data as Record<string, unknown>), path },
      }));
    }),
  );
  const relocated = relocate(probes);
  if (relocated.length !== probes.length) throw new Error("internal: a relocation added or dropped a diagnostic.");
  const out = [...moved];
  let at = 0;
  for (const i of quoted) {
    const path = pathOf(moved[i]!);
    const quotes = quotedPlacesOf(diagnostics[i]!)!;
    const places = quotes.map((q) => {
      const place = pathOf(relocated[at]!);
      const root = pathOf(relocated[at + 1]!);
      at += 2;
      return { q, place, root };
    });
    if (path === undefined || places.some((p) => p.place === undefined || p.root === undefined)) continue;
    if (path === quotes[0]!.path && places.every((p) => p.place === p.q.place)) continue;
    const next = places.map((p) => ({ ...p.q, place: p.place!, from: parseKeys(p.root!).length, path }));
    out[i] = {
      ...moved[i]!,
      message: renderedText(next),
      data: { ...(moved[i]!.data as Record<string, unknown>), quotedPlace: next },
    };
  }
  return out;
}

/** What a message quotes, place by place, beside the text each recorded quote
 *  renders: equal wherever the message was rendered from its quotes. */
export function quotedTexts(d: AnalysisDiagnostic): { quoted: string; carried: string; place: string; renderedFor: string }[] | undefined {
  const quotes = quotedPlacesOf(d);
  if (!quotes) return undefined;
  let rest = d.message;
  return quotes.map((q) => {
    const carried = quoteText(q);
    if (!rest.startsWith(q.before)) return { quoted: rest, carried, place: q.place, renderedFor: q.path };
    rest = rest.slice(q.before.length);
    const end = quotes.at(-1) === q ? rest.indexOf(q.after) : rest.startsWith(carried) ? carried.length : -1;
    const quoted = end < 0 ? rest : rest.slice(0, end);
    rest = rest.slice(quoted.length);
    return { quoted, carried, place: q.place, renderedFor: q.path };
  });
}

/** A place a message writes: its text, and how it is written. */
export interface WrittenPlace {
  /** The place as the message writes it. */
  readonly text: string;
  /** A place of the declaration the text is written relative to. */
  readonly relativeTo?: string;
  /** What the message wraps it in: single quotes (the default), backticks, or
   *  nothing after the message's label. */
  readonly mark?: "'" | "`" | "";
  /** Recorded though `data.path` does not lie beneath it: a sibling place. */
  readonly anywhere?: boolean;
}

/**
 * The text around each place `message` writes, in order, and the places as
 * paths of the declaration: nothing when one is not written so, or does not lie
 * at or above `path` and is not `anywhere`.
 */
function locatedPlaces(
  message: string,
  written: readonly WrittenPlace[],
  path: string,
): { texts: string[]; places: string[]; from: number[] } | undefined {
  const under = parseKeys(path);
  const texts: string[] = [];
  const places: string[] = [];
  const from: number[] = [];
  const labelled = message.indexOf(": ") + 2;
  let cursor = 0;
  let kept = 0;
  for (const w of written) {
    const mark = w.mark ?? "'";
    const full = w.relativeTo === undefined ? w.text : `${w.relativeTo}.${w.text}`;
    const keys = parseKeys(full);
    if (pathText(keys) !== full) return undefined;
    if (!w.anywhere && !(keys.length <= under.length && keys.every((key, i) => String(key) === String(under[i])))) return undefined;
    const at = message.indexOf(`${mark}${w.text}${mark}`, mark === "" ? Math.max(cursor, labelled) : cursor);
    if (at < 0) return undefined;
    texts.push(message.slice(kept, at + mark.length));
    cursor = at + mark.length + w.text.length;
    kept = cursor;
    places.push(full);
    from.push(w.relativeTo === undefined ? 0 : parseKeys(w.relativeTo).length);
  }
  texts.push(message.slice(kept));
  return { texts, places, from };
}

/**
 * `d` with the quotes its message makes of `quoted` — places written in the
 * order given — recorded as built, so a placement renders the message from
 * where the finding moves. A message not writing them so is left as it is.
 */
export function withQuotedPath(d: AnalysisDiagnostic, quoted: string | WrittenPlace | readonly (string | WrittenPlace)[]): AnalysisDiagnostic {
  const path = pathOf(d);
  if (path === undefined) return d;
  const list = Array.isArray(quoted) ? quoted : [quoted];
  const found = locatedPlaces(d.message, list.map((q) => (typeof q === "string" ? { text: q } : q)), path);
  if (!found) return d;
  const quotes = quotingPaths(found.texts, found.places, path, found.from);
  if (!quotes.quotedPlace) return d;
  return { ...d, data: { ...(d.data as Record<string, unknown>), quotedPlace: quotes.quotedPlace } };
}

/** `message` as the quote of the places it writes, if it writes them so. */
export function quotingWritten(
  message: string,
  written: readonly WrittenPlace[],
  path: string,
): { message: string; quotedPlace?: QuotedPlace[] } {
  const found = locatedPlaces(message, written, path);
  return found ? quotingPaths(found.texts, found.places, path, found.from) : { message };
}
