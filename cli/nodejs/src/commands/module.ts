import { splitIntegrity } from "@telorun/analyzer";
import { defaultTransportRegistry, type TransportRegistry } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { type Document, parseAllDocuments } from "yaml";
import type { Argv } from "yargs";
import { createLogger, type Logger } from "../logger.js";
import { findModuleDoc } from "./manifest-imports.js";

const DEFAULT_REGISTRY_URL = "https://registry.telo.run";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function resolveRegistryUrl(explicit?: string): string {
  return explicit ?? process.env.TELO_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

/** Normalize a ref for version enumeration. The version segment is irrelevant to
 *  `listVersions` (only the `<ns>/<name>` path or OCI repo is used), but the
 *  registry transport only owns refs that carry an `@version` — so a bare
 *  `std/console` gets a placeholder version, mirroring `telo upgrade`. Scheme
 *  refs (`oci://`) and already-versioned refs pass through. */
function refForEnumeration(ref: string): string {
  const base = splitIntegrity(ref).base;
  if (base.includes("://") || base.includes("@")) return base;
  return `${base}@0.0.0`;
}

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
    // error rather than "no transport". A bare `ns/name` that isn't on disk is
    // a registry ref — leave it to the transport.
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
    console.error(
      `${log.error("error")}  cannot read ${path.relative(process.cwd(), filePath)}: ${errMsg(err)}`,
    );
    process.exit(1);
  }
}

function versionOrExit(text: string, label: string, log: Logger): string {
  const version = declaredVersion(text);
  if (!version) {
    console.error(`${log.error("error")}  ${label} declares no metadata.version`);
    process.exit(1);
  }
  return version;
}

function emitVersions(versions: string[], json: boolean, log: Logger): void {
  if (json) {
    console.log(JSON.stringify(versions));
    return;
  }
  if (versions.length === 0) {
    console.error(log.dim("no published versions"));
    return;
  }
  for (const v of versions) console.log(v);
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
    console.error(
      `${log.error("error")}  cannot resolve '${ref}' — registry refs need a version (e.g. '${base}@<version>')`,
    );
    process.exit(1);
  }
  try {
    return (await transport.source.read(ref)).text;
  } catch (err) {
    console.error(`${log.error("error")}  ${errMsg(err)}`);
    process.exit(1);
  }
}

async function runVersions(argv: {
  ref: string;
  registryUrl?: string;
  json: boolean;
}): Promise<void> {
  const log = createLogger(false);

  // 1. Local module — one version, the one it declares on disk.
  const localPath = localManifestPath(argv.ref);
  if (localPath) {
    const text = readFileOrExit(localPath, log);
    emitVersions([versionOrExit(text, path.relative(process.cwd(), localPath), log)], argv.json, log);
    return;
  }

  const registry = defaultTransportRegistry(resolveRegistryUrl(argv.registryUrl));
  const base = splitIntegrity(argv.ref).base;

  // 2. Direct URL — a single manifest at a fixed location, no version list.
  if (base.startsWith("http://") || base.startsWith("https://")) {
    const text = await readRemoteManifest(registry, argv.ref, log);
    emitVersions([versionOrExit(text, argv.ref, log)], argv.json, log);
    return;
  }

  // 3. Enumerable — a registry `ns/name` or `oci://host/repo` ref.
  const enumRef = refForEnumeration(argv.ref);
  if (!registry.forRef(enumRef)) {
    console.error(`${log.error("error")}  no transport handles '${argv.ref}'`);
    process.exit(1);
  }
  let versions: string[] | null;
  try {
    versions = await registry.listVersions(enumRef);
  } catch (err) {
    console.error(`${log.error("error")}  ${errMsg(err)}`);
    process.exit(1);
  }
  if (versions === null) {
    console.error(`${log.error("error")}  module not found: ${argv.ref}`);
    process.exit(1);
  }
  emitVersions(sortVersionsDesc(versions), argv.json, log);
}

/** Resolve `ref` to a single manifest's text — local file, direct URL, or any
 *  transport-owned ref — shared by `manifest` / `resources` / `kinds`. */
async function loadManifestText(
  ref: string,
  registryUrl: string | undefined,
  log: Logger,
): Promise<string> {
  const localPath = localManifestPath(ref);
  return localPath
    ? readFileOrExit(localPath, log)
    : readRemoteManifest(defaultTransportRegistry(resolveRegistryUrl(registryUrl)), ref, log);
}

