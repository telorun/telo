/**
 * The `telo` ecosystem's pure half: an anchor holding a `telo.yaml` whose module
 * doc carries a `metadata.version` is one Telo module.
 *
 * A module lists no anchors for its own npm and Cargo packages: the module doc
 * already says where they are. Each controller locator's `local_path` names a
 * source inside the module, and the nearest package manifest at or above it —
 * a `Cargo.toml` for a `pkg:cargo` locator, a `package.json` for any other,
 * never above the module — is a package the module ships; so is each
 * `sources:` `build.cargo` crate. Their version files carry the module's version
 * and are written with it.
 */

import {
  AdapterRegistry,
  CARGO_TOML,
  PACKAGE_JSON,
  SHIPPED_ADAPTERS,
  type EcosystemAdapter,
  type UnitLayers,
  type VersionFileHandler,
} from "@telorun/release";
import { PackageURL } from "packageurl-js";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags } from "@telorun/templating";
import { readModuleSources } from "../source-entries.js";
import { readManifestVersion, stampManifestVersion } from "./version-stamp.js";

export const TELO_ECOSYSTEM = "telo";
export const MODULE_MANIFEST = "telo.yaml";

/** The layer key a module's image digest was recorded under in the flat module
 *  ledger. */
const LEGACY_IMAGE_LAYER = "image";

const manifestHandler: VersionFileHandler = {
  fileName: MODULE_MANIFEST,
  read: readManifestVersion,
  write: stampManifestVersion,
};

/** The anchor-relative package manifests of a module's own npm and Cargo
 *  packages, read from its manifest. */
export function modulePackageFiles(
  manifest: string,
  exists: (relative: string) => boolean,
): string[] {
  const docs = parseAllDocuments(manifest, { customTags: defaultCustomTags() });
  /** Each locator's source, with the manifest its ecosystem keeps. */
  const starts = new Map<string, Set<string>>();
  const crates = new Set<string>();
  for (const [index, doc] of docs.entries()) {
    const json = doc.toJSON() as { controllers?: unknown } | null;
    for (const candidate of Array.isArray(json?.controllers) ? json.controllers : []) {
      const located = localPathOf(candidate);
      if (!located) continue;
      const files = starts.get(located.path) ?? new Set<string>();
      files.add(located.manifest);
      starts.set(located.path, files);
    }
    if (index === 0) {
      for (const source of readModuleSources(json).sources) {
        if (source.build) crates.add(source.build.cargo);
      }
    }
  }

  const found = new Set<string>();
  for (const [start, files] of starts) {
    for (const file of files) {
      const nearest = nearestAtOrAbove(start, file, exists);
      if (nearest !== undefined) found.add(nearest);
    }
  }
  for (const crate of crates) {
    const file = crate === "" ? CARGO_TOML : `${crate}/${CARGO_TOML}`;
    if (exists(file)) found.add(file);
  }
  return [...found].sort();
}

/** A locator's `local_path` and the package manifest of the ecosystem building
 *  it: `pkg:cargo` a crate, every other controller format an npm package. */
function localPathOf(candidate: unknown): { path: string; manifest: string } | undefined {
  if (typeof candidate !== "string") return undefined;
  let parsed: PackageURL;
  try {
    parsed = PackageURL.fromString(candidate);
  } catch {
    return undefined;
  }
  const value = parsed.qualifiers?.local_path;
  if (typeof value !== "string" || value === "") return undefined;
  const segments = value.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  // A path leaving the module names no package of it.
  if (segments.includes("..") || value.startsWith("/")) return undefined;
  return { path: segments.join("/"), manifest: parsed.type === "cargo" ? CARGO_TOML : PACKAGE_JSON };
}

/** The nearest `file` in `start` or a directory above it, never above the
 *  module root. */
function nearestAtOrAbove(
  start: string,
  file: string,
  exists: (relative: string) => boolean,
): string | undefined {
  const segments = start === "" ? [] : start.split("/");
  for (let depth = segments.length; depth >= 0; depth--) {
    const dir = segments.slice(0, depth).join("/");
    const candidate = dir === "" ? file : `${dir}/${file}`;
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Reads the versions of a module's own packages. */
const shipped = new AdapterRegistry(SHIPPED_ADAPTERS);

export const teloAdapter: EcosystemAdapter = {
  ecosystem: TELO_ECOSYSTEM,
  anchorDescription: "a directory holding a telo.yaml whose module doc carries a metadata.version",
  keys: {
    registry: {
      type: "string",
      description:
        "Publish destination base. A module's ref is `<registry>/<its own directory name>`. Omitted at the anchor and under release.ecosystems.telo: --registry, then TELO_OCI_REGISTRY, then the base the module's ledger entry recorded.",
      examples: ["oci://ghcr.io/telorun"],
    },
  },
  versionFile: { file: MODULE_MANIFEST },
  recognize(probe) {
    const manifest = probe.readFile(MODULE_MANIFEST);
    if (manifest === undefined || readManifestVersion(manifest) === undefined) return undefined;
    const name = (parseAllDocuments(manifest, { customTags: defaultCustomTags() })[0]?.toJSON() as
      | { metadata?: { name?: unknown } }
      | undefined)?.metadata?.name;
    return {
      ...(typeof name === "string" ? { name } : {}),
      contributesLayer: true,
      // A package carrying no version of its own (a crate inheriting its
      // workspace's) has none to write.
      versionFiles: modulePackageFiles(manifest, (relative) => probe.readFile(relative) !== undefined).filter(
        (relative) => {
          const name = relative.slice(relative.lastIndexOf("/") + 1);
          return shipped.handlerFor(name)?.read(probe.readFile(relative)!, relative) !== undefined;
        },
      ),
    };
  },
  versionFileHandlers: [manifestHandler],
};

/** The ecosystems a Telo host serves: the ones `@telorun/release` ships, and
 *  Telo modules. */
export const TELO_RELEASE_ADAPTERS: readonly EcosystemAdapter[] = [...SHIPPED_ADAPTERS, teloAdapter];

/**
 * How a module ledger's flat layers nest under units: an image module's digest
 * was its Docker context's, every other key a layer of the module's own
 * artifact.
 */
export function teloLegacyLedgerLayers(
  unit: string,
  flat: Readonly<Record<string, string>>,
): UnitLayers {
  const { [LEGACY_IMAGE_LAYER]: image, ...module } = flat;
  return {
    ecosystems: {
      ...(Object.keys(module).length > 0 ? { [TELO_ECOSYSTEM]: { ".": module } } : {}),
      ...(image !== undefined ? { docker: { ".": image } } : {}),
    },
  };
}
