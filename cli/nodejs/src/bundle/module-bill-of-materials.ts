/**
 * A module's bill of materials (`kernel/specs/module-artifact.md` §7): the record
 * the payload builder writes into the `sbom` layer from what its producers
 * reported, and the two ways a reader gets one module's stored record — read
 * from a published artifact's `sbom` layer, or derived for a module on disk by
 * the builders `telo publish` runs.
 */

import {
  BILL_OF_MATERIALS_FILE,
  componentRef,
  layerDigestKey,
  layerOccurrence,
  npmPackageUrl,
  readBillOfMaterials,
  serializeModuleRecord,
  singletonLayer,
  type ArtifactLayer,
  type BillOfMaterials,
  type ComponentReport,
  type ContainsEdge,
  type ModuleFileClaim,
  type ModuleSource,
  type NativeEntry,
  type RecordSubject,
} from "@telorun/analyzer";
import {
  attributeBundleInputs,
  defaultTransportRegistry,
  isPayloadLink,
  materializeStoredLayer,
  type LayerFetcher,
} from "@telorun/kernel";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BuiltLayer } from "./built-layers.js";
import type { Partition } from "./partition-layers.js";

/** A bundle input no package claims, under the key of the layer it ships in. */
export interface UnattributedInput {
  /** The layer's key, as the release ledger writes it (`controller/js`). */
  readonly layer: string;
  /** The input, relative to the artifact root, `/`-separated (`../shared.ts`). */
  readonly input: string;
}

/** One module's stored record, with what a summary names beside it. */
export interface ModuleBillOfMaterials {
  /** The record's canonical bytes — `sbom.cdx.json`. */
  readonly text: string;
  readonly record: BillOfMaterials;
  /** Bundle inputs no package claims; each makes its layer incomplete. */
  readonly unattributed: readonly UnattributedInput[];
  /** Real, absolute paths of the `package.json` files whose version the record
   *  holds: inputs of the payload, so a release that moves one moves it. */
  readonly versionInputs: readonly string[];
}

/** One built bundle: the payload file it produced and the inputs that put
 *  bytes into it. */
export interface BundleProduct {
  readonly path: string;
  readonly contributors: readonly string[];
}

/**
 * Refuse an author's file at the record's path. The record is the `sbom`
 * layer's one file, so a file of the module's own named the same would be read
 * as the record by anything that looked for it beside the manifest.
 */
export function assertRecordPathFree(declared: Iterable<string>): void {
  for (const file of declared) {
    if (file !== BILL_OF_MATERIALS_FILE) continue;
    throw new Error(
      `./${BILL_OF_MATERIALS_FILE} is the path the module's bill of materials is written to. ` +
        `Rename the file or leave it out of \`files:\`.`,
    );
  }
}

/** What the record is about, read off the authored module document. */
export function recordSubjectOf(moduleDoc: unknown): RecordSubject {
  const doc = (moduleDoc ?? {}) as { kind?: unknown; metadata?: Record<string, unknown> };
  const metadata = doc.metadata ?? {};
  const name = typeof metadata.name === "string" ? metadata.name : "";
  return {
    type: doc.kind === "Telo.Application" ? "application" : "library",
    name,
    ...(typeof metadata.version === "string" ? { version: metadata.version } : {}),
    ...(typeof metadata.license === "string" ? { license: metadata.license } : {}),
  };
}

/**
 * The stored record of one module's payload, from its producers' reports.
 *
 * - **Bundles**: every input contributing bytes is attributed to its package
 *   (`attributeBundleInputs`); one no package claims makes the layer incomplete.
 * - **Staging**: each source with a `purl` reports itself, and each `contains`
 *   entry beneath it, in every layer one of its entries lands in (a notice of
 *   its own is the module's file, not an occurrence), each with its `cpe` and
 *   its `vcs` (written as the purl's `vcs_url` qualifier).
 * - **Incomplete**: a `native:` file or a controller / library entry no build
 *   produced and no source with a `purl` stages, and a staged entry of a source
 *   without one.
 */
