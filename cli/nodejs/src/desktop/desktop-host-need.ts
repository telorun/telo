import { DESKTOP_HOST_TYPE, needParametersWithDefaults, type NeedEnvironmentEntry } from "@telorun/analyzer";
import { isModulePathSentinel } from "@telorun/templating";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

import { loadNeedTable } from "../load-need-table.js";
import type { Logger } from "../logger.js";

/**
 * Whether `telo run` is the desktop host of an application, and what of its
 * `Telo.DesktopHost` need the host reads: the root declares one and the
 * environment sets neither of its fields. The need is read from the need table
 * over the whole graph, as `telo needs report` reads it.
 */

export interface DesktopHostNeed {
  /** The need's name on the root. */
  name: string;
  identifier: string;
  productName: string;
  /** Absolute path of the application icon, when the root names one. */
  icon?: string;
  /** The icon's path as the root wrote it, relative to its module (`icon.png`). */
  iconSource?: string;
  /** The key of the root's `ports:` the windows show. */
  portKey: string;
  /** That entry's `default:`, when it declares one. */
  declaredPort?: number;
  showInDock: boolean;
  callbackPaths: string[];
  /** The environment variables the root's `variables:` / `secrets:` / `ports:` bind,
   *  which the helper is not handed. */
  declaredEnv: string[];
}

export type DesktopHostReading =
  | { kind: "none" }
  | { kind: "host"; need: DesktopHostNeed }
  /** The load was refused; its refusals are printed and `process.exitCode` set. */
  | { kind: "refused" };

/**
 * `manifest` is what the command was handed (a packaged executable included);
 * `entryPath` the manifest it resolved to. Only an entry whose root document
 * names the built-in type at a `needs:` entry is loaded: a `supply: root` need is
 * always declared on the root, so every other application costs one parse.
 */
export async function readDesktopHostNeed(
  manifest: string,
  entryPath: string,
  env: NodeJS.ProcessEnv,
  log: Logger,
): Promise<DesktopHostReading> {
  if (!rootNamesDesktopHost(entryPath)) return { kind: "none" };
  const loaded = await loadNeedTable(manifest, log, "desktop host");
  if (!loaded) return { kind: "refused" };
  const entry = loaded.table.environment.find(
    (candidate): candidate is NeedEnvironmentEntry => !candidate.via && candidate.need.type === DESKTOP_HOST_TYPE,
  );
  if (!entry) return { kind: "none" };
  if (Object.values(entry.fields).some((field) => env[field.env] !== undefined && env[field.env] !== "")) {
    return { kind: "none" };
  }
  const shape = loaded.needType(entry.need.type!);
  const parameters = needParametersWithDefaults(shape, entry.need.parameters) as Record<string, unknown>;
  const portKey = parameters.port as string;
  const declaredDefault = (loaded.root.ports as Record<string, { default?: unknown }> | undefined)?.[portKey]?.default;
  const icon = parameters.icon;
  return {
    kind: "host",
    need: {
      name: entry.need.name,
      identifier: parameters.identifier as string,
      productName: parameters.productName as string,
      ...(isModulePathSentinel(icon) ? { ...iconPath(icon.source, entry.declaredBy), iconSource: icon.source } : {}),
      portKey,
      ...(typeof declaredDefault === "number" && Number.isInteger(declaredDefault) ? { declaredPort: declaredDefault } : {}),
      showInDock: parameters.showInDock !== false,
      callbackPaths: Array.isArray(parameters.callbackPaths) ? (parameters.callbackPaths as string[]) : [],
      declaredEnv: declaredEnvNames(loaded.root),
    },
  };
}

function declaredEnvNames(root: Record<string, any>): string[] {
  const names: string[] = [];
  for (const block of ["variables", "secrets", "ports"]) {
    for (const entry of Object.values((root[block] ?? {}) as Record<string, { env?: unknown } | null>)) {
      if (typeof entry?.env === "string") names.push(entry.env);
    }
  }
  return names;
}

function rootNamesDesktopHost(entryPath: string): boolean {
  if (/^https?:\/\//i.test(entryPath)) return false;
  let file = path.resolve(entryPath);
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "telo.yaml");
    const [root] = parseAllDocuments(fs.readFileSync(file, "utf8"), { logLevel: "silent" });
    const needs = (root?.toJS({ maxAliasCount: -1 }) as { needs?: unknown } | null)?.needs;
    if (!needs || typeof needs !== "object") return false;
    return Object.values(needs as Record<string, unknown>).some(
      (need) => (need as { kind?: unknown } | null)?.kind === DESKTOP_HOST_TYPE,
    );
  } catch {
    // An entry that cannot be read is the kernel's load to refuse, with its own diagnostics.
    return false;
  }
}

/** A `!module-path` of the root module, as the absolute path it names; only a
 *  root on this machine's disk has one, and a remote root's window keeps the
 *  toolkit's icon. */
function iconPath(relative: string, moduleSource: string): { icon: string } | Record<string, never> {
  const file = moduleSource.startsWith("file:") ? fileURLToPath(moduleSource) : moduleSource;
  if (!path.isAbsolute(file)) return {};
  return { icon: path.resolve(path.dirname(file), relative) };
}
