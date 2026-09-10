/**
 * Diagnostics and completion for `telo-workspace.yaml`.
 *
 * The marker declares no `kind:`, which is how every other path here decides a
 * YAML file is Telo's, so it is recognised by NAME and handled on its own — it
 * never reaches the analysis registry, has no imports to resolve and no manifest
 * graph to sit in.
 *
 * The rules live in `@telorun/ide-support`; what belongs here is the half a
 * browser cannot do — listing the repo so an entry that matches nothing, an
 * entry a later one shadows and a marker nested under another can be reported,
 * and so a path completion can offer real directories.
 */

import { WORKSPACE_FILENAME } from "@telorun/analyzer";
import { GLOB_PRUNE_DIRS, lastMatchIndex } from "@telorun/glob";
import {
  workspaceCompletions,
  workspaceDiagnostics,
  type WorkspaceEnvironment,
} from "@telorun/ide-support";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export function isWorkspaceMarker(document: vscode.TextDocument): boolean {
  return path.basename(document.uri.fsPath) === WORKSPACE_FILENAME;
}

interface Listing {
  readonly all: string[];
  readonly withManifest: string[];
}

/**
 * Directories under `root`, workspace-relative and POSIX.
 *
 * **Pruned with the shared set and to no depth cap**, because this answers the
 * same question `telo release` answers and a narrower walk here reports a
 * correct entry as matching nothing — a false positive in the one surface whose
 * value is that it agrees with the CLI.
 *
 * Cached per root, not per call: a fresh walk on every keystroke is what a depth
 * cap was standing in for, and it bounded the wrong axis. `invalidateListings`
 * drops the cache when a `telo.yaml` appears or disappears.
 */
const listings = new Map<string, Listing>();

export function invalidateListings(): void {
  listings.clear();
}

function listDirectories(root: string): Listing {
  const cached = listings.get(root);
  if (cached) return cached;

  const all: string[] = [];
  const withManifest: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "telo.yaml")) {
      const rel = path.relative(root, dir).split(path.sep).join("/");
      if (rel !== "") withManifest.push(rel);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || GLOB_PRUNE_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      all.push(path.relative(root, child).split(path.sep).join("/"));
      walk(child);
    }
  };
  walk(root);

  const listing = { all, withManifest };
  listings.set(root, listing);
  return listing;
}

/** Markers above this one — the nesting that gives everything beneath it a
 *  different cache root, different module keys and a different release scope. */
function enclosingMarkers(markerPath: string): string[] {
  const found: string[] = [];
  let dir = path.dirname(path.dirname(markerPath));
  for (;;) {
    if (fs.existsSync(path.join(dir, WORKSPACE_FILENAME))) found.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** Bases `.changes/ledger.yaml` records, most common first — read by line
 *  rather than parsed, because a malformed ledger must not cost the marker its
 *  completions. */
function recordedRegistries(root: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, ".changes", "ledger.yaml"), "utf8");
  } catch {
    return [];
  }
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^\s*registry:\s*(\S+)\s*$/.exec(line);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([base]) => base);
}

function environmentFor(document: vscode.TextDocument): WorkspaceEnvironment {
  const root = path.dirname(document.uri.fsPath);
  return {
    match: lastMatchIndex,
    directories: () => listDirectories(root).all,
    moduleDirectories: () => listDirectories(root).withManifest,
    enclosingMarkers: () => enclosingMarkers(document.uri.fsPath),
    recordedRegistries: () => recordedRegistries(root),
  };
}

export function markerDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  return workspaceDiagnostics(document.getText(), environmentFor(document)).map((d) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        d.range.start.line,
        d.range.start.character,
        d.range.end.line,
        d.range.end.character,
      ),
      d.message,
      d.severity === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = d.source;
    diagnostic.code = d.code;
    return diagnostic;
  });
}

export class WorkspaceMarkerCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (!isWorkspaceMarker(document)) return undefined;
    return workspaceCompletions(
      document.getText(),
      { line: position.line, character: position.character },
      environmentFor(document),
    ).map((item) => {
      const completion = new vscode.CompletionItem(
        item.label,
        item.kind === "folder"
          ? vscode.CompletionItemKind.Folder
          : item.kind === "property"
            ? vscode.CompletionItemKind.Property
            : vscode.CompletionItemKind.Value,
      );
      if (item.detail) completion.detail = item.detail;
      if (item.documentation) completion.documentation = item.documentation;
      if (item.insertText) completion.insertText = item.insertText;
      return completion;
    });
  }
}
