/**
 * The `helm` ecosystem's pure half: an anchor holding a `Chart.yaml` with a name
 * and a version is one chart. Its version is the chart's `version`; a chart
 * anchored in a unit deploys that unit, so its `appVersion` carries the same
 * version and is written with it.
 */

import { parseDocument } from "yaml";
import type { EcosystemAdapter, VersionFileHandler } from "../adapter.js";
import { documentScalar, spliceScalar, spliceText } from "../version-files.js";

export const CHART_YAML = "Chart.yaml";

/** `version` and `appVersion` of a `Chart.yaml`, rewritten in place; an absent
 *  `appVersion` is added on the line after `version`. */
export function stampChartVersion(text: string, version: string, where: string): string | undefined {
  const node = documentScalar(text, ["version"], where);
  if (!node || typeof node.value !== "string") return undefined;
  const app = documentScalar(text, ["appVersion"], where);
  if (app) {
    const [first, second] = [node, app].sort((a, b) => b.range![0] - a.range![0]);
    return spliceScalar(spliceScalar(text, first!, version, where), second!, version, where);
  }
  const written = spliceScalar(text, node, version, where);
  const lineEnd = written.indexOf("\n", node.range![0]);
  const line = `appVersion: ${JSON.stringify(version)}\n`;
  return lineEnd < 0
    ? `${written}\n${line}`
    : spliceText(written, lineEnd + 1, lineEnd + 1, line);
}

const chartHandler: VersionFileHandler = {
  fileName: CHART_YAML,
  read: (text, where) => {
    const node = documentScalar(text, ["version"], where);
    return node && typeof node.value === "string" ? node.value : undefined;
  },
  write: stampChartVersion,
};

export const helmAdapter: EcosystemAdapter = {
  ecosystem: "helm",
  anchorDescription: "a directory holding a Chart.yaml with a name and a version",
  keys: {
    registry: {
      type: "string",
      description: "OCI chart registry base the chart is pushed under, as `<registry>/<chart name>`.",
      examples: ["oci://ghcr.io/acme/charts"],
    },
  },
  versionFile: { file: CHART_YAML },
  recognize(probe) {
    const text = probe.readFile(CHART_YAML);
    if (text === undefined) return undefined;
    const value = parseDocument(text).toJSON() as { name?: unknown; version?: unknown } | null;
    if (!value || typeof value.name !== "string" || typeof value.version !== "string") return undefined;
    return { name: value.name, contributesLayer: true };
  },
  versionFileHandlers: [chartHandler],
};
