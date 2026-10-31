import {
  isBuiltinVocabularyRoot,
  isHttpsModuleRef,
  isOciRef,
  kindDeclarationOf,
  OCI_SCHEME,
  manifestCacheKey,
  ociManifestCacheCoords,
  readApplicationContract,
  readNativeEntries,
  type ApplicationContract,
  type ContractRequirements,
  sha256Base64Url,
  splitIntegrity,
  urlManifestCacheCoords,
} from "@telorun/analyzer";
import { defaultTransportRegistry, type TransportRegistry } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { type Document, parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import {
  type KindRuntimeEntry,
  kindRuntimeSupport,
  type ModuleRuntimeReport,
  moduleRuntimeReport,
  nativeReach,
} from "../controller-runtime.js";
import { loadAnalyzedGraph, printRefusals } from "../analyzed-graph.js";
import { createLogger, type Logger } from "../logger.js";
import { outErrLine, outLine, output } from "../output.js";
import { fetchManifestHash } from "../manifest-hash.js";
import { findModuleDoc } from "./manifest-imports.js";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Newest-first: valid SemVer sorted by precedence, then any non-SemVer tags
 *  (digests, `latest`, …) appended in lexical order so output stays stable. */
function sortVersionsDesc(versions: string[]): string[] {
  const valid: string[] = [];
  const other: string[] = [];
  for (const v of versions) (semver.valid(v) ? valid : other).push(v);
  valid.sort(semver.rcompare);
  other.sort();
  return [...valid, ...other];
}

/** If `ref` addresses a module on the local filesystem — path-like (`.`/`/`) or
 *  resolving to an existing file/dir — return the `telo.yaml` path to read;
 *  otherwise `null` (the ref is remote, dispatch through a transport). A
 *  directory resolves to `<dir>/telo.yaml`, mirroring `telo run` / `check`. */
function localManifestPath(ref: string): string | null {
  const base = splitIntegrity(ref).base;
  if (base.includes("://")) return null;
  const pathLike = base.startsWith(".") || base.startsWith("/");
  const resolved = path.resolve(process.cwd(), base);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    // Path-like but missing: still treat as local so we report a clear read
    // error rather than "no transport". Anything else is remote — leave it to
    // the transport that owns its scheme.
    return pathLike ? resolved : null;
  }
  return stat.isDirectory() ? path.join(resolved, "telo.yaml") : resolved;
}

/** The `metadata.version` declared by the module doc in `text`, or `null` when
 *  no `Telo.Application` / `Telo.Library` doc carries one. */
function declaredVersion(text: string): string | null {
  const docs = parseAllDocuments(text, { customTags: defaultCustomTags() }) as Document[];
  const version = findModuleDoc(docs)?.getIn(["metadata", "version"]);
  return typeof version === "string" ? version : null;
}

function readFileOrExit(filePath: string, log: Logger): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    outErrLine(
      `${log.err.error("error")}  cannot read ${path.relative(process.cwd(), filePath)}: ${errMsg(err)}`,
    );
    process.exit(1);
  }
}

function versionOrExit(text: string, label: string, log: Logger): string {
  const version = declaredVersion(text);
  if (!version) {
    outErrLine(`${log.err.error("error")}  ${label} declares no metadata.version`);
    process.exit(1);
  }
  return version;
}

function emitVersions(versions: string[], json: boolean, log: Logger): void {
  if (json || output().isJson) {
    // Bare array, not an envelope: this is the shape the hub's tracker already
    // parses out of `telo module versions --json`.
    output().document(versions);
    return;
  }
  if (versions.length === 0) {
    outErrLine(log.err.dim("no published versions"));
    return;
  }
  for (const v of versions) outLine(v);
}

/** A version with its digest, or with why its digest could not be read. */
export type VersionDigest = { version: string; digest: string } | { version: string; error: string };

