import {
  CelParseError,
  buildLineOffsets,
  checkName,
  offsetToPosition,
  parseToAst,
  type AstDocument,
  type AstScalar,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
  type Range,
} from "@telorun/analyzer";

import { chainAt } from "../cel-chain.js";
import { resolveNodeAtPosition, scalarString } from "../completions/resolve-node.js";
import { moduleDoc, moduleForFile, moduleFiles } from "../definition/manifest-navigation.js";
import {
  declarationSites,
  resourceDeclarations,
  resourceSites,
  stepDeclarations,
  stepSites,
  type NameSite,
} from "./find-sites.js";
import type {
  RenameEdit,
  RenameFileEdits,
  RenamePreparation,
  RenameResult,
  RenameSymbol,
} from "./types.js";

/**
 * Rename a name and every reference to it.
 *
 * **This is a refactor, not a fix**, and the distinction is the reason it lives
 * here rather than behind a `DiagnosticFix`. A fix is a whole-value replacement
 * for ONE node, verified by the diagnostic that produced it; a rename is only
 * correct when every reference moves with it, which means the operation's unit
 * is the reference graph, not the node. Renaming `metadata.name` alone leaves
 * every `!ref`, `resources.<name>` and `steps.<name>.result` pointing at a name
 * that no longer exists — so a rename offered as a quick fix would break the
 * file it claimed to repair.
 *
 * **Three renameable surfaces, and every other one is an explicit refusal.**
 * What they have in common is that their reference set is *enumerable from this
 * workspace*: a resource instance, a step, and a `variables:` / `secrets:` /
 * `ports:` key are all module-local. A kind name, a module name and an import
 * alias are not supported yet — their references reach schema annotations
 * (`x-telo-ref`, `extends`, `exports.kinds`) as alias-qualified halves of a
 * larger value, which is a materially bigger surface than a bare identifier and
 * wants its own pass.
 *
 * **A name in `exports.resources` is refused outright**, and that is the load-
 * bearing refusal. Such a name is the library's public ABI: a consumer writes
 * `!ref Alias.name` and reads `resources.Alias.name`, in files this workspace
 * may not contain and, for a published consumer, cannot. Renaming it is a
 * breaking change to be *versioned*, not an edit to be applied — and a rename
 * box that silently ships one would be the worst available framing.
 *
 * **Ambiguity is refused rather than guessed.** A name declared twice in reach
 * (a `with:`-scoped resource shadowing a module-level one, two steps in one
 * resource sharing a spelling) has references that resolve to different
 * declarations, and no edit set is right for both.
 */
export function prepareRename(
  text: string,
  line: number,
  character: number,
  graph: LoadedGraph,
  currentFilePath: string,
  docs?: AstDocument[],
): RenamePreparation {
  const astDocs = docs ?? parseToAst(text);
  const resolved = resolveNodeAtPosition(text, astDocs, line, character);
  if (!resolved) return { ok: false, reason: "Nothing renameable here." };

  const mod = moduleForFile(graph, currentFilePath);
  if (!mod) {
    return { ok: false, reason: "This file is not part of a loaded Telo module." };
  }

  const lineOffsets = buildLineOffsets(text);
  const toRange = (span: [number, number]): Range => ({
    start: offsetToPosition(span[0], lineOffsets),
    end: offsetToPosition(span[1], lineOffsets),
  });

  const symbol = symbolAt(resolved, astDocs, toRange);
  if (!symbol) return { ok: false, reason: "Nothing renameable here." };
  if ("reason" in symbol) return { ok: false, reason: symbol.reason };

  const refusal = refuse(symbol, mod, currentFilePath, text, astDocs);
  return refusal ? { ok: false, reason: refusal } : { ok: true, symbol };
}

/** Prepare, validate the new name, then collect every edit. */
export function buildRename(
  text: string,
  line: number,
  character: number,
  newName: string,
  graph: LoadedGraph,
  currentFilePath: string,
  docs?: AstDocument[],
): RenameResult {
  const prepared = prepareRename(text, line, character, graph, currentFilePath, docs);
  if (!prepared.ok) return prepared;
  const { symbol } = prepared;

  if (newName === symbol.name) return { ok: true, symbol, files: [] };

  // Every renameable surface is value-level, so the new name is checked against
  // that half of the convention — the same rule `telo check` enforces. Renaming
  // *into* a name the analyzer would reject is a mistake worth catching in the
  // rename box rather than as a squiggle afterwards.
  const violation = checkName(newName, "value", surfaceLabel(symbol));
  if (violation) return { ok: false, reason: violation.message };

  const mod = moduleForFile(graph, currentFilePath)!;
  const files = filesForRename(symbol, mod, currentFilePath, text, docs);

  const out: RenameFileEdits[] = [];
  for (const file of files) {
    const edits = editsIn(file, symbol, newName);
    if (edits.length > 0) out.push({ uri: file.uri, edits });
  }
  if (out.length === 0) {
    return { ok: false, reason: `Found nothing to rename for '${symbol.name}'.` };
  }
  return { ok: true, symbol, files: out };
}

