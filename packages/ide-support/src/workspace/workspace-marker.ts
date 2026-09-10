/**
 * Editing `telo-workspace.yaml`.
 *
 * The marker is not a manifest — it declares no `kind:`, which is exactly how a
 * host decides a YAML file is Telo's — so nothing here goes through the analysis
 * registry. What it shares with every other surface is the RULE: the shape is
 * declared once as data in the analyzer, the reader is lenient, and this is one
 * of its two consumers. An editor offering a key the checker rejects is the
 * failure a second key list produces, so there is not one.
 *
 * **Two tiers of diagnostic, and the second is optional.** Everything decidable
 * from the text alone always runs. The three that need to see the repo — a
 * pattern matching nothing, an entry a later one shadows, a marker nested under
 * another — need a directory listing, which the browser-safe half must not do,
 * so they arrive through a supplied environment and are simply absent without
 * one (the `buildImportUpgrades` precedent).
 */

import {
  DiagnosticSeverity,
  WORKSPACE_SCHEMA,
  MODULE_ENTRY_KEYS,
  readWorkspaceConfig,
  settingsForModule,
  type PatternMatch,
  type Position,
  type Range,
  type WorkspaceDiagnostic,
} from "@telorun/analyzer";
import { isMap, isSeq, parseDocument, type Document, type Node } from "yaml";
import type { CompletionResult, NormalizedDiagnostic } from "../types.js";

/**
 * What a host can tell this module about the repo the marker sits in.
 *
 * Every member is optional in effect: a host that cannot answer one loses the
 * checks and completions that rest on it, and nothing else.
 */
export interface WorkspaceEnvironment {
  /** Gitignore-style matching, from the glob package the host already has. */
  readonly match: PatternMatch;
  /** Workspace-relative POSIX directories, for `env.roots`. */
  readonly directories?: () => readonly string[];
  /** Workspace-relative POSIX directories holding a `telo.yaml`, for
   *  `release.modules`. */
  readonly moduleDirectories?: () => readonly string[];
  /** Markers above this one, workspace-relative, nearest first. */
  readonly enclosingMarkers?: () => readonly string[];
  /** Registry bases `.changes/ledger.yaml` records, most common first. */
  readonly recordedRegistries?: () => readonly string[];
}

const SOURCE = "telo-workspace";

export function workspaceDiagnostics(
  text: string,
  env?: WorkspaceEnvironment,
): NormalizedDiagnostic[] {
  const doc = parseDocument(text);
  const { config, diagnostics } = readWorkspaceConfig(text, "telo-workspace.yaml");
  const out = diagnostics.map((diagnostic) => normalize(diagnostic, doc, text));

  if (!env) return out;

  const modules = config.release?.modules ?? [];
  const moduleDirs = env.moduleDirectories?.();
  if (moduleDirs) {
    // A pattern under which no directory holds a manifest is overwhelmingly a
    // typo in a subtree name — the failure a four-way workspace split hid for
    // months, because nothing ever said the entry was doing nothing.
    const claimed = modules.map(() => new Set<string>());
    for (const dir of moduleDirs) {
      const settings = settingsForModule({ modules }, dir, env.match);
      if (settings) claimed[settings.entry]!.add(dir);
    }
    for (const [index, entry] of modules.entries()) {
      if (entry.path.startsWith("!")) continue;
      const at: (string | number)[] = ["release", "modules", index];
      if (claimed[index]!.size !== 0) continue;

      // Three ways an entry can claim nothing, and they send an author to three
      // different places: a pattern that matches no directory at all is a typo,
      // while one every later entry re-claims or every later negation removes is
      // correct and inert. Reporting the last two as "matches no directory" is
      // factually wrong and starts a hunt for a typo that is not there.
      const overtaken = modules.findIndex(
        (later, laterIndex) =>
          laterIndex > index &&
          moduleDirs.some(
            (dir) => env.match(dir, [entry.path]) >= 0 && env.match(dir, [later.path]) >= 0,
          ),
      );
      if (overtaken < 0) {
        out.push(
          make(
            "WORKSPACE_ENTRY_MATCHES_NOTHING",
            `'${entry.path}' matches no directory holding a telo.yaml, so it discovers no module.`,
            at,
            doc,
            text,
            DiagnosticSeverity.Warning,
          ),
        );
        continue;
      }
      const later = modules[overtaken]!;
      out.push(
        make(
          "WORKSPACE_ENTRY_SHADOWED",
          later.path.startsWith("!")
            ? `'${entry.path}' claims no module: every one it matches is excluded by ` +
                `'${later.path}', which comes later and therefore wins.`
            : `'${entry.path}' claims no module: every one it matches is also matched by ` +
                `'${later.path}', which comes later and therefore wins. Its settings apply to ` +
                `nothing.`,
          at,
          doc,
          text,
          DiagnosticSeverity.Warning,
        ),
      );
    }
  }

  const dirs = env.directories?.();
  if (dirs && config.env?.roots) {
    for (const [index, pattern] of config.env.roots.entries()) {
      if (pattern.startsWith("!")) continue;
      if (dirs.some((dir) => env.match(dir, [pattern]) >= 0)) continue;
      out.push(
        make(
          "WORKSPACE_ENTRY_MATCHES_NOTHING",
          `'${pattern}' matches no directory, so it bounds no env walk.`,
          ["env", "roots", index],
          doc,
          text,
          DiagnosticSeverity.Warning,
        ),
      );
    }
  }

  const outer = env.enclosingMarkers?.();
  if (outer?.length) {
    out.push(
      make(
        "WORKSPACE_MARKER_SHADOWED",
        `Another telo-workspace.yaml sits above this one at '${outer[0]}'. Everything beneath ` +
          `this marker takes a different module cache, different module keys and a different ` +
          `release scope from everything beneath that one.`,
        [],
        doc,
        text,
        DiagnosticSeverity.Warning,
      ),
    );
  }

  return out;
}

