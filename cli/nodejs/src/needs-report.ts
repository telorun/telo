import {
  needFeatures,
  needParametersWithDefaults,
  needVersionRange,
  type LoadedGraph,
  type NeedTable,
  type NeedEnvironmentEntry,
  type NeedTypeShape,
} from "@telorun/analyzer";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * THE NEEDS REPORT — every need a root application reads from the environment,
 * with nothing booted: what an operator provisions before starting it. Fields
 * are added within a `reportVersion`; a field changing meaning is a new version.
 */
export interface NeedsReport {
  reportVersion: 1;
  needs: NeedsReportEntry[];
}

export interface NeedsReportEntry {
  /** The need path: its name beneath each importer's alias. */
  path: string;
  /** Location of the module declaring the need. */
  declaredBy: string;
  type: { module: string; name: string };
  /** The version range the need states, or null. */
  version: string | null;
  /** The features the need asks for. */
  features: string[];
  /** As the need states them, with its type's schema defaults filled in. */
  parameters: unknown;
  optional: boolean;
  fields: Record<
    string,
    { env: string; envSource: "bound" | "derived"; required: boolean; sensitive: boolean }
  >;
}

export function buildNeedsReport(
  graph: LoadedGraph,
  table: NeedTable,
  needType: (kind: string) => NeedTypeShape | undefined,
): NeedsReport {
  return {
    reportVersion: 1,
    needs: table.environment.map((entry) => reportEntry(graph, entry, needType)),
  };
}

function reportEntry(
  graph: LoadedGraph,
  entry: NeedEnvironmentEntry,
  needType: (kind: string) => NeedTypeShape | undefined,
): NeedsReportEntry {
  const type = entry.need.type ?? entry.need.kind;
  const fields: NeedsReportEntry["fields"] = {};
  for (const [name, field] of Object.entries(entry.fields ?? {})) {
    fields[name] = {
      env: field.env,
      envSource: field.envSource,
      required: field.required,
      sensitive: field.sensitive,
    };
  }
  return {
    path: entry.path.join("."),
    declaredBy: moduleLocation(graph, entry.declaredBy),
    type: {
      // A type no module document declares is the kernel's: its canonical module name.
      module:
        entry.typeModule !== undefined ? moduleLocation(graph, entry.typeModule) : type.slice(0, type.indexOf(".")),
      name: type.slice(type.indexOf(".") + 1),
    },
    version: needVersionRange(entry.need)?.raw ?? null,
    features: needFeatures(entry.need),
    parameters: needParametersWithDefaults(
      entry.need.type ? needType(entry.need.type) : undefined,
      entry.need.parameters,
    ),
    optional: entry.need.optional,
    fields,
  };
}

/**
 * Where a module lives, independent of its version: a registry or URL location
 * with no `@<version>` and no `#<pin>`, or — for a module on the filesystem —
 * its POSIX path relative to the root manifest's directory, prefixed `./`, a
 * module's `telo.yaml` named by its directory as an import names it.
 */
export function moduleLocation(graph: LoadedGraph, key: string): string {
  const requested = graph.modules.get(key)?.owner.requestedUrl ?? key;
  const local = localPath(key);
  if (local === undefined) return withoutVersion(requested);
  const rootDir = path.dirname(localPath(graph.rootSource) ?? graph.rootSource);
  let relative = path.relative(rootDir, local).split(path.sep).join("/");
  if (path.posix.basename(relative) === "telo.yaml") relative = path.posix.dirname(relative);
  return relative === "." || relative === "" ? "./" : `./${relative}`;
}

function localPath(source: string): string | undefined {
  if (source.startsWith("file://")) return fileURLToPath(source);
  return path.isAbsolute(source) ? source : undefined;
}

function withoutVersion(location: string): string {
  const hash = location.indexOf("#");
  const unpinned = hash === -1 ? location : location.slice(0, hash);
  const lastSlash = unpinned.lastIndexOf("/");
  const at = unpinned.indexOf("@", lastSlash + 1);
  return at === -1 ? unpinned : unpinned.slice(0, at);
}