// ---------------------------------------------------------------------------
// What is under the cursor
// ---------------------------------------------------------------------------

type SymbolOrRefusal = RenameSymbol | { reason: string };

const DECLARATION_BLOCKS = new Set(["variables", "secrets", "ports"]);
const MODULE_DOC_KINDS = new Set(["Telo.Application", "Telo.Library"]);
const KIND_DOC_KINDS = new Set(["Telo.Definition", "Telo.Abstract"]);
const SELF_PREFIX = "Self.";

/** Dispatch on what the cursor sits IN rather than on the field it is under —
 *  the posture `buildDefinition` takes, so the two features agree about what a
 *  given position means. */
function symbolAt(
  resolved: ReturnType<typeof resolveNodeAtPosition> & object,
  astDocs: AstDocument[],
  toRange: (span: [number, number]) => Range,
): SymbolOrRefusal | undefined {
  if (resolved.cel) return celSymbol(resolved.cel, toRange);

  const path = resolved.path;
  const node = resolved.node;

  // A key inside `variables:` / `secrets:` / `ports:` on the module doc.
  if (
    resolved.slot === "key" &&
    node?.kind === "scalar" &&
    path.length === 1 &&
    DECLARATION_BLOCKS.has(path[0]) &&
    MODULE_DOC_KINDS.has(resolved.docKind ?? "")
  ) {
    const name = scalarString(node);
    if (!name) return undefined;
    return {
      kind: "declaration",
      name,
      range: toRange(node.range),
      block: path[0] as "variables" | "secrets" | "ports",
    };
  }

  if (resolved.slot !== "value" || node?.kind !== "scalar") return undefined;
  const scalar = node as AstScalar;

  // A `!ref` target. `<Alias>.<name>` crosses an import boundary, where the
  // declaration is another module's and the edit set is not this workspace's.
  if (scalar.tag === "!ref") {
    const raw = refText(scalar);
    if (!raw) return undefined;
    if (raw.startsWith(SELF_PREFIX)) {
      const name = raw.slice(SELF_PREFIX.length);
      const start = scalar.range[0] + SELF_PREFIX.length;
      return { kind: "resource", name, range: toRange([start, scalar.range[1]]) };
    }
    if (raw.includes(".")) {
      return {
        reason:
          `'${raw}' names an instance exported by an imported module. Rename it where it is ` +
          `declared — and only if it is not part of that module's exports.`,
      };
    }
    return { kind: "resource", name: raw, range: toRange(scalar.range) };
  }

  const name = scalarString(scalar);
  if (!name) return undefined;

  // `metadata.name` — a declaration site. Which surface it is depends on the
  // document's kind, and two of the three are type-level.
  if (path.length === 2 && path[0] === "metadata" && path[1] === "name") {
    const docKind = resolved.docKind ?? "";
    if (MODULE_DOC_KINDS.has(docKind)) {
      return {
        reason:
          "Renaming a module is not supported yet — its name is the canonical kind prefix, " +
          "so every consumer's `kind:` and `extends:` values resolve through it.",
      };
    }
    if (KIND_DOC_KINDS.has(docKind)) {
      return {
        reason:
          "Renaming a kind is not supported yet — its references are alias-qualified halves " +
          "of `kind:`, `extends:`, `x-telo-ref` and `exports.kinds` values.",
      };
    }
    if (docKind === "Telo.Import") {
      return {
        reason:
          "Renaming an import alias is not supported yet — the alias is the prefix of every " +
          "`kind:`, `extends:` and `x-telo-ref` value that resolves through it.",
      };
    }
    return { kind: "resource", name, range: toRange(scalar.range) };
  }

  // A step's `name:` — the last path segment, with no enclosing `metadata`.
  if (path.length >= 1 && path[path.length - 1] === "name") {
    return { kind: "step", name, range: toRange(scalar.range) };
  }

  // A bare scalar under `exports.resources`, which is where the ABI refusal is
  // most likely to be attempted from.
  if (path.length === 2 && path[0] === "exports" && path[1] === "resources") {
    return { kind: "resource", name, range: toRange(scalar.range) };
  }

  return undefined;
}