function normalize(
  diagnostic: WorkspaceDiagnostic,
  doc: Document,
  text: string,
): NormalizedDiagnostic {
  return make(
    diagnostic.code,
    diagnostic.message,
    [...diagnostic.path],
    doc,
    text,
    diagnostic.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
  );
}

function make(
  code: string,
  message: string,
  path: (string | number)[],
  doc: Document,
  text: string,
  severity: DiagnosticSeverity,
): NormalizedDiagnostic {
  return { range: rangeOf(doc, text, path), severity, code, source: SOURCE, message };
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * The span a key path names.
 *
 * A path ending at a mapping key anchors on the KEY, not its value: an unknown
 * key has no value worth underlining, and a wrong-typed one reads better with
 * the name in the squiggle. A path that resolves to nothing falls back to the
 * document's first line rather than to nothing at all, since a diagnostic with
 * no range is one a host silently drops.
 */
function rangeOf(doc: Document, text: string, path: (string | number)[]): Range {
  const span = offsetsOf(doc, path);
  return span
    ? { start: positionAt(text, span[0]), end: positionAt(text, span[1]) }
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

function offsetsOf(doc: Document, path: (string | number)[]): [number, number] | undefined {
  if (path.length === 0) {
    const contents = doc.contents as { range?: [number, number, number] } | null;
    return contents?.range ? [contents.range[0], contents.range[0]] : undefined;
  }

  const parent = path.length === 1 ? doc.contents : (doc.getIn(path.slice(0, -1), true) as Node);
  const last = path[path.length - 1]!;

  if (isMap(parent) && typeof last === "string") {
    const pair = parent.items.find(
      (item) => String((item.key as { value?: unknown })?.value) === last,
    );
    const node = (pair?.key ?? pair?.value) as { range?: [number, number, number] } | undefined;
    if (node?.range) return [node.range[0], node.range[1]];
  }
  if (isSeq(parent) && typeof last === "number") {
    const node = parent.items[last] as { range?: [number, number, number] } | undefined;
    if (node?.range) return [node.range[0], node.range[1]];
  }

  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  return node?.range ? [node.range[0], node.range[1]] : undefined;
}

/** Offsets come from the YAML AST; a host wants line/character. */
function positionAt(text: string, offset: number): Position {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < bounded; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: bounded - lineStart };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * What may be written at the cursor.
 *
 * Keys come from the same declared shape the strict half walks. Values come from
 * the repo where a host can see it: directories holding a manifest at
 * `release.modules`, any directory at `env.roots`, and the base the ledger
 * already records at `release.registry` — that value is written down, and
 * retyping it differently is exactly what `LEDGER_REGISTRY_MISMATCH` exists to
 * catch.
 *
 * **The cursor is located on the SAME parsed document the diagnostics use.** A
 * line/indent scanner beside an AST is two structural readings of one file, and
 * the cheaper one cannot see a flow mapping, a block scalar or a comment
 * containing `key:` — so `release: {modules: [x]}` would silently offer nothing.
 * Indentation is consulted only where the parser genuinely has no node to offer:
 * a half-typed line is not yet part of any collection, which is exactly when
 * completion is asked.
 */
export function workspaceCompletions(
  text: string,
  position: Position,
  env?: WorkspaceEnvironment,
): CompletionResult[] {
  const doc = parseDocument(text);
  const at = contextAt(doc, text, position);

  if (at.kind === "value") {
    switch (at.path.join(".")) {
      case "release.registry":
        return (env?.recordedRegistries?.() ?? []).map((base) => ({
          label: base,
          kind: "value" as const,
          detail: "recorded in .changes/ledger.yaml",
        }));
      case "release.modules":
        return (env?.moduleDirectories?.() ?? []).map((dir) => ({
          label: dir,
          kind: "folder" as const,
          detail: "holds a telo.yaml",
        }));
      case "release.ignore":
        return valuesFrom(WORKSPACE_SCHEMA.release.properties.ignore.examples);
      case "env.roots":
        return (env?.directories?.() ?? []).map((dir) => ({ label: dir, kind: "folder" as const }));
      case "env.files":
        return valuesFrom(WORKSPACE_SCHEMA.env.properties.files.examples);
      default:
        return [];
    }
  }

  // A key position. Which key set depends only on where the path lands.
  if (at.path.length === 0) {
    return Object.entries(WORKSPACE_SCHEMA).map(([name, schema]) =>
      keyItem(name, schema.description),
    );
  }
  const [block, ...rest] = at.path;
  if (block === "release") {
    // Inside one `modules:` entry the keys are the entry's, not the block's.
    const properties =
      rest[0] === "modules" && rest.length > 1 ? MODULE_ENTRY_KEYS : WORKSPACE_SCHEMA.release.properties;
    return Object.entries(properties).map(([name, schema]) => keyItem(name, schema.description));
  }
  if (block === "env") {
    return Object.entries(WORKSPACE_SCHEMA.env.properties).map(([name, schema]) =>
      keyItem(name, schema.description),
    );
  }
  return [];
}

function valuesFrom(examples: readonly string[] | undefined): CompletionResult[] {
  return (examples ?? []).map((label) => ({ label, kind: "value" as const }));
}

function keyItem(name: string, documentation: string): CompletionResult {
  return { label: name, kind: "property", insertText: `${name}:`, documentation };
}

interface CursorContext {
  /** `value` when the cursor sits where a value goes — after a `key:` or in a
   *  sequence item; `key` when it sits where a key goes. */
  readonly kind: "key" | "value";
  /** The path to the collection or key the cursor is in. For a value it names
   *  the key whose value is being written. */
  readonly path: readonly string[];
}

/**
 * Where the cursor is, off the parsed document.
 *
 * The AST answers whenever the document contains a node covering the offset,
 * which is every complete construct including flow mappings. The indentation
 * fallback covers exactly one case the parser cannot: a line the author has
 * started but not finished, which belongs to no node yet.
 */
function contextAt(doc: Document, text: string, position: Position): CursorContext {
  const offset = offsetOf(text, position);
  const line = text.split("\n")[position.line] ?? "";

  // A `key:` with nothing after it on the line, or a sequence item — both are
  // value positions, and both are decidable from the line the cursor is on
  // without guessing at STRUCTURE, which is what the AST supplies below.
  const afterKey = /^\s*([A-Za-z][A-Za-z0-9_]*):\s*\S*$/.exec(line);
  const inItem = /^\s*-\s*\S*$/.test(line);

  // The AST decides both facts where it has a node: which collection the offset
  // is in, and whether that position holds a key or a value. Only where it has
  // none — a half-typed line — does the line itself answer.
  const fromAst = pathAtOffset(doc, offset);
  if (fromAst) return fromAst;

  const path = indentPath(text, position.line);
  if (afterKey) return { kind: "value", path: [...path, afterKey[1]!] };
  if (inItem) return { kind: "value", path };
  return { kind: "key", path };
}

function offsetOf(text: string, position: Position): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i]!.length + 1;
  return offset + position.character;
}

