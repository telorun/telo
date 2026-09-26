/**
 * `telo-workspace.yaml`: checks and completions.
 *
 * The marker declares no `kind:`, so it is recognised by NAME and never reaches
 * a module analysis. The rules are ide-support's; what the engine adds is the
 * half that needs to see the repository — a directory listing, the markers above
 * this one, the registries the release ledger records — read through the host,
 * so an entry matching nothing is reported exactly as `telo release` would find
 * it.
 */

import { WORKSPACE_FILENAME } from "@telorun/analyzer";
import { TeloMethod } from "@telorun/editor-protocol";
import { GLOB_PRUNE_DIRS, lastMatchIndex } from "@telorun/glob";
import {
  workspaceCompletions,
  workspaceDiagnostics,
  type CompletionResult,
  type Position,
  type WorkspaceEnvironment,
} from "@telorun/ide-support";
import type { Diagnostic } from "vscode-languageserver/browser";
import { basenameOf, dirnameOf, joinSource, uriOfSource } from "./document-uri.js";
import type { HostClient } from "./host-client.js";
import { toLspDiagnostic } from "./lsp-diagnostic.js";

interface Listing {
  readonly all: string[];
  readonly withManifest: string[];
}

export class WorkspaceMarkers {
  /** Per marker directory. Pruned with the shared set and to no depth cap,
   *  because this answers the question `telo release` answers and a narrower
   *  walk reports a correct entry as matching nothing. Cached rather than walked
   *  per keystroke; dropped when a `telo.yaml` appears or disappears. */
  private readonly listings = new Map<string, Promise<Listing>>();

  constructor(private readonly host: HostClient) {}

  isMarker(source: string): boolean {
    return basenameOf(source) === WORKSPACE_FILENAME;
  }

  invalidate(): void {
    this.listings.clear();
  }

  async diagnostics(source: string, text: string): Promise<Diagnostic[]> {
    return workspaceDiagnostics(text, await this.environmentFor(source)).map(toLspDiagnostic);
  }

  async completions(source: string, text: string, position: Position): Promise<CompletionResult[]> {
    return workspaceCompletions(text, position, await this.environmentFor(source));
  }

  private async environmentFor(source: string): Promise<WorkspaceEnvironment> {
    const root = dirnameOf(source);
    const [listing, outer, registries] = await Promise.all([
      this.listing(root),
      this.enclosingMarkers(source),
      this.recordedRegistries(root),
    ]);
    return {
      match: lastMatchIndex,
      directories: () => listing.all,
      moduleDirectories: () => listing.withManifest,
      enclosingMarkers: () => outer,
      recordedRegistries: () => registries,
    };
  }

  private listing(root: string): Promise<Listing> {
    const cached = this.listings.get(root);
    if (cached) return cached;
    const pending = this.walk(root);
    this.listings.set(root, pending);
    pending.catch(() => {
      if (this.listings.get(root) === pending) this.listings.delete(root);
    });
    return pending;
  }

  private async walk(root: string): Promise<Listing> {
    const all: string[] = [];
    const withManifest: string[] = [];
    const visit = async (dir: string, rel: string): Promise<void> => {
      const entries = await this.host.request(TeloMethod.listDirectory, { uri: uriOfSource(dir) });
      if (!entries) return;
      if (rel !== "" && entries.some((e) => e.kind === "file" && e.name === "telo.yaml")) {
        withManifest.push(rel);
      }
      const children = entries.filter((e) => e.kind === "directory" && !GLOB_PRUNE_DIRS.has(e.name));
      for (const child of children) all.push(rel === "" ? child.name : `${rel}/${child.name}`);
      await Promise.all(
        children.map((child) =>
          visit(joinSource(dir, child.name), rel === "" ? child.name : `${rel}/${child.name}`),
        ),
      );
    };
    await visit(root, "");
    return { all: all.sort(), withManifest: withManifest.sort() };
  }

  /** Directories above this marker's own that hold a marker, nearest first. */
  private async enclosingMarkers(source: string): Promise<string[]> {
    const found: string[] = [];
    let dir = dirnameOf(dirnameOf(source));
    for (;;) {
      const exists = await this.host.request(TeloMethod.exists, {
        base: uriOfSource(joinSource(dir, WORKSPACE_FILENAME)),
        relative: WORKSPACE_FILENAME,
      });
      if (exists) found.push(dir);
      const parent = dirnameOf(dir);
      if (parent === dir) return found;
      dir = parent;
    }
  }

  /** Registry bases `.changes/ledger.yaml` records, most common first — read by
   *  line, so a malformed ledger does not cost the marker its completions. */
  private async recordedRegistries(root: string): Promise<string[]> {
    const ledger = await this.host.request(TeloMethod.read, {
      uri: uriOfSource(joinSource(root, ".changes/ledger.yaml")),
    });
    if (!ledger) return [];
    const counts = new Map<string, number>();
    for (const line of ledger.text.split("\n")) {
      const match = /^\s*registry:\s*(\S+)\s*$/.exec(line);
      if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([base]) => base);
  }
}