/** A CEL chain root that names a renameable scope, with the cursor on its
 *  member. Anything deeper is a field of a resolved value, not a declaration. */
function celSymbol(
  cel: { segment: { ast(): unknown; source: string }; offset: number },
  toRange: (span: [number, number]) => Range,
): SymbolOrRefusal | undefined {
  let ast;
  try {
    ast = cel.segment.ast() as Parameters<typeof chainAt>[0];
  } catch (error) {
    if (!(error instanceof CelParseError)) throw error;
    return undefined;
  }
  const hit = chainAt(ast, cel.offset);
  if (!hit || hit.index !== 1) return undefined;
  const root = hit.parts[0].name;
  const part = hit.parts[1];

  if (root === "resources") {
    return { kind: "resource", name: part.name, range: toRange(part.range) };
  }
  if (root === "steps") {
    return { kind: "step", name: part.name, range: toRange(part.range) };
  }
  if (DECLARATION_BLOCKS.has(root)) {
    return {
      kind: "declaration",
      name: part.name,
      range: toRange(part.range),
      block: root as "variables" | "secrets" | "ports",
    };
  }
  return undefined;
}

function refText(scalar: AstScalar): string | undefined {
  const value = scalar.value as { source?: unknown } | string | undefined;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.source === "string") return value.source;
  return undefined;
}

