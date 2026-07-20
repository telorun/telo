import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { parseRedactionPath, RedactionPathError } from "./redaction-path.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/**
 * Static validation of the `logging:` block — `kernel/specs/logging.md` §14.1
 * and §10.3.
 *
 * Two things the spec explicitly says are statically detectable, so leaving them
 * to a runtime failure would contradict Telo's "manifests must remain statically
 * analyzable" goal:
 *
 * 1. **Redaction paths** parse against the closed §14 grammar. §14.1's whole
 *    argument for a hand-written parser is that it makes paths checkable by
 *    `telo check`; a bad path must fail here, not silently fail to redact at
 *    runtime.
 * 2. **`on_full: block`** is unimplementable on a single-threaded runtime and
 *    §10.3 calls it "statically detectable by `telo check`". Catching it here —
 *    rather than only at boot — is what lets an operator fix it before shipping.
 */
export function validateLogging(
  manifests: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): AnalysisDiagnostic[] {
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const manifest of manifests) {
    const kind = manifest.kind;

    // Redaction paths live on the `logging:` block of the root Application and on
    // any `Telo.Import` / `Telo.Library` doc carrying a per-import override.
    if (kind === "Telo.Application" || kind === "Telo.Import" || kind === "Telo.Library") {
      validateRedactPaths(manifest, diagnostics);
    }

    // `on_full` lives on any sink instance — an inline `logging.sinks[]` entry
    // (extracted by Phase 2 into a first-class manifest by now) or a standalone
    // sink resource declared elsewhere and reached via `!ref`.
    if (isSinkKind(manifest, registry, aliases, aliasesByModule)) {
      validateOnFull(manifest, diagnostics);
    }
  }

  return diagnostics;
}

function validateRedactPaths(manifest: ResourceManifest, out: AnalysisDiagnostic[]): void {
  const name = (manifest.metadata as { name?: string } | undefined)?.name;
  const filePath = (manifest.metadata as { source?: string } | undefined)?.source;
  const resource = { kind: manifest.kind, name };

  for (const { block, prefix } of loggingBlocks(manifest)) {
    const paths = (block.redact as { paths?: unknown } | undefined)?.paths;
    if (!Array.isArray(paths)) continue;
    paths.forEach((path, index) => {
      // A `!cel` path is a compiled/sentinel node by now, not a string — its
      // value isn't known statically, so there is nothing to parse.
      if (typeof path !== "string") return;
      try {
        parseRedactionPath(path);
      } catch (err) {
        if (!(err instanceof RedactionPathError)) throw err;
        out.push({
          severity: DiagnosticSeverity.Error,
          code: "INVALID_REDACTION_PATH",
          source: SOURCE,
          message: `${manifest.kind}/${name ?? "(unnamed)"}: ${err.message}`,
          data: { resource, filePath, path: `${prefix}redact.paths[${index}]` },
        });
      }
    });
  }
}

function validateOnFull(manifest: ResourceManifest, out: AnalysisDiagnostic[]): void {
  const onFull = (manifest as { on_full?: unknown }).on_full;
  if (onFull !== "block") return;
  const name = (manifest.metadata as { name?: string } | undefined)?.name;
  const filePath = (manifest.metadata as { source?: string } | undefined)?.source;
  out.push({
    severity: DiagnosticSeverity.Error,
    code: "LOG_SINK_ON_FULL_UNSUPPORTED",
    source: SOURCE,
    message:
      `${manifest.kind}/${name ?? "(unnamed)"}: on_full: block is not supported on a ` +
      `single-threaded runtime — blocking the producer would stall the writer. ` +
      `Use drop_new or drop_old.`,
    data: { resource: { kind: manifest.kind, name }, filePath, path: "on_full" },
  });
}

/** The root `logging:` block plus every per-import `logging:` override, each
 *  with the dotted path prefix a diagnostic anchors against. */
function loggingBlocks(
  manifest: ResourceManifest,
): Array<{ block: Record<string, unknown>; prefix: string }> {
  const blocks: Array<{ block: Record<string, unknown>; prefix: string }> = [];
  const root = (manifest as { logging?: unknown }).logging;
  if (isObject(root)) blocks.push({ block: root, prefix: "logging." });

  // Inline imports map: `imports.<Alias>.logging`.
  const imports = (manifest as { imports?: unknown }).imports;
  if (isObject(imports)) {
    for (const [alias, entry] of Object.entries(imports)) {
      if (!isObject(entry)) continue;
      const block = (entry as { logging?: unknown }).logging;
      if (isObject(block)) blocks.push({ block, prefix: `imports.${alias}.logging.` });
    }
  }
  return blocks;
}

function isSinkKind(
  manifest: ResourceManifest,
  registry: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): boolean {
  if (typeof manifest.kind !== "string") return false;
  if (manifest.kind === "Telo.ConsoleSink" || manifest.kind === "Telo.FileSink") return true;
  const ownModule = (manifest.metadata as { module?: string } | undefined)?.module;
  const resolver =
    (ownModule ? aliasesByModule?.get(ownModule) : undefined) ?? aliases;
  const canonical = resolver.resolveKind(manifest.kind) ?? manifest.kind;
  return registry.resolve(canonical)?.capability === "Telo.Sink";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
