/**
 * The `telo` ecosystem's evidence half: a module's layers, edges, destination
 * and read-back.
 *
 * - **Layers** — built through the shared `ModulePayloadBuilder`, so the number
 *   recorded here is the number `telo publish` computes against the registry;
 *   that equality is the whole point of the ledger.
 * - **Edges** — in-repo relative `imports:` (an import edge: publishing writes
 *   the sibling's version into the manifest) and the build's own metafile (an
 *   inline edge: which unit's source got inlined into the artifact).
 * - **Destination** — `<registry>/<directory name>`, the registry from the
 *   anchor's settings, `release.ecosystems.telo`, `--registry`,
 *   `TELO_OCI_REGISTRY`, then the base the module's ledger entry recorded.
 * - **Read-back** — the published layers index. The `manifest` digest is derived
 *   locally and is kept across a reconciliation, since no registry answers it.
 */

import {
  LOCALLY_DERIVED_LAYERS,
  MANIFEST_LAYER,
  TELO_ECOSYSTEM,
  layerDigestKey,
  stampSelfNpmPins,
  type LayerDigests,
} from "@telorun/analyzer";
import { PACKAGE_JSON, diffLayers, type UnitKey as ModuleKey } from "@telorun/release";
import { owningUnit, type EvidenceAdapter, type EvidenceSession, type ReadBack } from "@telorun/release/node";
import { computeFilesIntegrity } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import { readPublishedDigests } from "../bundle/payload-drift.js";
import { ModulePayloadBuilder, type ModulePayload } from "../bundle/module-payload.js";
import { readImportGraph, resolveTargets, type RegistryRungs } from "./targets.js";
import { discoverModules, type Workspace } from "./workspace.js";

export interface ModuleTarget {
  readonly registry: string;
  readonly destination: string;
}

/**
 * A built payload reduced to the per-layer digest map the ledger records.
 *
 * ONE function, because `apply` recording what it is about to publish and
 * `verify --write` re-recording what the registry serves must produce the same
 * map, or every module reports permanent phantom drift.
 */
export async function digestPayload(payload: ModulePayload): Promise<LayerDigests> {
  // The manifest is not one of `partitionLayers`' layers, but it is the layer
  // that changes when a dependency's version or pin moves.
  const layers: Record<string, string> = {
    [MANIFEST_LAYER]: await computeFilesIntegrity([
      { name: MANIFEST_LAYER, content: Buffer.from(payload.manifest, "utf8") },
    ]),
  };
  for (const layer of payload.layers) {
    layers[layerDigestKey(layer.role, layer.selector)] = await computeFilesIntegrity(layer.files);
  }
  // A library shipping inside the artifact moves the module with it.
  for (const nested of payload.nested) {
    layers[`${nested.path}:${MANIFEST_LAYER}`] = await computeFilesIntegrity([
      { name: MANIFEST_LAYER, content: Buffer.from(nested.manifest, "utf8") },
    ]);
    for (const layer of nested.layers) {
      layers[`${nested.path}:${layerDigestKey(layer.role, layer.selector)}`] = await computeFilesIntegrity(layer.files);
    }
  }
  return layers;
}

function only(layers: LayerDigests, keep: (layer: string) => boolean): LayerDigests {
  return Object.fromEntries(Object.entries(layers).filter(([layer]) => keep(layer)));
}

