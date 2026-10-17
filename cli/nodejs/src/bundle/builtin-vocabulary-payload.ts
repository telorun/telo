import { readBuiltinVocabulary, type ArtifactLayer } from "@telorun/analyzer";
import { defaultTransportRegistry, readPayloadFile, type PayloadLayer } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";
import { PublishFailure } from "../publish-failure.js";
import type { BuiltLayer } from "./built-layers.js";
import type { Partition } from "./partition-layers.js";
import { MODULE_LICENSE_FILE } from "./select-files.js";

/**
 * The published payload of a built-in vocabulary archive (`Telo.Builtins`,
 * `kernel/specs/builtin-vocabulary.md`): a manifest-only artifact whose one
 * other layer is `common`, carrying the MIT `LICENSE` beside the archive.
 *
 * None of a module's payload rules apply — there is no import to canonicalize,
 * no controller to build, nothing staged and no `requires:` — and the manifest
 * is NEVER re-serialized: the published `telo.yaml` is the archive's bytes with
 * the `layers:` index appended at the end of its first document, so removing
 * that block gives back exactly the archive the release rendered. That identity
 * is what lets anyone compare `oci://…/telo@X` with `@telorun/analyzer@X`.
 *
 * What it does refuse is the archive's own malformation, through the analyzer's
 * one reader (`manifest_invalid`).
 */
export interface BuiltinVocabularyPayload {
  readonly manifest: string;
  readonly version: string;
  readonly layers: BuiltLayer[];
  readonly partition: Partition;
}

export async function builtinVocabularyPayload(
  manifestPath: string,
  destination: string,
): Promise<BuiltinVocabularyPayload> {
  const text = fs.readFileSync(manifestPath, "utf8");
  const reading = readBuiltinVocabulary(text);
  if (!reading.vocabulary) {
    throw new PublishFailure(
      "manifest_invalid",
      `${manifestPath} is not a publishable built-in vocabulary archive:\n` +
        reading.problems.map((problem) => `  ${problem}`).join("\n"),
      { problems: reading.problems },
    );
  }
  if (Object.hasOwn(reading.vocabulary.root, "layers")) {
    throw new PublishFailure(
      "manifest_invalid",
      `${manifestPath} already carries a \`layers:\` index — it is a published archive, not the one a ` +
        `release rendered. Publish the release's own \`builtins.yaml\`.`,
    );
  }
  if (reading.vocabulary.version.includes("+")) {
    throw new PublishFailure(
      "manifest_invalid",
      `${manifestPath} is the vocabulary of ${reading.vocabulary.version}, a build of an unreleased tree — ` +
        `only a release's archive is published, under that release's version.`,
    );
  }
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(path.join(dir, MODULE_LICENSE_FILE))) {
    throw new PublishFailure(
      "manifest_invalid",
      `${manifestPath} has no ${MODULE_LICENSE_FILE} beside it. The vocabulary is published under ` +
        `\`license: MIT\`, and the artifact carries the text that names.`,
    );
  }

  const transport = defaultTransportRegistry().forRef(destination);
  if (!transport) throw new Error(`no transport owns publish destination '${destination}'`);
  const layers: BuiltLayer[] = [
    { role: "common", files: [await readPayloadFile(dir, MODULE_LICENSE_FILE)] },
  ];
  const index = await transport.layerIndex(layers as PayloadLayer[]);
  return {
    manifest: appendLayerIndex(text, index),
    version: reading.vocabulary.version,
    layers,
    partition: {
      layers: [{ role: "common", files: [MODULE_LICENSE_FILE] }],
      unmatchedAssets: [],
      unmatchedSiblings: [],
    },
  };
}

/**
 * `text` with a `layers:` block written at the end of its first document and
 * nothing else changed. Every value is a JSON string, which a YAML reader reads
 * back as the same text.
 */
export function appendLayerIndex(text: string, index: readonly ArtifactLayer[]): string {
  const lines = ["layers:"];
  for (const layer of index) {
    lines.push(`  - role: ${JSON.stringify(layer.role)}`);
    if (layer.selector && Object.keys(layer.selector).length > 0) {
      lines.push("    selector:");
      for (const [axis, value] of Object.entries(layer.selector)) {
        lines.push(`      ${axis}: ${JSON.stringify(value)}`);
      }
    }
    lines.push(`    blob: ${JSON.stringify(layer.blob)}`, `    integrity: ${JSON.stringify(layer.integrity)}`);
  }
  const block = `${lines.join("\n")}\n`;
  const end = text.indexOf("\n---\n");
  return end === -1 ? `${text}${block}` : `${text.slice(0, end + 1)}${block}${text.slice(end + 1)}`;
}
