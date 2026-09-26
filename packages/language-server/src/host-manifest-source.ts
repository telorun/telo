import { DEFAULT_MANIFEST_FILENAME, type ManifestSource } from "@telorun/analyzer";
import { GLOB_PRUNE_DIRS, selectByPatterns } from "@telorun/glob";
import { TeloMethod, type ReadResult } from "@telorun/editor-protocol";
import {
  dirnameOf,
  isRemoteSource,
  joinSource,
  resolveAgainst,
  sourceOfUri,
  uriOfSource,
} from "./document-uri.js";
import type { HostClient } from "./host-client.js";

/** The live text of an open document, which stands in for whatever the host
 *  would read — an unsaved edit is what the author is analysing. */
export type OpenText = (source: string) => string | undefined;

/**
 * The analyzer's `ManifestSource` over the `telo/*` requests: one source for
 * every scheme, because transports are the host's. Local documents are read
 * fresh on every analysis (the host's disk may move); a remote module is read
 * once per session, since a module version does not change under a ref.
 */
export class HostManifestSource implements ManifestSource {
  private readonly remote = new Map<string, Promise<ReadResult>>();

  constructor(
    private readonly host: HostClient,
    private readonly openText: OpenText,
  ) {}

  supports(): boolean {
    return true;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const open = this.openText(url);
    if (open !== undefined) return { text: open, source: url };

    const result = await this.readThroughHost(url);
    if (result === null) {
      throw new Error(`'${url}' does not exist (the editor host found nothing at ${uriOfSource(url)}).`);
    }
    const source = sourceOfUri(result.uri);
    return { text: this.openText(source) ?? result.text, source };
  }

  resolveRelative(base: string, relative: string): string {
    return resolveAgainst(base, relative);
  }

  /** `include:` globs, matched exactly as the kernel's local source matches
   *  them: every regular file beneath the including file's directory — a link
   *  is neither collected nor descended into — the hard-ignored trees pruned,
   *  selected by `selectByPatterns` without the soft default ignores (an
   *  include may reach any co-located partial). The walk is over
   *  `telo/listDirectory`, so a host serves directories and never patterns. */
  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    const root = dirnameOf(base);
    const files: string[] = [];
    const visit = async (dir: string, rel: string): Promise<void> => {
      const entries = await this.host.request(TeloMethod.listDirectory, { uri: uriOfSource(dir) });
      if (!entries) return;
      await Promise.all(
        entries.map(async (entry) => {
          const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.kind === "file") files.push(path);
          else if (entry.kind === "directory" && !GLOB_PRUNE_DIRS.has(entry.name)) {
            await visit(joinSource(dir, entry.name), path);
          }
        }),
      );
    };
    await visit(root, "");
    return selectByPatterns(files, patterns, { applyDefaultIgnore: false }).map((rel) =>
      joinSource(root, rel),
    );
  }

  exists(base: string, relative: string): Promise<boolean> {
    return this.host.request(TeloMethod.exists, { base: uriOfSource(base), relative });
  }

  /** The nearest `telo.yaml` above `fileUrl`, an open buffer counting as
   *  present. A remote module has no enclosing workspace to walk. */
  async resolveOwnerOf(fileUrl: string): Promise<string | null> {
    if (isRemoteSource(fileUrl)) return null;
    let dir = dirnameOf(fileUrl);
    for (;;) {
      const candidate = joinSource(dir, DEFAULT_MANIFEST_FILENAME);
      if (candidate !== fileUrl) {
        if (this.openText(candidate) !== undefined) return candidate;
        if (await this.exists(candidate, DEFAULT_MANIFEST_FILENAME)) return candidate;
      }
      const parent = dirnameOf(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private readThroughHost(url: string): Promise<ReadResult> {
    const read = () => this.host.request(TeloMethod.read, { uri: uriOfSource(url) });
    if (!isRemoteSource(url)) return read();
    const cached = this.remote.get(url);
    if (cached) return cached;
    const pending = read();
    this.remote.set(url, pending);
    // A failed read is not a fact about the module, so it is asked again.
    pending.catch(() => {
      if (this.remote.get(url) === pending) this.remote.delete(url);
    });
    return pending;
  }
}