/** The `telo` evidence half, its registry rungs read from the command's options. */
export function teloEvidence(rungsOf: (argv: Readonly<Record<string, unknown>>) => RegistryRungs): EvidenceAdapter {
  return {
    ecosystem: TELO_ECOSYSTEM,
    async open(released, { ledger, argv }): Promise<EvidenceSession> {
      const workspace: Workspace = { ...released, modules: discoverModules(released.root, released.units) };
      const byKey = new Map(workspace.modules.map((module) => [module.key, module]));
      const { targets, assigned, diagnostics } = resolveTargets(workspace, ledger, rungsOf(argv));
      const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workspace.root, ".telo"), assigned });
      const graph = await readImportGraph(workspace, targets, builder);
      const moduleOf = (key: ModuleKey) => {
        const module = byKey.get(key);
        if (!module) throw new Error(`'${key}' anchors the telo ecosystem but holds no module with a version.`);
        return module;
      };

      return {
        // Destination collisions are judged across every ecosystem's rows.
        diagnostics: [
          ...diagnostics.filter((diagnostic) => diagnostic.code !== "DESTINATION_COLLISION"),
          ...graph.diagnostics,
        ],
        async collect({ unit }) {
          const module = moduleOf(unit.key);
          const target = targets.get(unit.key);
          if (!target) throw new Error(`no publish destination was resolved for '${unit.key}'.`);
          const payload = await builder.payload(module.manifestPath, target.destination);
          const inlines = new Map<ModuleKey, string[]>();
          for (const input of payload.buildInputs) {
            const relative = path.relative(workspace.root, path.resolve(input)).split(path.sep).join("/");
            const owner = owningUnit(workspace.units, relative);
            if (!owner || owner.key === unit.key || relative.startsWith("..")) continue;
            inlines.set(owner.key, [...(inlines.get(owner.key) ?? []), relative].sort());
          }
          const dir = path.relative(workspace.root, module.dir).split(path.sep).join("/");
          return {
            layer: await digestPayload(payload),
            files: payload.layers.flatMap((layer) => layer.files.map((file) => (dir ? `${dir}/${file.name}` : file.name))),
            imports: graph.imports.get(unit.key) ?? [],
            inlines,
            registry: target.registry,
          };
        },
        async imports({ unit }) {
          return graph.imports.get(unit.key) ?? [];
        },
        destination: ({ unit }) => targets.get(unit.key)?.destination,
        registry: ({ unit }) => targets.get(unit.key)?.registry,
        async readBack({ unit }, version, recorded): Promise<ReadBack> {
          const target = targets.get(unit.key);
          if (!target) return { kind: "unverifiable", reason: "no registry names where the module is published" };
          const published = await readPublishedDigests(target.destination, version);
          if (published === null) return { kind: "absent" };
          const before = typeof recorded === "object" ? recorded : {};
          const verifiable = (layer: string) => !LOCALLY_DERIVED_LAYERS.has(layer);
          const drift = diffLayers(
            { ecosystems: { [TELO_ECOSYSTEM]: { ".": only(before, verifiable) } } },
            { ecosystems: { [TELO_ECOSYSTEM]: { ".": only(published, verifiable) } } },
          ).map((change) => change.path.join("/"));
          return {
            kind: "published",
            layer: { ...only(before, (layer) => !verifiable(layer)), ...published },
            drift: recorded === undefined ? [] : drift,
          };
        },
        /** A module delivering its controller from npm pins its OWN package in
         *  the manifest; that pin is part of its version too. */
        async afterStamp({ unit }, version) {
          const module = moduleOf(unit.key);
          const written: string[] = [];
          for (const location of unit.versionLocations) {
            if (path.posix.basename(location.file) !== PACKAGE_JSON) continue;
            const ownPackage = readPackageName(path.join(workspace.root, location.file));
            if (!ownPackage) continue;
            const before = fs.readFileSync(module.manifestPath, "utf8");
            const after = stampSelfNpmPins(before, ownPackage, version);
            if (after === before) continue;
            fs.writeFileSync(module.manifestPath, after, "utf8");
            written.push(path.relative(workspace.root, module.manifestPath).split(path.sep).join("/"));
          }
          return written;
        },
      };
    },
  };
}

/**
 * The package a module ships itself, when it is published. A MALFORMED file is
 * refused rather than read as none: it decides whether the manifest's self-pin is
 * stamped, so skipping it would ship a manifest naming a version that never moved.
 */
function readPackageName(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  let pkg: { name?: string; private?: boolean };
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${(err as Error).message}. It decides whether this module's ` +
        `manifest pins its own package, so it cannot be skipped.`,
    );
  }
  return pkg.private ? undefined : pkg.name;
}
