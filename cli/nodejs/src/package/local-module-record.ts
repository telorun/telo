import {
  BILL_OF_MATERIALS_FILE,
  selectorMatches,
  type ModuleFileClaim,
  type NativeEntry,
  type PlatformTarget,
  type RecordSubject,
} from "@telorun/analyzer";
import { OciTransport, type PayloadLayer } from "@telorun/kernel";
import * as path from "node:path";
import {
  assembleModuleRecord,
  billOfMaterialsLayer,
  type BundleProduct,
  type UnattributedInput,
} from "../bundle/module-bill-of-materials.js";
import { partitionLayers } from "../bundle/partition-layers.js";
import type { ModuleSource } from "@telorun/analyzer";
import type { AppModuleLayer } from "./app-payload.js";

/**
 * A packaged local module's record: what the module would publish, from the
 * builds and staging that wrote its files into `app/`, kept to the layers the
 * payload's platform loads (the payload carries nothing else). Every
 * `telo:layer` value names the layer the module would publish the file in.
 */
export async function packagedModuleRecord(options: {
  readonly subject: RecordSubject;
  readonly claims: readonly ModuleFileClaim[];
  readonly selected: string[];
  readonly assetPatterns: string[];
  readonly native: readonly NativeEntry[];
  readonly sources: readonly ModuleSource[];
  readonly bundles: readonly BundleProduct[];
  readonly beside: ReadonlyMap<string, readonly string[]>;
  readonly platform: PlatformTarget;
  /** The directory of the manifest whose artifact the module would ship in. */
  readonly publishRoot: string;
}): Promise<{
  readonly layer: AppModuleLayer;
  /** The record's canonical bytes, `sbom.cdx.json`. */
  readonly text: string;
  readonly unattributed: readonly UnattributedInput[];
}> {
  const whole = partitionLayers(options.claims, options.selected, options.assetPatterns, options.native, options.beside);
  const partition = {
    ...whole,
    layers: whole.layers.filter((layer) => !layer.selector || selectorMatches(layer.selector, options.platform)),
  };
  const unique = new Map<string, BundleProduct>();
  for (const bundle of options.bundles) unique.set(bundle.path, bundle);
  const record = await assembleModuleRecord({
    subject: options.subject,
    partition,
    claims: options.claims,
    native: options.native,
    sources: options.sources,
    bundles: [...unique.values()],
    publishRoot: path.resolve(options.publishRoot),
  });
  const [framed] = await new OciTransport().layerIndex([billOfMaterialsLayer(record.text) as PayloadLayer]);
  if (!framed || framed.role !== "sbom") throw new Error(`framing the ${BILL_OF_MATERIALS_FILE} layer produced no sbom entry`);
  return {
    layer: { role: "sbom", blob: framed.blob, integrity: framed.integrity },
    text: record.text,
    unattributed: record.unattributed,
  };
}
