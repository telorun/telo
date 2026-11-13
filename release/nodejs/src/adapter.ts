/**
 * The seam between the planner and an ecosystem.
 *
 * The planner never branches on an ecosystem's name. Everything it needs to know
 * about npm, Cargo, a Dockerfile or a Telo module is an answer from that
 * ecosystem's adapter, registered in-process by the host program — never
 * discovered from installed packages. This is the adapter's PURE half: it reads
 * file text a host hands it and answers from that alone, so the editor and the
 * planner run it in a browser. Payload file sets, edges and registry read-back
 * are the evidence half a Node host adds.
 */

import type { WorkspaceKeySchema } from "./marker-schema.js";

/** A version location: a file, and optionally an RFC 6901 pointer into it when
 *  the file is JSON, YAML or TOML. Paths here are relative to whatever declared
 *  them — an anchor, or a unit. */
export interface VersionLocationSpec {
  readonly file: string;
  readonly pointer?: string;
}

/** What an adapter is shown of one anchor. */
export interface AnchorProbe {
  /** The unit's key. */
  readonly unit: string;
  /** The anchor, relative to the unit (`.` is the unit's own directory). */
  readonly anchor: string;
  /** The anchor's workspace-relative directory (`""` at the workspace root). */
  readonly dir: string;
  /** A file beneath the anchor, by anchor-relative POSIX path; `undefined` when
   *  absent. */
  readFile(relative: string): string | undefined;
}

/** An anchor the adapter recognised as one package of its ecosystem. */
export interface RecognizedPackage {
  /** The package's own name, for display. */
  readonly name?: string;
  /** Whether the package contributes a layer to the unit's payload. A package
   *  that is never published (a private npm package) supplies its version
   *  location and edges, but no layer. */
  readonly contributesLayer: boolean;
  /** Further anchor-relative files carrying the unit's version, written with it
   *  by `apply` (a module's own npm and Cargo packages). */
  readonly versionFiles?: readonly string[];
}

/** Reads and writes the version in one kind of file, chosen by its file name. */
export interface VersionFileHandler {
  /** The file name it serves (`package.json`, `Cargo.toml`). */
  readonly fileName: string;
  /** The version the file carries, or `undefined` when it carries none. */
  read(text: string, where: string): string | undefined;
  /** The file rewritten to carry `version`, or `undefined` when it carries no
   *  version to write. Touches nothing else. */
  write(text: string, version: string, where: string): string | undefined;
  /** Files outside this one that must move with it (a crate's `Cargo.lock`
   *  entry), each rewritten. `file` is workspace-relative and `read` reads any
   *  workspace-relative file; nothing above the workspace is reachable. */
  companions?(
    file: string,
    version: string,
    read: (path: string) => string | undefined,
  ): readonly { readonly file: string; readonly text: string }[];
}

export interface EcosystemAdapter {
  /** The name a `release.units` entry lists under `ecosystem`. */
  readonly ecosystem: string;
  /** What an anchor of this ecosystem is, for an author reading a refusal. */
  readonly anchorDescription: string;
  /** The keys this ecosystem reads in an anchor's settings
   *  (`ecosystem: { <ecosystem>: { <anchor>: { <key>: … } } }`) and in its block
   *  defaults (`release.ecosystems.<ecosystem>`). An anchor's value of a key
   *  replaces the block's. */
  readonly keys?: Readonly<Record<string, WorkspaceKeySchema>>;
  /** Where an anchor of this ecosystem keeps its version, anchor-relative;
   *  absent when it keeps none. */
  readonly versionFile?: VersionLocationSpec;
  /** Whether the anchor holds exactly one package of this ecosystem. */
  recognize(probe: AnchorProbe): RecognizedPackage | undefined;
  readonly versionFileHandlers?: readonly VersionFileHandler[];
}

/** The ecosystem names the planner keeps for its own layers. */
export const RESERVED_ECOSYSTEMS: ReadonlySet<string> = new Set(["payload"]);

/** The adapters one host registered, by ecosystem, with their version-file
 *  handlers by file name. */
export class AdapterRegistry {
  private readonly byEcosystem = new Map<string, EcosystemAdapter>();
  private readonly handlers = new Map<string, VersionFileHandler>();

  constructor(adapters: readonly EcosystemAdapter[]) {
    for (const adapter of adapters) {
      if (RESERVED_ECOSYSTEMS.has(adapter.ecosystem)) {
        throw new Error(`'${adapter.ecosystem}' is reserved and names no ecosystem.`);
      }
      if (this.byEcosystem.has(adapter.ecosystem)) {
        throw new Error(`Two adapters are registered for the '${adapter.ecosystem}' ecosystem.`);
      }
      this.byEcosystem.set(adapter.ecosystem, adapter);
      for (const handler of adapter.versionFileHandlers ?? []) {
        const existing = this.handlers.get(handler.fileName);
        if (existing && existing !== handler) {
          throw new Error(`Two version-file handlers are registered for '${handler.fileName}'.`);
        }
        this.handlers.set(handler.fileName, handler);
      }
    }
  }

  get(ecosystem: string): EcosystemAdapter | undefined {
    return this.byEcosystem.get(ecosystem);
  }

  has(ecosystem: string): boolean {
    return this.byEcosystem.has(ecosystem);
  }

  all(): readonly EcosystemAdapter[] {
    return [...this.byEcosystem.values()];
  }

  handlerFor(fileName: string): VersionFileHandler | undefined {
    return this.handlers.get(fileName);
  }
}
