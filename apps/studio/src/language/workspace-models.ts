import type * as Monaco from "monaco-editor";
import type { ModuleDocument } from "../model";
import { pathToFileUri } from "./file-uri";
import type { MonacoApi } from "./lsp-to-monaco";

/** The Monaco language of every workspace manifest model. */
export const MANIFEST_LANGUAGE = "yaml";

/** The model being written from the workspace right now, if any. */
let writing: string | undefined;

/** True while `uri`'s model is being written from the workspace — a content
 *  change an editor must not read as the user typing. */
export function isWorkspaceWrite(uri: string): boolean {
  return writing === uri;
}

/**
 * One Monaco model per workspace manifest document, at the document's `file:`
 * URI, holding its current text — whether or not a source view shows it. The
 * models are what the language server sees (the LSP bridge opens every one),
 * so every module is analysed from the moment the workspace opens, and a form
 * edit reaches the engine as the text it produced.
 *
 * The workspace writes a model only when the document's text moved since it
 * last wrote it; a model the user has typed into since then keeps their text
 * until they commit it, as a source view tab does.
 */
export class WorkspaceModels {
  private readonly written = new Map<string, string>();

  constructor(private readonly monaco: MonacoApi) {}

  /** Bring the models in line with the workspace; answers the paths whose
   *  documents left it. */
  sync(documents: ReadonlyMap<string, ModuleDocument>): string[] {
    const present = new Set<string>();
    const removed: string[] = [];
    for (const [path, document] of documents) {
      if (!isAbsolutePath(path)) continue;
      present.add(path);
      this.write(path, document.loaded.text);
    }
    for (const path of [...this.written.keys()]) {
      if (present.has(path)) continue;
      this.written.delete(path);
      this.model(path)?.dispose();
      removed.push(path);
    }
    return removed;
  }

  dispose(): void {
    for (const path of this.written.keys()) this.model(path)?.dispose();
    this.written.clear();
  }

  private model(path: string): Monaco.editor.ITextModel | null {
    return this.monaco.editor.getModel(this.monaco.Uri.parse(pathToFileUri(path)));
  }

  private write(path: string, text: string): void {
    const uri = this.monaco.Uri.parse(pathToFileUri(path));
    const model = this.monaco.editor.getModel(uri);
    const last = this.written.get(path);
    this.written.set(path, text);
    if (!model) {
      this.monaco.editor.createModel(text, MANIFEST_LANGUAGE, uri);
      return;
    }
    const current = model.getValue();
    if (current === text) return;
    // Typed into since the workspace last wrote it: the user's buffer wins.
    if (last !== undefined && current !== last) {
      this.written.set(path, last);
      return;
    }
    writing = uri.toString();
    try {
      model.setValue(text);
    } finally {
      writing = undefined;
    }
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