export async function assembleModuleRecord(options: {
  readonly subject: RecordSubject;
  readonly partition: Partition;
  readonly claims: readonly ModuleFileClaim[];
  readonly native: readonly NativeEntry[];
  readonly sources: readonly ModuleSource[];
  readonly bundles: readonly BundleProduct[];
  /** The artifact root's directory: an input inside it is the module's own code. */
  readonly publishRoot: string;
}): Promise<ModuleBillOfMaterials> {
  const { partition } = options;
  const layersOf = new Map<string, Array<{ occurrence: string; key: string }>>();
  for (const layer of partition.layers) {
    const occurrence = layerOccurrence(layer.role, layer.selector);
    const key = layerDigestKey(layer.role, layer.selector);
    for (const file of layer.files) {
      const entry = layersOf.get(file) ?? [];
      entry.push({ occurrence, key });
      layersOf.set(file, entry);
    }
  }
  const occurrencesOf = (file: string) => layersOf.get(file) ?? [];

  const components: ComponentReport[] = [];
  const contains: ContainsEdge[] = [];
  const incomplete = new Set<string>();
  const unattributed: UnattributedInput[] = [];
  const versionInputs = new Set<string>();

  const built = new Set<string>();
  // Inputs arrive by real path; a root under a symlink (macOS /var) must be read the same way.
  const realRoot = options.bundles.length > 0 ? await fs.realpath(options.publishRoot) : options.publishRoot;
  for (const bundle of options.bundles) {
    built.add(bundle.path);
    const attribution = await attributeBundleInputs(bundle.contributors, options.publishRoot);
    for (const layer of occurrencesOf(bundle.path)) {
      for (const pkg of attribution.packages) {
        versionInputs.add(pkg.manifest);
        components.push({
          purl: npmPackageUrl(pkg.name),
          version: pkg.version,
          occurrence: layer.occurrence,
          ...(pkg.license ? { license: pkg.license } : {}),
        });
      }
      for (const input of attribution.unattributed) {
        incomplete.add(layer.occurrence);
        unattributed.push({
          layer: layer.key,
          input: path.relative(realRoot, await fs.realpath(input)).split(path.sep).join("/"),
        });
      }
    }
  }

  const stagedByPurl = new Set<string>();
  for (const source of options.sources) {
    const notices = new Set(source.notices);
    for (const entry of source.entries) {
      if (notices.has(entry.path)) continue;
      for (const layer of occurrencesOf(entry.path)) {
        if (!source.purl) {
          incomplete.add(layer.occurrence);
          continue;
        }
        stagedByPurl.add(entry.path);
        components.push({
          purl: source.purl,
          version: source.version,
          occurrence: layer.occurrence,
          ...(source.cpe ? { cpe: source.cpe } : {}),
          ...(source.vcs ? { vcs: source.vcs } : {}),
        });
        for (const contained of source.contains) {
          components.push({
            purl: contained.purl,
            version: contained.version,
            occurrence: layer.occurrence,
            ...(contained.cpe ? { cpe: contained.cpe } : {}),
            ...(contained.vcs ? { vcs: contained.vcs } : {}),
          });
          contains.push({
            from: componentRef(source.purl, source.version, source.vcs),
            to: componentRef(contained.purl, contained.version, contained.vcs),
          });
        }
      }
    }
  }

  const compiled = [
    ...options.native.map((entry) => entry.path),
    ...options.claims
      .filter((claim) => claim.role === "controller" || claim.role === "library")
      .map((claim) => claim.path),
  ];
  for (const file of compiled) {
    if (built.has(file) || stagedByPurl.has(file)) continue;
    for (const layer of occurrencesOf(file)) incomplete.add(layer.occurrence);
  }

  const text = serializeModuleRecord({
    subject: options.subject,
    components,
    contains,
    incomplete: [...incomplete],
  });
  const seen = new Set<string>();
  return {
    text,
    record: readBillOfMaterials(text),
    unattributed: unattributed
      .filter((entry) => {
        const id = `${entry.layer}\0${entry.input}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => (a.layer === b.layer ? (a.input < b.input ? -1 : 1) : a.layer < b.layer ? -1 : 1)),
    versionInputs: [...versionInputs].sort(),
  };
}

/** The `sbom` layer holding a record. */
export function billOfMaterialsLayer(text: string): BuiltLayer {
  return {
    role: "sbom",
    files: [{ name: BILL_OF_MATERIALS_FILE, content: new TextEncoder().encode(text) }],
  };
}

/** One line per unattributed input, for a summary beside the partition. */
export function describeUnattributed(entries: readonly UnattributedInput[]): string[] {
  return entries.map(
    (entry) =>
      `${entry.layer}: '${entry.input}' belongs to no package with a name and version, so the ` +
      `bill of materials marks the layer incomplete`,
  );
}

/**
 * One module's stored record, read from its artifact's `sbom` layer through the
 * layer store (`<cacheRoot>/layers/sha256-<hex>/`): the stored copy when its
 * integrity re-derives, else the layer alone fetched from the registry by
 * `blob` — exactly one payload blob. `undefined` when the artifact's index
 * lists no `sbom` layer (published before the record existed).
 */
export async function readArtifactBillOfMaterials(options: {
  /** The artifact's ref as its importer pinned it. */
  readonly pinnedRef: string;
  /** The artifact's `layers:` index, read off its pinned `telo.yaml`. */
  readonly layers: readonly ArtifactLayer[];
  readonly cacheRoot: string;
  /** A store that is read and never written, consulted before `cacheRoot`. */
  readonly sealedRoot?: string;
  readonly transports?: LayerFetcher;
}): Promise<{ text: string; record: BillOfMaterials } | undefined> {
  const layer = singletonLayer(options.layers, "sbom");
  if (!layer) return undefined;
  const { files } = await materializeStoredLayer({
    cacheRoot: options.cacheRoot,
    pinnedRef: options.pinnedRef,
    layer,
    transports: options.transports ?? defaultTransportRegistry(),
    sealedRoot: options.sealedRoot,
  });
  const file = files.find((entry) => entry.name === BILL_OF_MATERIALS_FILE);
  if (!file || isPayloadLink(file) || files.length !== 1) {
    throw new Error(
      `The sbom layer of ${options.pinnedRef} must hold exactly one file, ${BILL_OF_MATERIALS_FILE}; ` +
        `it holds ${files.map((entry) => `'${entry.name}'`).join(", ") || "nothing"}.`,
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  return { text, record: readBillOfMaterials(text, `the sbom layer of ${options.pinnedRef}`) };
}
