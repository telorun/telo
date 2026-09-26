import type * as Monaco from "monaco-editor";
import type { Position } from "vscode-languageserver-protocol";
import type { ModelProjection } from "../language/model-projections";
import { moduleParseError, parseModuleDocument } from "../yaml-document";
import {
  positionInFile,
  positionInSlice,
  sliceInText,
  writtenSlice,
  type YamlSlice,
} from "./detail-yaml-slice";

/** What the pane shows: the slice's text, or why there is none. */
export type SliceView = { text: string } | { error: string };

/**
 * One node's YAML as a live projection of its document's model — the model the
 * engine analyses. The pane holds no text of its own: a keystroke is spliced
 * into the document model at once, and whenever the document model changes for
 * any other reason (the source view, a rename, an engine edit, the workspace)
 * the slice is located again in the new text and the pane re-derived from it.
 * The positions map both ways, so the language bridge serves the pane through
 * the document.
 */
export class YamlSliceProjection implements ModelProjection {
  readonly source: string;
  private slice: YamlSlice | undefined;
  private view: SliceView;
  private writing = false;
  private deriving = false;
  private readonly listener: Monaco.IDisposable;

  constructor(
    readonly model: Monaco.editor.ITextModel,
    private readonly document: Monaco.editor.ITextModel,
    private readonly node: { filePath: string; kind: string; name: string; pointer: string },
    private readonly onView: (view: SliceView) => void,
    private readonly onMoved: () => void,
  ) {
    this.source = document.uri.toString();
    this.view = this.locate();
    this.show();
    this.listener = document.onDidChangeContent(() => {
      if (this.writing) return;
      this.view = this.locate();
      this.show();
      this.onView(this.view);
      this.onMoved();
    });
  }

  /** True while the projected model is being written from the document — a
   *  change an editor must not write back. */
  isDeriving(): boolean {
    return this.deriving;
  }

  current(): SliceView {
    return this.view;
  }

  /** Write the pane's text into the document model. */
  edit(text: string): void {
    const slice = this.slice;
    if (!slice) return;
    const written = writtenSlice(slice, text);
    const start = this.document.getPositionAt(slice.start);
    const end = this.document.getPositionAt(slice.end);
    this.slice = { ...slice, text, end: slice.start + written.length + slice.trailing.length };
    this.view = { text };
    this.onView(this.view);
    this.writing = true;
    try {
      this.document.pushEditOperations(
        [],
        [
          {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text: written + slice.trailing,
          },
        ],
        () => null,
      );
    } finally {
      this.writing = false;
    }
    this.onMoved();
  }

  toSource(position: Position): Position {
    return this.slice ? positionInFile(this.document.getValue(), this.slice, position) : position;
  }

  fromSource(position: Position): Position | undefined {
    return this.slice ? positionInSlice(this.document.getValue(), this.slice, position) : undefined;
  }

  dispose(): void {
    this.listener.dispose();
  }

  private show(): void {
    if (!("text" in this.view) || this.model.getValue() === this.view.text) return;
    this.deriving = true;
    try {
      this.model.setValue(this.view.text);
    } finally {
      this.deriving = false;
    }
  }

  private locate(): SliceView {
    const text = this.document.getValue();
    const { filePath, kind, name, pointer } = this.node;
    const parsed = parseModuleDocument(filePath, text);
    const error = moduleParseError(parsed);
    this.slice = error ? undefined : sliceInText(parsed.loaded.astDocuments, text, kind, name, pointer);
    if (error) return { error: `${filePath} does not parse (${error}); fix it in the source view.` };
    if (!this.slice) {
      return {
        error: pointer
          ? `Nothing is written at ${pointer} yet — author it in the form, then it appears here.`
          : `${filePath} no longer declares ${kind} '${name}'.`,
      };
    }
    return { text: this.slice.text };
  }
}
