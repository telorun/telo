import type * as Monaco from "monaco-editor";
import type { Position } from "vscode-languageserver-protocol";

/**
 * A model showing part of another document — its text a function of the
 * source's, its positions mapped both ways. The language server never sees the
 * projection: every request is asked of the source document at the mapped
 * position, and every answer is mapped back, dropping what falls outside.
 * Positions are LSP's, 0-based.
 */
export interface ModelProjection {
  model: Monaco.editor.ITextModel;
  /** URI of the document the projection shows part of. */
  source: string;
  toSource(position: Position): Position;
  /** `undefined` when the source position lies outside the projection. */
  fromSource(position: Position): Position | undefined;
}

/**
 * The projections a host has open, by projected model URI. Language-agnostic:
 * what a projection shows and how its positions move is the host's; the LSP
 * bridge reads it to serve projected models.
 */
export class ModelProjections {
  private readonly byModel = new Map<string, ModelProjection>();
  private readonly listeners = new Set<(projection: ModelProjection) => void>();

  /** @param scheme the URI scheme every projected model uses. */
  constructor(readonly scheme: string) {}

  add(projection: ModelProjection): { dispose(): void } {
    const key = projection.model.uri.toString();
    this.byModel.set(key, projection);
    this.changed(projection);
    return {
      dispose: () => {
        if (this.byModel.get(key) === projection) this.byModel.delete(key);
      },
    };
  }

  get(model: Monaco.editor.ITextModel): ModelProjection | undefined {
    return this.byModel.get(model.uri.toString());
  }

  all(): ModelProjection[] {
    return [...this.byModel.values()];
  }

  /** The projection's geometry moved: what is painted on it is stale. */
  changed(projection: ModelProjection): void {
    for (const listener of this.listeners) listener(projection);
  }

  onDidChange(listener: (projection: ModelProjection) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
