/**
 * The one order an analysis reports in: by where each finding is written, then
 * by what it says — a function of the finding alone, never of the stage that
 * found it or the configuration it holds in.
 *
 * The key, in order:
 *  1. the file — ranked by first appearance in the analysis's document set,
 *     findings naming no file first;
 *  2. the offset in the file, found as a host finds a range: the finding's own
 *     range, else its path, else the nearest written ancestor's key, else the
 *     document's start. A document with no position table has one constant
 *     offset, so its places fall to the next keys;
 *  3. the path text;
 *  4. the code;
 *  5. the message before its configuration clause;
 *  6. the resource kind, then its name.
 * Text compares by code point, never by UTF-16 unit.
 *
 * Every selection that depends on order — the first failure of a rule on a
 * resource, the earliest of two declarations of a name — reads the same order.
 *
 * Browser-safe.
 */
import { resolveRange } from "./diagnostic-location.js";
import type { DocumentPosition, FilePositions } from "./position-metadata.js";
import type { AnalysisDiagnostic } from "./types.js";

/** Where a finding or a declaration is written. */
export interface Place {
  readonly kind?: string;
  readonly name?: string;
  readonly filePath?: string;
  readonly path?: string;
  /** The line its document starts at, which tells apart two declarations of
   *  one name in one file. */
  readonly sourceLine?: number;
}

interface Key {
  readonly file: number;
  readonly fileText: string;
  readonly line: number;
  readonly character: number;
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly kind: string;
  readonly name: string;
  readonly range: string;
}

/** `a` against `b` by code point. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate unit stands for a code point above every unit of the plane.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x - y;
  }
  return a.length - b.length;
}

const CLAUSE_SUFFIXES = [
  " (in a branch no configuration takes)",
  " (in a branch no value the definition can be given takes)",
];

/** `message` without the configuration clause a merge or a label appended. */
export function withoutConfigurationClause(message: string): string {
  for (const suffix of CLAUSE_SUFFIXES) if (message.endsWith(suffix)) return message.slice(0, -suffix.length);
  const at = message.lastIndexOf(" (when ");
  return at >= 0 && message.endsWith(")") ? message.slice(0, at) : message;
}

interface Located {
  readonly file: string;
  readonly document: { readonly kind?: string; readonly name?: string; readonly position: DocumentPosition };
}

export class FindingOrder {
  private readonly ranks = new Map<string, number>();
  private readonly byResource = new Map<string, Located>();
  private readonly byResourceAnywhere = new Map<string, Located>();
  private readonly byFile = new Map<string, Located>();
  private readonly byLine = new Map<string, Located>();
  private readonly keys = new WeakMap<object, Key>();

  /** `documents`' files rank by first appearance, then the position tables'
   *  own, which also locate each document. */
  constructor(
    documents: readonly { readonly metadata?: unknown }[],
    positions: readonly FilePositions[] | undefined,
  ) {
    const rank = (file: unknown) => {
      if (typeof file === "string" && !this.ranks.has(file)) this.ranks.set(file, this.ranks.size);
    };
    for (const m of documents) rank((m.metadata as { source?: unknown } | undefined)?.source);
    for (const file of positions ?? []) {
      rank(file.source);
      file.documents.forEach((document, i) => {
        const located = { file: file.source, document };
        if (i === 0 && !this.byFile.has(file.source)) this.byFile.set(file.source, located);
        const line = `${file.source}\0${document.position.sourceLine}`;
        if (!this.byLine.has(line)) this.byLine.set(line, located);
        if (document.kind === undefined || document.name === undefined) return;
        const identity = `${document.kind}\0${document.name}`;
        const inFile = `${file.source}\0${identity}`;
        if (!this.byResource.has(inFile)) this.byResource.set(inFile, located);
        if (!this.byResourceAnywhere.has(identity)) this.byResourceAnywhere.set(identity, located);
      });
    }
  }

  /** Sorted by the key; findings tied on every term keep their order. */
  sort<T extends AnalysisDiagnostic>(findings: readonly T[]): T[] {
    return findings
      .map((finding, index) => ({ finding, index }))
      .sort((a, b) => this.compare(a.finding, b.finding) || a.index - b.index)
      .map(({ finding }) => finding);
  }

  /** `items` by `compare`; ties keep their order. */
  sortBy<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => compare(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
  }