function emitVersionDigests(
  ref: string,
  entries: VersionDigest[],
  json: boolean,
  log: Logger,
): void {
  for (const e of entries) {
    if ("error" in e) outErrLine(`${log.err.error("error")}  no digest for ${ref} ${e.version}: ${e.error}`);
  }
  if (json || output().isJson) {
    output().document(entries);
    return;
  }
  if (entries.length === 0) {
    outErrLine(log.err.dim("no published versions"));
    return;
  }
  for (const e of entries) if ("digest" in e) outLine(`${e.version}  ${log.dim(e.digest)}`);
}

/** Digest requests in flight at once for one module's versions. */
const VERSION_DIGEST_CONCURRENCY = 8;

/** Each version's change-detection digest, in the order given, read with
 *  bounded concurrency. A version whose digest cannot be read carries the
 *  reason in place of a digest, so one unreadable tag does not hide the rest. */
export async function readVersionDigests(
  versions: string[],
  digestOf: (version: string) => Promise<string | null>,
): Promise<VersionDigest[]> {
  const entries: VersionDigest[] = new Array(versions.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < versions.length) {
      const index = next++;
      const version = versions[index];
      try {
        const digest = await digestOf(version);
        entries[index] =
          digest === null ? { version, error: "version not found" } : { version, digest };
      } catch (err) {
        entries[index] = { version, error: errMsg(err) };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VERSION_DIGEST_CONCURRENCY, versions.length) }, worker),
  );
  return entries;
}

async function digestOrExit(registry: TransportRegistry, ref: string, log: Logger): Promise<string> {
  let digest: string | null;
  try {
    digest = await registry.digest(ref);
  } catch (err) {
    outErrLine(`${log.err.error("error")}  ${errMsg(err)}`);
    process.exit(1);
  }
  if (digest === null) {
    outErrLine(`${log.err.error("error")}  module not found: ${ref}`);
    process.exit(1);
  }
  return digest;
}

/** The change-detection digest of a module on the local filesystem — the same
 *  form the HTTP transport's digest takes, so a local and a published copy
 *  compare equal. */
