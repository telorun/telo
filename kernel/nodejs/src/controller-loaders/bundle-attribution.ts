/**
 * The bundle producer of a module's bill of materials
 * (`kernel/specs/module-artifact.md` §7.2): which packages a bundle put bytes
 * from, read off the metafile of the build that produced it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The metafile members this reads. */
interface MetafileOutputs {
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
}

/** An esbuild input outside the file namespace (`(disabled):fs`) — generated,
 *  not package code. A Windows drive letter is not a namespace. */
function isVirtualInput(key: string): boolean {
  return /^[^/\\]+:/.test(key) && !/^[A-Za-z]:[\\/]/.test(key);
}

/**
 * The inputs that put bytes into the named outputs (every output when none is
 * named), as the metafile spells them: an input tree-shaken away contributes
 * none and is not listed.
 */
export function contributingInputs(metafile: MetafileOutputs, outputs?: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const [name, output] of Object.entries(metafile.outputs)) {
    if (outputs && !outputs.includes(name)) continue;
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (bytesInOutput > 0 && !isVirtualInput(input)) keys.add(input);
    }
  }
  return [...keys].sort();
}

/** A package a bundle inlined code from. */
export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
}

export interface BundleAttribution {
  /** Every package some contributing input belongs to, once each. */
  readonly packages: BundledPackage[];
  /** Contributing inputs that belong to the module and to no package: absolute
   *  paths. Their layer's record is incomplete. */
  readonly unattributed: string[];
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
}

function licenseOf(json: Record<string, unknown>): string | undefined {
  const types = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
      return [(value as { type: string }).type];
    }
    return [];
  };
  const found = [
    ...types(json.license),
    ...(Array.isArray(json.licenses) ? json.licenses.flatMap(types) : []),
  ];
  if (found.length === 0) return undefined;
  return found.length === 1 ? found[0] : `(${found.join(" OR ")})`;
}

/** The innermost `node_modules/<pkg>` or `node_modules/@scope/<pkg>` directory
 *  holding `file`, or undefined when it lies beneath no `node_modules`. */
function packageBoundary(file: string): string | undefined {
  const parts = file.split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= parts.length - 1) return undefined;
  const scoped = parts[index + 1]!.startsWith("@");
  const end = scoped ? index + 3 : index + 2;
  if (end > parts.length - 1) return undefined;
  return parts.slice(0, end).join(path.sep);
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Attribute each contributing input of a bundle, in three ordered rules:
 *
 * 1. an input inside the publish root (the artifact root) and beneath no
 *    `node_modules` is the module's own code, not listed;
 * 2. otherwise the walk up from the input's real path ends at the nearest
 *    `package.json` declaring a `name` — attributed when it also declares a
 *    `version`, unattributed when it does not; a `package.json` without `name`
 *    is passed over, and beneath `node_modules` the walk never climbs above the
 *    innermost `node_modules/<pkg>` (or `@scope/<pkg>`) directory;
 * 3. an input the walk attributes to nothing is unattributed.
 */
export async function attributeBundleInputs(
  contributors: readonly string[],
  publishRoot: string,
): Promise<BundleAttribution> {
  const root = await fs.realpath(publishRoot);
  const manifests = new Map<string, PackageManifest | null>();
  const readManifest = async (dir: string): Promise<PackageManifest | null> => {
    if (manifests.has(dir)) return manifests.get(dir)!;
    const file = path.join(dir, "package.json");
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      manifests.set(dir, null);
      return null;
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `${file} is not JSON, so the bundled code beneath it cannot be attributed to a package: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const manifest: PackageManifest = {
      ...(typeof json.name === "string" && json.name !== "" ? { name: json.name } : {}),
      ...(typeof json.version === "string" && json.version !== "" ? { version: json.version } : {}),
      ...(licenseOf(json) ? { license: licenseOf(json) } : {}),
    };
    manifests.set(dir, manifest);
    return manifest;
  };

  const packages = new Map<string, BundledPackage>();
  const unattributed = new Set<string>();
  for (const input of contributors) {
    let real: string;
    try {
      real = await fs.realpath(input);
    } catch (err) {
      throw new Error(
        `The bundle names '${input}' among the files it inlined, but it cannot be read now ` +
          `(${(err as NodeJS.ErrnoException).code ?? String(err)}). Build the module again.`,
      );
    }
    const boundary = packageBoundary(real);
    if (isInside(real, root) && !path.relative(root, real).split(path.sep).includes("node_modules")) {
      continue;
    }
    let attributed: BundledPackage | undefined;
    let dir = path.dirname(real);
    for (;;) {
      const manifest = await readManifest(dir);
      if (manifest?.name !== undefined) {
        if (manifest.version !== undefined) {
          attributed = {
            name: manifest.name,
            version: manifest.version,
            ...(manifest.license ? { license: manifest.license } : {}),
          };
        }
        break;
      }
      if (boundary !== undefined && dir === boundary) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (attributed) packages.set(`${attributed.name}@${attributed.version}`, attributed);
    else unattributed.add(input);
  }
  return {
    packages: [...packages.values()].sort((a, b) =>
      `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1,
    ),
    unattributed: [...unattributed].sort(),
  };
}