  compare(a: AnalysisDiagnostic, b: AnalysisDiagnostic): number {
    return compareKeys(this.keyOf(a), this.keyOf(b));
  }

  /** Two places by the key a finding there with no code and no message has. */
  comparePlaces(a: Place, b: Place): number {
    return compareKeys(this.placeKey(a, "", "", undefined), this.placeKey(b, "", "", undefined));
  }

  /** Two declarations by where each writes its name — the file and offset
   *  alone, so two declared at one place (a scope's members, in one document)
   *  keep the order they are listed in. */
  compareDeclarations(
    a: { readonly kind?: unknown; readonly metadata?: unknown },
    b: { readonly kind?: unknown; readonly metadata?: unknown },
  ): number {
    const x = this.placeKey(declarationPlace(a), "", "", undefined);
    const y = this.placeKey(declarationPlace(b), "", "", undefined);
    // A file no document set names (a scope member's synthetic one) ranks nowhere.
    if (x.fileText !== y.fileText) {
      const unranked = this.ranks.size;
      return x.file === unranked && y.file === unranked ? 0 : x.file - y.file;
    }
    return x.line - y.line || x.character - y.character;
  }

  private keyOf(d: AnalysisDiagnostic): Key {
    let key = this.keys.get(d);
    if (!key) {
      const data = d.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
      key = this.placeKey(
        {
          ...(typeof data?.resource?.kind === "string" ? { kind: data.resource.kind } : {}),
          ...(typeof data?.resource?.name === "string" ? { name: data.resource.name } : {}),
          ...(typeof data?.filePath === "string" ? { filePath: data.filePath } : {}),
          ...(typeof data?.path === "string" ? { path: data.path } : {}),
        },
        d.code === undefined ? "" : String(d.code),
        withoutConfigurationClause(d.message),
        d,
      );
      this.keys.set(d, key);
    }
    return key;
  }

  private placeKey(place: Place, code: string, message: string, d: AnalysisDiagnostic | undefined): Key {
    const located = this.locate(place);
    const file = place.filePath ?? located?.file;
    let line = 0;
    let character = 0;
    if (located) {
      const range = resolveRange(d ?? { message: "", data: { path: place.path } }, {
        positionIndex: located.document.position.positionIndex,
        sourceLine: located.document.position.sourceLine,
      });
      line = range.start.line;
      character = range.start.character;
    }
    return {
      file: file === undefined ? -1 : (this.ranks.get(file) ?? this.ranks.size),
      fileText: file ?? "",
      line,
      character,
      path: place.path ?? "",
      code,
      message,
      kind: place.kind ?? "",
      name: place.name ?? "",
      range: d?.range ? JSON.stringify(d.range) : "",
    };
  }

  private locate(place: Place): Located | undefined {
    if (place.sourceLine !== undefined && place.filePath !== undefined) {
      const written = this.byLine.get(`${place.filePath}\0${place.sourceLine}`);
      if (written) return written;
    }
    if (place.kind !== undefined && place.name !== undefined) {
      const identity = `${place.kind}\0${place.name}`;
      const found =
        (place.filePath === undefined ? undefined : this.byResource.get(`${place.filePath}\0${identity}`)) ??
        this.byResourceAnywhere.get(identity);
      if (found) return found;
    }
    return place.filePath === undefined ? undefined : this.byFile.get(place.filePath);
  }
}

function declarationPlace(m: { readonly kind?: unknown; readonly metadata?: unknown }): Place {
  const meta = m.metadata as { name?: unknown; source?: unknown; sourceLine?: unknown } | undefined;
  return {
    ...(typeof meta?.sourceLine === "number" ? { sourceLine: meta.sourceLine } : {}),
    ...(typeof m.kind === "string" ? { kind: m.kind } : {}),
    ...(typeof meta?.name === "string" ? { name: meta.name } : {}),
    ...(typeof meta?.source === "string" ? { filePath: meta.source } : {}),
    path: "metadata.name",
  };
}

function compareKeys(a: Key, b: Key): number {
  return (
    a.file - b.file ||
    compareCodePoints(a.fileText, b.fileText) ||
    a.line - b.line ||
    a.character - b.character ||
    compareCodePoints(a.path, b.path) ||
    compareCodePoints(a.code, b.code) ||
    compareCodePoints(a.message, b.message) ||
    compareCodePoints(a.kind, b.kind) ||
    compareCodePoints(a.name, b.name) ||
    compareCodePoints(a.range, b.range)
  );
}
