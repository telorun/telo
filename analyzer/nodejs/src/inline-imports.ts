import type { ResourceManifest } from "@telorun/sdk";
import type { LoadedFile } from "./loaded-types.js";
import { foldIntegrity } from "./sources/integrity.js";
import { importFieldRefusals } from "./loader-expansion-refusals.js";
import { isModuleKind } from "./module-kinds.js";
import type { DocumentPosition } from "./position-metadata.js";
import type { PositionIndex } from "./types.js";

/** A synthetic `Telo.Import` produced by desugaring an `imports:` map entry,
 *  paired with the position metadata that pins its diagnostics back to the
 *  authoring line in the module document. */
export interface SyntheticImport {
  manifest: ResourceManifest;
  position: DocumentPosition;
}

/**
 * Desugar a module document's inline `imports:` map into synthetic
 * `Telo.Import` manifests. Each entry value is either a bare source string
 * (shorthand for `{ source }`) or the full object form carrying
 * `variables` / `secrets` / `runtime`. Malformed entries (object without a
 * string `source`) are skipped here — the module document's own schema
 * validation reports them against the precise `imports.<Alias>.source` path.
 *
 * The synthetic manifests are indistinguishable from authored `Telo.Import`
 * documents downstream (alias registration, discovery, the kernel's
 * import-controller), so the feature is purely additive at the declaration
 * site. Pure and browser-safe — no I/O, no Node built-ins.
 */
export function inlineImportManifests(
  moduleManifest: ResourceManifest,
  modulePosition: DocumentPosition | undefined,
): SyntheticImport[] {
  const raw = (moduleManifest as { imports?: unknown }).imports;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];

  const out: SyntheticImport[] = [];
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    const scalar = typeof value === "string";
    const entry = desugaredEntry(alias, value);
    if (!entry) continue;

    // The object form carries integrity as a sibling `integrity:` field; fold it
    // into the source string as a `#sha256-...` fragment so every downstream
    // consumer sees a single representation (the scalar form already inlines it).
    const source = foldIntegrity(entry.source as string, entry.integrity);

    const manifest: Record<string, unknown> = { kind: "Telo.Import", metadata: { name: alias }, source };
    for (const field of CARRIED_IMPORT_FIELDS) {
      if (entry[field] !== undefined) manifest[field] = entry[field];
    }
    out.push({ manifest: manifest as unknown as ResourceManifest, position: synthPosition(modulePosition, alias, scalar) });
  }
  return out;
}

/** The fields of an object-form entry its desugared `Telo.Import` carries. */
const CARRIED_IMPORT_FIELDS = ["variables", "secrets", "resources", "needs", "runtime", "logging"] as const;

/** An `imports:` entry as the desugarer reads it, or undefined for one it
 *  skips: no string `source`, a tagged integrity, or a splice. */
function desugaredEntry(alias: string, value: unknown): Record<string, unknown> | undefined {
  const entry =
    typeof value === "string"
      ? { source: value }
      : value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
  if (!entry || typeof entry.source !== "string") return undefined;
  // A tagged integrity, or a splice, is refused by the parse; the entry is read no further.
  if (importFieldRefusals(entry, alias, ["integrity"]).length > 0) return undefined;
  return entry;
}

/** The `imports.<alias>.<field>` positions of a module document that its
 *  desugared imports carry, so each is judged at its `Telo.Import`; every other
 *  field of an entry (`source`, `integrity`) is read by the desugarer alone. */
export function carriedImportPaths(moduleManifest: ResourceManifest): string[] {
  const raw = (moduleManifest as { imports?: unknown }).imports;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = desugaredEntry(alias, value);
    if (!entry) continue;
    for (const field of CARRIED_IMPORT_FIELDS) if (entry[field] !== undefined) out.push(`imports.${alias}.${field}`);
  }
  return out;
}

/** Returns a copy of `file` with synthetic `Telo.Import` manifests (from the
 *  module document's inline `imports:` map) appended to `manifests` and
 *  `positions`. `documents` is intentionally left untouched: it is the raw
 *  YAML-AST array round-trip consumers pair by index, and a synthetic import
 *  has no backing node. Every flatten/discovery loop iterates `manifests` and
 *  indexes `positions[i]` — never `documents[i]` in lockstep — so the trailing
 *  synthetics are visible to resolution while the AST round-trip stays intact.
 *  Returns `file` unchanged when there is no module doc or no inline imports. */
export function desugarLoadedFile(file: LoadedFile): LoadedFile {
  let moduleIndex = -1;
  for (let i = 0; i < file.manifests.length; i++) {
    const m = file.manifests[i];
    if (m && isModuleKind(m.kind)) {
      moduleIndex = i;
      break;
    }
  }
  if (moduleIndex < 0) return file;

  const synthetic = inlineImportManifests(file.manifests[moduleIndex]!, file.positions[moduleIndex]);
  if (synthetic.length === 0) return file;

  // Copied by descriptor: a file restored from a parse cache reads its YAML
  // documents through getters, and a spread would parse them.
  const out = Object.defineProperties({}, Object.getOwnPropertyDescriptors(file)) as LoadedFile;
  out.manifests = [...file.manifests, ...synthetic.map((s) => s.manifest)];
  out.positions = [...file.positions, ...synthetic.map((s) => s.position)];
  return out;
}

/** Build a `DocumentPosition` for a synthetic import by re-rooting the module
 *  document's `imports.<Alias>` position subtree at the import manifest's own
 *  paths (`source`, `variables.*`, `metadata.name`, …). This makes a
 *  diagnostic on the synthetic's `source` land on the `imports:` entry's
 *  authoring line rather than a phantom document. */
function synthPosition(
  modulePosition: DocumentPosition | undefined,
  alias: string,
  scalar: boolean,
): DocumentPosition {
  if (!modulePosition) return { sourceLine: 0, positionIndex: new Map() };

  const base = modulePosition.positionIndex;
  const index: PositionIndex = new Map();

  const keyRange = base.get(`@key:imports.${alias}`);
  const valueRange = base.get(`imports.${alias}`);

  if (keyRange) {
    index.set("metadata.name", keyRange);
    index.set("@key:metadata.name", keyRange);
  }

  if (scalar) {
    // `Console: std/console@1.2.3` — the entry value IS the source scalar.
    if (valueRange) index.set("source", valueRange);
  } else {
    const valuePrefix = `imports.${alias}.`;
    const keyPrefix = `@key:imports.${alias}.`;
    for (const [path, range] of base) {
      if (path.startsWith(valuePrefix)) {
        index.set(path.slice(valuePrefix.length), range);
      } else if (path.startsWith(keyPrefix)) {
        index.set(`@key:${path.slice(keyPrefix.length)}`, range);
      }
    }
  }

  if (valueRange) index.set("", valueRange);

  const sourceLine = (keyRange ?? valueRange)?.start.line ?? modulePosition.sourceLine;
  return { sourceLine, positionIndex: index };
}
