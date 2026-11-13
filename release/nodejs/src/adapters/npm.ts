/**
 * The `npm` ecosystem's pure half: an anchor holding a `package.json` with a
 * version is one npm package; its version is that file's top-level `version`. A
 * private package supplies its version and edges but publishes nothing, so it
 * contributes no layer.
 */

import type { EcosystemAdapter, VersionFileHandler } from "../adapter.js";
import { documentScalar, spliceScalar } from "../version-files.js";

export const PACKAGE_JSON = "package.json";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly private?: unknown;
}

function readPackageJson(text: string): PackageJson | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PackageJson)
    : undefined;
}

/** The top-level `"version"` of a `package.json` rewritten in place, keeping the
 *  file's indentation, key order and trailing newline. */
export function stampPackageVersion(text: string, version: string, where: string): string | undefined {
  const node = documentScalar(text, ["version"], where);
  if (!node || typeof node.value !== "string") return undefined;
  return spliceScalar(text, node, version, where);
}

const packageJsonHandler: VersionFileHandler = {
  fileName: PACKAGE_JSON,
  read: (text) => {
    const version = readPackageJson(text)?.version;
    return typeof version === "string" ? version : undefined;
  },
  write: stampPackageVersion,
};

export const npmAdapter: EcosystemAdapter = {
  ecosystem: "npm",
  anchorDescription: "a directory holding a package.json with a version",
  versionFile: { file: PACKAGE_JSON },
  recognize(probe) {
    const text = probe.readFile(PACKAGE_JSON);
    const pkg = text === undefined ? undefined : readPackageJson(text);
    if (!pkg || typeof pkg.version !== "string") return undefined;
    return {
      ...(typeof pkg.name === "string" ? { name: pkg.name } : {}),
      contributesLayer: pkg.private !== true,
    };
  },
  versionFileHandlers: [packageJsonHandler],
};