function surfaceLabel(symbol: RenameSymbol): string {
  if (symbol.kind === "resource") return "resource name";
  if (symbol.kind === "step") return "step name";
  return `${symbol.block === "ports" ? "port" : symbol.block === "secrets" ? "secret" : "variable"} name`;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

function refuse(
  symbol: RenameSymbol,
  mod: LoadedModule,
  currentFilePath: string,
  text: string,
  astDocs: AstDocument[],
): string | undefined {
  const doc = moduleDoc(mod) as
    | { kind?: string; exports?: { resources?: unknown } }
    | undefined;

  if (symbol.kind === "resource") {
    const exported = Array.isArray(doc?.exports?.resources)
      ? (doc!.exports!.resources as unknown[]).filter((e): e is string => typeof e === "string")
      : [];
    // An entry is either `<name>` (local) or `<Alias>.<name>` (a re-export,
    // whose declaration is not this module's anyway).
    if (exported.some((e) => e === symbol.name)) {
      return (
        `'${symbol.name}' is listed in this module's 'exports.resources', so it is part of its ` +
        `public surface — consumers reference it as '!ref <Alias>.${symbol.name}' in files this ` +
        `workspace may not contain. Renaming it is a breaking change; version it instead.`
      );
    }

    const declarations = countResourceDeclarations(mod, symbol.name, currentFilePath, text, astDocs);
    if (declarations > 1) {
      return (
        `'${symbol.name}' is declared ${declarations} times in this module — a scoped ('with:') ` +
        `declaration shadows a module-level one, so references resolve to different resources ` +
        `depending on where they sit. Disambiguate them first.`
      );
    }
    if (declarations === 0) {
      return `Could not find where '${symbol.name}' is declared in this module.`;
    }
    return undefined;
  }

  if (symbol.kind === "step") {
    // Document-scoped, and the cursor is in this file, so the live docs are the
    // only ones that can hold the declaration.
    const target = astDocs.find((d) => stepDeclarations(d, symbol.name).length > 0);
    if (!target) return `Could not find a step named '${symbol.name}' in this document.`;
    const count = stepDeclarations(target, symbol.name).length;
    if (count > 1) {
      return (
        `'${symbol.name}' names ${count} steps in this document, so 'steps.${symbol.name}.result' ` +
        `is ambiguous. Disambiguate them first.`
      );
    }
    return undefined;
  }

  // A Library's declared config is its contract: an importer passes values
  // keyed by these names, so renaming one breaks every consumer exactly as
  // renaming an exported instance does.
  if (doc?.kind === "Telo.Library") {
    return (
      `'${symbol.block}.${symbol.name}' is part of this library's contract — importers pass ` +
      `values keyed by that name. Renaming it is a breaking change; version it instead.`
    );
  }
  return undefined;
}

/** Declarations of a resource name across the module, counting nested (scoped)
 *  ones. The live buffer stands in for the current file's snapshot. */
function countResourceDeclarations(
  mod: LoadedModule,
  name: string,
  currentFilePath: string,
  text: string,
  astDocs: AstDocument[],
): number {
  let count = 0;
  for (const file of moduleFiles(mod)) {
    const docs = file.source === currentFilePath ? astDocs : file.astDocuments;
    for (const doc of docs) count += resourceDeclarations(doc, name).length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Edit collection
// ---------------------------------------------------------------------------

/** A file to rewrite, with the text its offsets are measured against. */
interface RenameFile {
  uri: string;
  text: string;
  docs: AstDocument[];
}

/**
 * Which files a rename may touch.
 *
 * A resource or a config declaration is module-scoped, so every file in the
 * module's scope is in range. A **step is document-scoped**: `steps.<name>.result`
 * is readable only inside the resource whose body declares the step, and a
 * resource is one YAML document — so the edit set is that document alone, which
 * is also what makes two same-named steps in one document the ambiguity to
 * refuse rather than a cross-file hazard.
 *
 * The live buffer always stands in for the current file. The graph is a snapshot
 * taken at the last analysis, so applying edits computed against it would write
 * stale offsets into a file the author has since edited.
 */
function filesForRename(
  symbol: RenameSymbol,
  mod: LoadedModule,
  currentFilePath: string,
  text: string,
  docs: AstDocument[] | undefined,
): RenameFile[] {
  const live = docs ?? parseToAst(text);
  const asRenameFile = (file: LoadedFile): RenameFile =>
    file.source === currentFilePath
      ? { uri: file.source, text, docs: live }
      : { uri: file.source, text: file.text, docs: file.astDocuments };

  const all = moduleFiles(mod).map(asRenameFile);
  if (symbol.kind !== "step") return all;

  // Narrow to the one document declaring the step.
  for (const file of all) {
    const index = file.docs.findIndex((d) => stepDeclarations(d, symbol.name).length > 0);
    if (index >= 0) return [{ ...file, docs: [file.docs[index]] }];
  }
  return [];
}

function editsIn(file: RenameFile, symbol: RenameSymbol, newName: string): RenameEdit[] {
  const lineOffsets = buildLineOffsets(file.text);
  const spans: Array<[number, number]> = [];

  for (const doc of file.docs) {
    if (symbol.kind === "resource") {
      for (const span of resourceDeclarations(doc, symbol.name)) spans.push(span);
      for (const site of resourceSites(doc, symbol.name)) spans.push(site.range);
      for (const span of exportEntrySpans(doc, symbol.name)) spans.push(span);
    } else if (symbol.kind === "step") {
      for (const span of stepDeclarations(doc, symbol.name)) spans.push(span);
      for (const site of stepSites(doc, symbol.name)) spans.push(site.range);
    } else {
      for (const span of declarationKeySpans(doc, symbol.block!, symbol.name)) spans.push(span);
      for (const site of declarationSites(doc, symbol.block!, symbol.name)) spans.push(site.range);
    }
  }

  // Sorted and de-duplicated: a host applies a set of edits, and two edits over
  // one span — which a name reachable by two walks would produce — is an
  // overlapping-edit error in every LSP client.
  return dedupe(spans).map((span) => ({
    range: {
      start: offsetToPosition(span[0], lineOffsets),
      end: offsetToPosition(span[1], lineOffsets),
    },
    newText: newName,
  }));
}

function dedupe(spans: Array<[number, number]>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const span of spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const key = `${span[0]}:${span[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span);
  }
  return out;
}

/** Spans of `exports.resources` entries naming the resource. Collected even
 *  though an exported name is refused, because the refusal is decided from the
 *  module doc's JSON while these come from the AST: a name reached here that the
 *  refusal did not catch (a re-export spelled `Self.<name>`) still has to move
 *  with its declaration rather than being left dangling. */
function exportEntrySpans(doc: AstDocument, name: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (doc.root?.kind !== "map") return out;
  for (const pair of doc.root.entries) {
    if (scalarString(pair.key) !== "exports" || pair.value?.kind !== "map") continue;
    for (const inner of pair.value.entries) {
      if (scalarString(inner.key) !== "resources" || inner.value?.kind !== "seq") continue;
      for (const item of inner.value.items) {
        if (item.kind !== "scalar") continue;
        const value = scalarString(item);
        if (value === name) out.push(item.range);
        else if (value === `${SELF_PREFIX}${name}`) {
          out.push([item.range[0] + SELF_PREFIX.length, item.range[1]]);
        }
      }
    }
  }
  return out;
}

/** The `variables:` / `secrets:` / `ports:` key itself. */
function declarationKeySpans(
  doc: AstDocument,
  block: string,
  name: string,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (doc.root?.kind !== "map") return out;
  for (const pair of doc.root.entries) {
    if (scalarString(pair.key) !== block || pair.value?.kind !== "map") continue;
    for (const inner of pair.value.entries) {
      if (inner.key.kind === "scalar" && scalarString(inner.key) === name) {
        out.push(inner.key.range);
      }
    }
  }
  return out;
}