function parseDocs(text: string): Document[] {
  return parseAllDocuments(text, { customTags: defaultCustomTags() }) as Document[];
}

async function runManifest(argv: { ref: string; registryUrl?: string }): Promise<void> {
  const log = createLogger(false);
  const text = await loadManifestText(argv.ref, argv.registryUrl, log);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
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

/** The resource kinds a module defines: each `Telo.Definition` / `Telo.Abstract`
 *  as its suffix, owning module, capability, export status, and description. A
 *  plain inspector — how a downstream consumer (e.g. the discovery hub) composes
 *  these facts into an embedding passage is that consumer's own concern. */
function extractKinds(docs: Document[]): KindEntry[] {
  const moduleDoc = findModuleDoc(docs);
  const moduleName = moduleDoc?.getIn(["metadata", "name"]);
  const prefix = typeof moduleName === "string" ? moduleName : "";

  const rawExports = moduleDoc?.getIn(["exports", "kinds"]);
  const exportList: unknown[] = Array.isArray(rawExports)
    ? rawExports
    : rawExports && typeof (rawExports as { toJSON?: unknown }).toJSON === "function"
      ? (rawExports as { toJSON: () => unknown[] }).toJSON()
      : [];
  const exported = new Set(exportList.filter((v): v is string => typeof v === "string"));

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

async function runResources(argv: {
  ref: string;
  registryUrl?: string;
  json: boolean;
}): Promise<void> {
  const log = createLogger(false);
  const resources = extractResources(parseDocs(await loadManifestText(argv.ref, argv.registryUrl, log)));
  if (argv.json) {
    console.log(JSON.stringify(resources));
    return;
  }
  if (resources.length === 0) {
    console.error(log.dim("no resources declared"));
    return;
  }
  for (const r of resources) console.log(`${r.kind}${r.name ? `  ${log.dim(r.name)}` : ""}`);
}

async function runKinds(argv: {
  ref: string;
  registryUrl?: string;
  json: boolean;
}): Promise<void> {
  const log = createLogger(false);
  const kinds = extractKinds(parseDocs(await loadManifestText(argv.ref, argv.registryUrl, log)));
  if (argv.json) {
    console.log(JSON.stringify(kinds));
    return;
  }
  if (kinds.length === 0) {
    console.error(log.dim("no kinds defined"));
    return;
  }
  // The prefix in a `kind:` field is the consumer's import alias, not the module
  // name — surface a concrete usage hint so the bare suffixes below aren't misread.
  const alias = pascalCase(kinds[0].module) || "Alias";
  console.error(log.dim(`import as e.g. ${alias}: ${argv.ref} — then write ${alias}.<Kind>`));
  for (const k of kinds) {
    const cap = k.abstract ? "abstract" : k.capability;
    const badge = k.exported ? log.ok(" (exported)") : "";
    console.log(`${k.name}  ${log.dim(cap)}${badge}`);
    if (k.description) console.log(`    ${log.dim(k.description.split("\n")[0])}`);
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
                describe: "Module ref: ./path, std/console, oci://host/repo, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("registry-url", {
                type: "string",
                describe: "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "Emit the versions as a JSON array",
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
                  "Module ref: ./path, std/console@0.9.0, oci://host/repo@1.2.0, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("registry-url", {
                type: "string",
                describe: "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
              }),
          async (argv) => {
            await runManifest(argv as any);
          },
        )
        .command(
          "resources <ref>",
          "List the resource instances declared in a module's manifest",
          (yy) =>
            yy
              .positional("ref", {
                describe:
                  "Module ref: ./path, std/console@0.9.0, oci://host/repo@1.2.0, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("registry-url", {
                type: "string",
                describe: "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
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
                describe:
                  "Module ref: ./path, std/console@0.9.0, oci://host/repo@1.2.0, or an https URL",
                type: "string",
                demandOption: true,
              })
              .option("registry-url", {
                type: "string",
                describe: "Base URL for the telo module registry. Overrides TELO_REGISTRY_URL.",
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
        .demandCommand(1, "Specify a module subcommand (versions | manifest | resources | kinds)"),
    () => {},
  );
}