async function localDigest(text: string): Promise<string> {
  return `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;
}

/** Read a single remote manifest (a direct URL, or any transport-owned ref) and
 *  return its verified bytes. `source.read` checks the inline `#sha256-...` hash
 *  when the ref is pinned — a mismatch throws, never a silent fallback. */
async function readRemoteManifest(
  registry: TransportRegistry,
  ref: string,
  log: Logger,
): Promise<string> {
  const transport = registry.forRef(ref);
  if (!transport) {
    const base = splitIntegrity(ref).base;
    outErrLine(
      `${log.err.error("error")}  cannot resolve '${ref}' — an oci:// ref needs a version (e.g. '${base}@<version>')`,
    );
    process.exit(1);
  }
  try {
    return (await transport.source.read(ref)).text;
  } catch (err) {
    outErrLine(`${log.err.error("error")}  ${errMsg(err)}`);
    process.exit(1);
  }
}

/** With `--digests`, each version is reported with the digest `telo module
 *  digest` would print for it, read in this one process — the discovery
 *  tracker's reconcile pass reads every version of every module, and a process
 *  per version is most of its cost. */
async function runVersions(argv: { ref: string; json: boolean; digests: boolean }): Promise<void> {
  const log = createLogger(false);

  // 1. Local module — one version, the one it declares on disk.
  const localPath = localManifestPath(argv.ref);
  if (localPath) {
    const text = readFileOrExit(localPath, log);
    const version = versionOrExit(text, path.relative(process.cwd(), localPath), log);
    if (argv.digests) {
      emitVersionDigests(argv.ref, [{ version, digest: await localDigest(text) }], argv.json, log);
    } else {
      emitVersions([version], argv.json, log);
    }
    return;
  }

  const registry = defaultTransportRegistry();
  const base = splitIntegrity(argv.ref).base;

  // 2. Direct URL — a single manifest at a fixed location, no version list.
  if (base.startsWith("http://") || base.startsWith("https://")) {
    const text = await readRemoteManifest(registry, argv.ref, log);
    const version = versionOrExit(text, argv.ref, log);
    if (argv.digests) {
      const digest = await digestOrExit(registry, argv.ref, log);
      emitVersionDigests(argv.ref, [{ version, digest }], argv.json, log);
    } else {
      emitVersions([version], argv.json, log);
    }
    return;
  }

  // 3. Enumerable — an `oci://host/repo` ref.
  const enumRef = base;
  if (!registry.forRef(enumRef)) {
    outErrLine(`${log.err.error("error")}  no transport handles '${argv.ref}'`);
    process.exit(1);
  }
  let versions: string[] | null;
  try {
    versions = await registry.listVersions(enumRef);
  } catch (err) {
    outErrLine(`${log.err.error("error")}  ${errMsg(err)}`);
    process.exit(1);
  }
  if (versions === null) {
    outErrLine(`${log.err.error("error")}  module not found: ${argv.ref}`);
    process.exit(1);
  }
  const sorted = sortVersionsDesc(versions);
  if (!argv.digests) {
    emitVersions(sorted, argv.json, log);
    return;
  }
  const transport = registry.forRef(enumRef)!;
  const entries = await readVersionDigests(sorted, (version) =>
    registry.digest(transport.withVersion(enumRef, version)),
  );
  emitVersionDigests(enumRef, entries, argv.json, log);
}

/** Resolve `ref` to a single manifest's text — local file, direct URL, or any
 *  transport-owned ref — shared by `manifest` / `resources` / `kinds`, with the
 *  ref it was read at. */
async function loadManifestText(ref: string, log: Logger): Promise<{ ref: string; text: string }> {
  const localPath = localManifestPath(ref);
  if (localPath) return { ref, text: readFileOrExit(localPath, log) };
  const registry = defaultTransportRegistry();
  const resolved = await withNewestVersion(registry, ref, log);
  return { ref: resolved, text: await readRemoteManifest(registry, resolved, log) };
}

/** The repository of an `oci://` ref written with no version and no pin, or
 *  `null` for any other ref. */
export function versionlessOciRepository(ref: string): string | null {
  if (!isOciRef(ref)) return null;
  const { base, integrity } = splitIntegrity(ref);
  if (integrity !== undefined) return null;
  const repoAndRef = base.slice(OCI_SCHEME.length).split("/").slice(1).join("/");
  return repoAndRef.length === 0 || repoAndRef.includes("@") ? null : base;
}

/** The highest SemVer version a registry lists; a tag that is no version
 *  (`latest`, a digest) is never chosen. */
export function newestPublishedVersion(versions: readonly string[]): string | undefined {
  return sortVersionsDesc([...versions]).find((v) => semver.valid(v));
}

/** An `oci://` ref written with no version reads the newest published version,
 *  as the hub's own reads do — never a `latest` tag, which no telo module
 *  publishes, so asking for one only ever answered "not found". The ref read is
 *  said on stderr, since the version it names is one the caller did not write. */
async function withNewestVersion(
  registry: TransportRegistry,
  ref: string,
  log: Logger,
): Promise<string> {
  const base = versionlessOciRepository(ref);
  const transport = base === null ? undefined : registry.forRef(base);
  if (base === null || !transport) return ref;
  let versions: string[] | null;
  try {
    versions = await registry.listVersions(base);
  } catch (err) {
    outErrLine(`${log.err.error("error")}  ${errMsg(err)}`);
    process.exit(1);
  }
  const newest = versions === null ? undefined : newestPublishedVersion(versions);
  if (newest === undefined) {
    outErrLine(
      `${log.err.error("error")}  ${base} names no version, and the registry lists no published one to read — pass '${base}@<version>'`,
    );
    process.exit(1);
  }
  const resolved = transport.withVersion(base, newest);
  outErrLine(log.err.dim(`reading ${resolved}, the newest published version`));
  return resolved;
}

function parseDocs(text: string): Document[] {
  return parseAllDocuments(text, { customTags: defaultCustomTags() }) as Document[];
}

/** The hub manifest-cache key for a versioned remote ref, or `null` when the
 *  ref has no deterministic cache location (local path, digest ref). Uses the
 *  same analyzer helpers as the editor's read path, so the tracker's write key
 *  and the editor's fetch key never drift.
 *
 *  `text` is the resolved manifest: a direct `https://` ref carries no version
 *  in the ref itself (it addresses one file whose version lives inside it), so
 *  its key is built from the `metadata.version` the file declares. */
function cacheKeyForRef(ref: string, text: string): string | null {
  if (isOciRef(ref)) {
    const coords = ociManifestCacheCoords(ref);
    return coords ? manifestCacheKey(coords) : null;
  }
  if (isHttpsModuleRef(ref)) {
    const version = declaredVersion(text);
    if (!version) return null;
    const coords = urlManifestCacheCoords(ref, version);
    return coords ? manifestCacheKey(coords) : null;
  }
  return null;
}

/** The import-pin hash for a remote ref (`sha256-<base64url>`), or `null` with
 *  the reason on stderr when it cannot be produced.
 *
 *  Delegates to `fetchManifestHash` so the transport stays the single authority
 *  on what gets hashed — HTTP hashes raw response bytes, OCI the UTF-8 text
 *  extracted from the tar layer, and only the transport knows which a pin
 *  written at this ref will be checked against.
 *
 *  Best-effort, but never silent: the manifest itself resolved, so failing the
 *  whole command over a pin would break every caller that wants the text. The
 *  reason goes to stderr — `--json` writes the document on stdout, so a warning
 *  cannot ride along inside it, and "no transport owns this ref", an auth
 *  rejection and a transient network failure are three different problems that
 *  must not collapse into an unexplained `null`. */
async function integrityForRef(ref: string, log: Logger): Promise<string | null> {
  try {
    return await fetchManifestHash(ref);
  } catch (err) {
    outErrLine(`${log.err.warn("warn")}  no integrity hash for '${ref}': ${errMsg(err)}`);
    return null;
  }
}

/** What `telo module manifest --json` prints. The hub's tracker reads the first
 *  five: `manifest` is cached to the bucket at `cacheKey`, `integrity` becomes
 *  the import pin it serves per version, and `runtime` is stored as the runtime
 *  and language facets without the consumer parsing a single PURL.
 *  `application` is an Application's declared inputs, so a surface offering to
 *  run it learns them from the manifest. */
export interface ManifestJsonPayload {
  ref: string;
  /** Deterministic hub cache key, or `null` for a ref with no cache location. */
  cacheKey: string | null;
  manifest: string;
  /** `sha256-<base64url>`, or `null` when nothing could hash the ref. */
  integrity: string | null;
  /** Which kernels can host each kind, and the module-level roll-up. `null`
   *  for the built-in vocabulary (`Telo.Builtins`), whose kinds the runtime
   *  itself implements — an absent PURL would otherwise read as portable. */
  runtime: ModuleRuntimeReport | null;
  /** The declared `variables` / `secrets` / `ports` of a `Telo.Application`,
   *  each with the configurations requiring it, and the dimensions those are
   *  keyed by; `null` for a library. No secret's value is ever carried. */
  application: ApplicationContract | null;
}

/**
 * An Application's requirements, from its whole graph loaded and analysed as
 * `telo describe` does — so the two report one requiredness. Undefined when the
 * graph does not load or the analysis refuses it: its refusals are printed on
 * stderr and `process.exitCode` is set, so the command prints no payload.
 */
export async function analysedRequirements(ref: string, log: Logger): Promise<ContractRequirements | undefined> {
  const analyzed = await loadAnalyzedGraph(ref, log);
  if (!analyzed) return undefined;
  if (analyzed.errors.length > 0) {
    printRefusals(analyzed, analyzed.errors, log, "application", "manifest payload");
    return undefined;
  }
  const requirements = analyzed.registry.analysisOf(analyzed.manifests).applicationRequirements;
  if (!requirements) throw new Error(`'${ref}' was analysed as an application and has no requirements.`);
  return requirements;
}

/** Build the `--json` payload for an already-resolved manifest — undefined
 *  when the manifest is an Application whose analysis refused it, which
 *  `requirementsOf` has reported (an Application's contract is a verdict over
 *  its whole graph; a library's and the built-in vocabulary's read nothing
 *  beyond the text).
 *
 *  Separate from `runManifest` so the shape can be asserted without a process:
 *  the hub e2e cannot cover it — that container tracks with the `telo` its base
 *  image ships, so a field added here is invisible there until a release lands —
 *  which leaves this the only place the contract the tracker depends on is
 *  checked. */
export async function buildManifestJsonPayload(
  ref: string,
  text: string,
  log: Logger,
  requirementsOf: () => Promise<ContractRequirements | undefined>,
): Promise<ManifestJsonPayload | undefined> {
  // A local module has neither: no cache location, and no transport whose
  // verification a pin would be checked against.
  const local = localManifestPath(ref) !== null;
  const docs = parseDocs(text);
  const builtins = isBuiltinVocabularyRoot(docs[0]?.toJSON());
  const moduleDoc = findModuleDoc(docs)?.toJSON() as { kind?: unknown } | undefined;
  let application: ApplicationContract | null = null;
  if (!builtins && moduleDoc?.kind === "Telo.Application") {
    const requirements = await requirementsOf();
    if (!requirements) return undefined;
    application = readApplicationContract(moduleDoc, requirements);
  }
  return {
    ref,
    cacheKey: local ? null : cacheKeyForRef(ref, text),
    manifest: text,
    integrity: local ? null : await integrityForRef(ref, log),
    runtime: builtins ? null : extractKindRuntimes(docs, log),
    application,
  };
}

async function runManifest(argv: { ref: string; json: boolean }): Promise<void> {
  const log = createLogger(false);
  const { ref, text } = await loadManifestText(argv.ref, log);
  if (argv.json || output().isJson) {
    // The hub's tracker parses this document; it is the payload, not a log
    // line, so it bypasses `outLine` (a no-op under `-o json`).
    const payload = await buildManifestJsonPayload(ref, text, log, () => analysedRequirements(ref, log));
    if (payload) output().document(payload);
    return;
  }
  output().raw(text.endsWith("\n") ? text : `${text}\n`);
}

/** Cheap content-identity digest of one published version — what the discovery
 *  tracker records per version and re-checks on every track to detect a
 *  re-pushed tag. Opaque and transport-specific: compare for equality only.
 *
 *  NOT the `#sha256-<base64url>` an `imports:` entry pins with, and the two are
 *  not inter-convertible: for an `oci://` ref this is the registry's own digest
 *  over the OCI manifest (`sha256:<hex>`), while a pin hashes `telo.yaml`. Only
 *  the local-path branch below happens to emit the pin form, which makes the
 *  command look like a pin source from one direction and not the other. `telo
 *  upgrade` is what writes a pin; the help line says so, because a value that
 *  looks like the one you want is worse than no value at all. */
async function runDigest(argv: { ref: string; json: boolean }): Promise<void> {
  const log = createLogger(false);

  const emit = (digest: string): void => {
    if (argv.json || output().isJson) {
      output().document({ ref: argv.ref, digest });
      return;
    }
    outLine(digest);
  };

  const localPath = localManifestPath(argv.ref);
  if (localPath) {
    emit(await localDigest(readFileOrExit(localPath, log)));
    return;
  }

  const registry = defaultTransportRegistry();
  if (!registry.forRef(argv.ref)) {
    outErrLine(`${log.err.error("error")}  no transport handles '${argv.ref}'`);
    process.exit(1);
  }
  emit(await digestOrExit(registry, argv.ref, log));
}

interface ResourceEntry {
  kind: string;
  name: string;
}

/** Every declared resource instance: each non-module, non-definition doc. */
function extractResources(docs: Document[]): ResourceEntry[] {
  const out: ResourceEntry[] = [];
  for (const doc of docs) {
    const kind = doc.get("kind");
    // A resource instance is any doc that isn't a framework doc. Every framework
    // doc kind is namespaced under `Telo.` (Application, Library, Definition,
    // Abstract, Import, …), while an instance is `<ImportAlias>.<Kind>` — so this
    // stays correct as new `Telo.*` doc kinds land, with no list to maintain.
    if (typeof kind !== "string" || kind.startsWith("Telo.")) continue;
    const name = doc.getIn(["metadata", "name"]);
    out.push({ kind, name: typeof name === "string" ? name : "" });
  }
  return out;
}

interface KindEntry {
  /** The kind suffix (`metadata.name`, e.g. `Sequence`). The prefix in a `kind:`
   *  field is the consumer's own import alias, not this — so identity is (module,
   *  name), never a fixed dotted string. */
  name: string;
  module: string;
  capability: string;
  abstract: boolean;
  exported: boolean;
  description?: string;
}

/** PascalCase a kebab module name into a suggested import alias (`http-server` →
 *  `HttpServer`). Only a hint — the consumer picks any PascalCase alias. */
function pascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** Read a YAML node that should be a list of strings, tolerating both a plain
 *  array and a `yaml` collection node. */
function toStringArray(raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof (raw as { toJSON?: unknown }).toJSON === "function"
      ? (raw as { toJSON: () => unknown[] }).toJSON()
      : [];
  return list.filter((v): v is string => typeof v === "string");
}

/** Classify every kind the manifest declares by the kernels that can host it,
 *  derived from its controller candidates. Which documents declare a kind, and
 *  the declaration each yields, is the analyzer's one reader — a kind the
 *  runtime synthesizes from its document carries the candidate naming the
 *  kernel controller that serves it.
 *
 *  Lives with the verb rather than in the hub: the candidate-to-kernel mapping is
 *  loader knowledge, and a consumer re-deriving it would hold a second copy that
 *  drifts silently the day a loader lands. */
function extractKindRuntimes(docs: Document[], log: Logger): ModuleRuntimeReport {
  const entries: KindRuntimeEntry[] = [];
  for (const doc of docs) {
    const declaration = kindDeclarationOf(doc.toJSON() ?? undefined);
    const name = declaration?.metadata?.name;
    if (typeof name !== "string") continue;
    const controllers: unknown = declaration?.controllers;
    entries.push({
      name,
      ...kindRuntimeSupport(Array.isArray(controllers) ? controllers : []),
    });
  }
  // An entry that cannot be read covers no platform; saying so keeps the
  // reported reach from quietly narrowing.
  const native = readNativeEntries(findModuleDoc(docs)?.toJSON());
  for (const problem of native.problems) {
    outErrLine(`${log.err.warn("warn")}  native reach omits ${problem.message}`);
  }
  return moduleRuntimeReport(entries, nativeReach(native.entries));
}

/** The resource kinds a module defines: each `Telo.Definition` / `Telo.Abstract`
 *  as its suffix, owning module, capability, export status, and description. A
 *  plain inspector — how a downstream consumer (e.g. the discovery hub) composes
 *  these facts into an embedding passage is that consumer's own concern. */
function extractKinds(docs: Document[]): KindEntry[] {
  const moduleDoc = findModuleDoc(docs);
  const moduleName = moduleDoc?.getIn(["metadata", "name"]);
  const prefix = typeof moduleName === "string" ? moduleName : "";

  const exported = new Set(toStringArray(moduleDoc?.getIn(["exports", "kinds"])));

  const out: KindEntry[] = [];
  for (const doc of docs) {
    const kind = doc.get("kind");
    if (kind !== "Telo.Definition" && kind !== "Telo.Abstract") continue;
    const name = doc.getIn(["metadata", "name"]);
    if (typeof name !== "string") continue;
    const capability = doc.get("capability");
    const descRaw = doc.getIn(["metadata", "description"]);
    out.push({
      name,
      module: prefix,
      capability: typeof capability === "string" ? capability : "",
      abstract: kind === "Telo.Abstract",
      exported: exported.has(name),
      description: typeof descRaw === "string" ? descRaw.trim() : undefined,
    });
  }
  return out;
}

async function runResources(argv: { ref: string; json: boolean }): Promise<void> {
  const log = createLogger(false);
  const resources = extractResources(parseDocs((await loadManifestText(argv.ref, log)).text));
  if (argv.json || output().isJson) {
    output().document(resources);
    return;
  }
  if (resources.length === 0) {
    outErrLine(log.err.dim("no resources declared"));
    return;
  }
  for (const r of resources) outLine(`${r.kind}${r.name ? `  ${log.dim(r.name)}` : ""}`);
}

async function runKinds(argv: { ref: string; json: boolean }): Promise<void> {
  const log = createLogger(false);
  const kinds = extractKinds(parseDocs((await loadManifestText(argv.ref, log)).text));
  if (argv.json || output().isJson) {
    output().document(kinds);
    return;
  }
  if (kinds.length === 0) {
    outErrLine(log.err.dim("no kinds defined"));
    return;
  }
  // The prefix in a `kind:` field is the consumer's import alias, not the module
  // name — surface a concrete usage hint so the bare suffixes below aren't misread.
  const alias = pascalCase(kinds[0].module) || "Alias";
  outErrLine(log.err.dim(`import as e.g. ${alias}: ${argv.ref} — then write ${alias}.<Kind>`));
  for (const k of kinds) {
    const cap = k.abstract ? "abstract" : k.capability;
    const badge = k.exported ? log.ok(" (exported)") : "";
    outLine(`${k.name}  ${log.dim(cap)}${badge}`);
    if (k.description) outLine(`    ${log.dim(k.description.split("\n")[0])}`);
  }
}

export function moduleCommand(yargs: Argv): Argv {
  return yargs.command(
    "module <subcommand>",
    "Inspect modules across transports (local path, registry, OCI, direct URL)",
    (y) =>
      y
        .command(
          "versions <ref>",
          "List a module's versions, newest first (one entry for a local path or direct URL)",
          (yy) =>
            yy
              .positional("ref", {
                describe: "Module ref: ./path, oci://host/repo, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "Emit the versions as a JSON array",
              })
              .option("digests", {
                type: "boolean",
                default: false,
                describe:
                  "Report each version with its change-detection digest ('telo module digest'); --json emits [{ version, digest }], a version whose digest cannot be read as { version, error }",
              }),
          async (argv) => {
            await runVersions(argv as any);
          },
        )
        .command(
          "manifest <ref>",
          "Print a module's telo.yaml (verified against the inline hash when pinned)",
          (yy) =>
            yy
              .positional("ref", {
                describe:
                  "Module ref: ./path, oci://host/repo@1.2.0 (oci://host/repo reads the newest published version), or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe:
                  "Emit { ref, cacheKey, manifest, integrity, runtime, application } as JSON; `ref` is the version read and `integrity` the pin an imports: entry writes after it. An application's graph is loaded and analysed for `application` (each input's `required` / `requiredWhen`, and its `dimensions`); one the analysis refuses prints nothing and exits 1",
              }),
          async (argv) => {
            await runManifest(argv as any);
          },
        )
        .command(
          "digest <ref>",
          "Print a version's change-detection digest — NOT the '#sha256-' import pin (use 'telo upgrade' for that)",
          (yy) =>
            yy
              .positional("ref", {
                describe: "Module ref: ./path, oci://host/repo@1.2.0, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "Emit { ref, digest } as JSON",
              }),
          async (argv) => {
            await runDigest(argv as any);
          },
        )
        .command(
          "resources <ref>",
          "List the resource instances declared in a module's manifest",
          (yy) =>
            yy
              .positional("ref", {
                describe: "Module ref: ./path, oci://host/repo@1.2.0, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "Emit the resources as a JSON array",
              }),
          async (argv) => {
            await runResources(argv as any);
          },
        )
        .command(
          "kinds <ref>",
          "List the resource kinds a module defines (name, capability, exported)",
          (yy) =>
            yy
              .positional("ref", {
                describe: "Module ref: ./path, oci://host/repo@1.2.0, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "Emit the kinds as a JSON array",
              }),
          async (argv) => {
            await runKinds(argv as any);
          },
        )
        .demandCommand(
          1,
          "Specify a module subcommand (versions | manifest | digest | resources | kinds)",
        ),
    () => {},
  );
}
