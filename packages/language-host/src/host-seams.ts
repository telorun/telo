import type { DirectoryEntry, ReadResult, TeloHostRequests } from "@telorun/editor-protocol";

/** An engine file the host has stored, with the digest recorded when it was
 *  stored (`sha512-<base64>`). */
export interface CachedEngine {
  bytes: Uint8Array;
  digest: string;
}

/** Host-supplied storage for extracted engines, by telo version. The digest is
 *  rechecked against the bytes on every load, so a file changed on disk is
 *  refused and fetched again rather than run. */
export interface EngineCache {
  get(version: string): Promise<CachedEngine | undefined>;
  put(version: string, engine: CachedEngine): Promise<void>;
  has(version: string): Promise<boolean>;
}

/** The structural port an engine speaks LSP over (see `@telorun/editor-protocol`). */
export interface EnginePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface SpawnedEngine {
  port: EnginePort;
  /** Called once, with the reason, when the engine fails: its code threw while
   *  evaluating, it raised an uncaught error, a message from it could not be
   *  read, or it exited without being asked to. A listener added after the
   *  failure is called at once. `terminate()` is not a failure. */
  onFailure(listener: (reason: string) => void): void;
  terminate(): void;
}

/** Host-supplied: run engine code (a self-contained ES module calling
 *  `serve(port)` on its worker scope) and hand back the worker's port.
 *  `version` names a downloaded engine; it is absent for the bundled one, whose
 *  identity is known only once it answers `initialize`. */
export interface EngineSpawner {
  spawn(engine: { version?: string; bytes: Uint8Array }): SpawnedEngine;
}

/** What a path in the workspace is, without reading it (links followed). */
export type FileKind = "file" | "directory";

/**
 * Host-supplied raw access to the workspace, by `file:` URI. Every rule on top
 * of it — a directory reading as its `telo.yaml`, what is `null` and what is an
 * error, how a relative path resolves — is the router's, written once for every
 * host. `stat` follows links and answers `undefined` for a path naming nothing;
 * `readDirectory` reports each entry's kind WITHOUT following links (a link is
 * `symlink`); any other failure rejects with its reason.
 */
export interface HostFileSystem {
  stat(uri: string): Promise<FileKind | undefined>;
  readText(uri: string): Promise<string>;
  readDirectory(uri: string): Promise<DirectoryEntry[]>;
}

/** Host-supplied reader for every non-`file:` `telo/read` — the host owns the
 *  transports (`oci://`, `https://`, a manifest cache) and their integrity
 *  checks. A failure rejects with its reason. */
export type RemoteReader = (uri: string) => Promise<ReadResult>;

/** The telo version an owner module last resolved to under Auto, with the
 *  documents its last `telo/requirements` listed. */
export interface StoredResolution {
  version: string;
  documents: string[];
}

export interface StoredResolutions {
  owners: Record<string, StoredResolution>;
}

/** Host-supplied storage of Auto resolutions, one per workspace, so a module
 *  reopens on the engine it last resolved to. */
export interface ResolutionStore {
  read(): Promise<StoredResolutions | undefined>;
  write(resolutions: StoredResolutions): Promise<void>;
}

/** Answers to every `telo/*` request, as the router builds them. */
export type HostServices = {
  [M in keyof TeloHostRequests]: (params: TeloHostRequests[M][0]) => Promise<TeloHostRequests[M][1]>;
};

/** The engine the host ships. Its identity is what it reports in its
 *  handshake — never stamped by the host, so a label can never disagree with
 *  the code it names. */
export interface BundledEngine {
  load(): Promise<Uint8Array>;
}