/**
 * Where `offset` lands, or `undefined` when no node covers it — a half-typed
 * line belongs to nothing yet.
 *
 * Landing on a mapping means a key is being written; landing inside a pair's
 * value or a sequence item means a value is. That is the same distinction a line
 * scanner guesses at from a trailing `:` or a `- `, decided here from what the
 * parser actually built — which is why a flow mapping resolves at all.
 */
function pathAtOffset(doc: Document, offset: number): CursorContext | undefined {
  const path: string[] = [];
  let node: unknown = doc.contents;
  let covered = false;
  let kind: "key" | "value" = "key";

  for (;;) {
    if (isMap(node)) {
      const pair = node.items.find((item) => within(item.value, offset) || within(item.key, offset));
      if (!pair) break;
      covered = true;
      // On the key itself, the author is writing a key of THIS mapping.
      if (within(pair.key, offset) && !within(pair.value, offset)) {
        kind = "key";
        break;
      }
      const key = (pair.key as { value?: unknown } | null)?.value;
      if (typeof key === "string") path.push(key);
      kind = "value";
      node = pair.value;
      continue;
    }
    if (isSeq(node)) {
      const item = node.items.find((candidate) => within(candidate, offset));
      if (!item) break;
      covered = true;
      kind = "value";
      node = item;
      continue;
    }
    break;
  }

  if (!covered) return undefined;
  // A mapping the walk ended ON is a key position, whatever reached it.
  if (isMap(node)) kind = "key";
  return { kind, path };
}

function within(node: unknown, offset: number): boolean {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range !== undefined && offset >= range[0] && offset <= range[1];
}

/**
 * The keys enclosing a line the parser has no node for, by indentation.
 *
 * The one fallback, and it is not a second reading of the document: it runs only
 * where the AST has nothing to say, and it answers the same question in the same
 * vocabulary.
 */
function indentPath(text: string, at: number): string[] {
  const lines = text.split("\n");
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  let want = indentOf(lines[at] ?? "");
  const path: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent >= want) continue;
    const key = /^\s*-?\s*([A-Za-z][A-Za-z0-9_]*):/.exec(line);
    if (key) path.unshift(key[1]!);
    want = indent;
    if (indent === 0) break;
  }
  return path;
}
