/**
 * `telo release imports` — the two forms of an import of a release-workspace
 * module: the relative path every branch commits, and the published, hash-pinned
 * reference a release tag carries.
 *
 * Only the manifests NAMED are rewritten, and in them only imports of workspace
 * modules. An import of the module a manifest sits inside always stays relative.
 * Edits are byte splices of the `source:` scalar, so everything else in the file,
 * quote style included, is kept and the two directions are each other's inverse.
 */

import { applyTextEdits, isLocalPathSource } from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import { createLogger, type Logger } from "../logger.js";
import { outEmit, outErrLine, outLine, outProgress } from "../output.js";
import { LocalImportPinner, type PendingCause } from "../release/local-import-pins.js";
import type { RegistryRungs } from "../release/targets.js";
import {
  buildSourceEdit,
  findModuleDoc,
  importSourceRefs,
  resolveManifestPath,
} from "./manifest-imports.js";

export type ImportForm = "published" | "relative";

export const IMPORT_FORMS: readonly ImportForm[] = ["published", "relative"];

/** An import whose source differs from the form the command writes. */
export interface ImportRewrite {
  manifest?: string;
  alias: string;
  source: string;
  to: string;
}

/** An import of a workspace module that has no published form to write. */
export interface KeptRelative {
  manifest?: string;
  alias: string;
  source: string;
  /** Machine-readable cause; `reason` is its prose. */
  cause: PendingCause;
  reason: string;
}

export interface ImportFormError {
  manifest?: string;
  alias?: string;
  source?: string;
  message: string;
}

export interface ManifestImportForms {
  /** The manifest with every rewrite applied; the input when there is none. */
  content: string;
  rewritten: ImportRewrite[];
  keptRelative: KeptRelative[];
  errors: ImportFormError[];
  /** Aliases of every import naming a workspace module, whatever its form. */
  workspaceAliases: Set<string>;
}

/**
 * Pure over `content`: the form every workspace import of one manifest takes
 * under `as`, as a rewritten text. The registry is asked only for a published
 * form.
 */
export async function rewriteImportForms(args: {
  content: string;
  manifestDir: string;
  as: ImportForm;
  pinner: LocalImportPinner;
}): Promise<ManifestImportForms> {
  const { content, manifestDir, as, pinner } = args;
  const result: ManifestImportForms = {
    content,
    rewritten: [],
    keptRelative: [],
    errors: [],
    workspaceAliases: new Set(),
  };
  const moduleDoc = findModuleDoc(parseAllDocuments(content, { customTags: defaultCustomTags() }));
  if (!moduleDoc) return result;

  const edits: Array<{ start: number; end: number; newText: string }> = [];
  for (const importRef of importSourceRefs(moduleDoc)) {
    const { alias, source } = importRef;
    const target = pinner.targetOf(manifestDir, source);
    if (target.kind === "unmanaged") continue;
    if (target.kind === "error") {
      result.errors.push({ alias, source, message: target.message });
      continue;
    }
    result.workspaceAliases.add(alias);

    let to: string;
    if (target.kind === "consumer" && as === "published") {
      const verdict = await pinner.publishedForm(target.workspace, target.module);
      if (verdict.kind === "error") {
        result.errors.push({ alias, source, message: verdict.message });
        continue;
      }
      if (verdict.kind === "pending") {
        result.keptRelative.push({ alias, source, cause: verdict.cause, reason: verdict.reason });
        if (isLocalPathSource(source)) continue;
        to = target.relative;
      } else {
        to = verdict.pin;
      }
    } else {
      if (isLocalPathSource(source)) continue;
      to = target.relative;
    }

    if (source === to && importRef.integrity === undefined) continue;
    if (importRef.integrity !== undefined) {
      result.errors.push({
        alias,
        source,
        message:
          `carries an 'integrity:' key, which this command does not rewrite — write the import ` +
          `as one source string (${to}) instead`,
      });
      continue;
    }
    const edit = buildSourceEdit(importRef.node, content, to);
    if (!edit) {
      result.errors.push({ alias, source, message: "source scalar has no range" });
      continue;
    }
    edits.push(edit);
    result.rewritten.push({ alias, source, to });
  }

  result.content = applyTextEdits(content, edits);
  return result;
}

export interface ReleaseImportsArgv {
  paths: string[];
  as: ImportForm;
  check: boolean;
  dryRun: boolean;
  rungs: RegistryRungs;
}

export interface ReleaseImportsResult {
  ok: boolean;
  as: ImportForm;
  dryRun: boolean;
  check: boolean;
  rewritten: ImportRewrite[];
  keptRelative: KeptRelative[];
  errors: ImportFormError[];
}

/** Rewrite one manifest on disk; nothing is written when `write` is false. */
export async function rewriteManifestFile(
  filePath: string,
  as: ImportForm,
  pinner: LocalImportPinner,
  write: boolean,
): Promise<ManifestImportForms> {
  const manifest = path.relative(process.cwd(), filePath);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      content: "",
      rewritten: [],
      keptRelative: [],
      errors: [{ manifest, message: `cannot read file: ${err instanceof Error ? err.message : String(err)}` }],
      workspaceAliases: new Set(),
    };
  }
  const forms = await rewriteImportForms({ content, manifestDir: path.dirname(filePath), as, pinner });
  for (const entry of [...forms.rewritten, ...forms.keptRelative, ...forms.errors]) {
    entry.manifest = manifest;
  }
  if (write && forms.content !== content) fs.writeFileSync(filePath, forms.content, "utf-8");
  return forms;
}

export function newImportPinner(rungs: RegistryRungs, log: Logger): LocalImportPinner {
  return new LocalImportPinner({
    rungs,
    onUnit: (module, index, total) =>
      outProgress(log.err.dim(`  [${index + 1}/${total}] ${module.key}`)),
  });
}

export async function releaseImports(argv: ReleaseImportsArgv): Promise<ReleaseImportsResult> {
  const log = createLogger(false);
  const pinner = newImportPinner(argv.rungs, log);
  const write = !argv.check && !argv.dryRun;
  const result: ReleaseImportsResult = {
    ok: true,
    as: argv.as,
    dryRun: argv.dryRun,
    check: argv.check,
    rewritten: [],
    keptRelative: [],
    errors: [],
  };

  const seen = new Set<string>();
  for (const input of argv.paths) {
    const { filePath, error } = resolveManifestPath(input);
    const manifest = path.relative(process.cwd(), filePath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (error) {
      result.errors.push({ manifest, message: error });
      outErrLine(`${manifest}  ${log.err.error("error")}  ${error}`);
      continue;
    }
    const forms = await rewriteManifestFile(filePath, argv.as, pinner, write);
    printManifest(manifest, forms, argv, log);
    result.rewritten.push(...forms.rewritten);
    result.keptRelative.push(...forms.keptRelative);
    result.errors.push(...forms.errors);
  }

  const verb = argv.check ? "differ" : argv.dryRun ? "would be rewritten" : "rewritten";
  const parts = [`${result.rewritten.length} ${verb}`];
  if (result.keptRelative.length > 0) parts.push(`${result.keptRelative.length} kept relative`);
  if (result.errors.length > 0) {
    parts.push(log.error(`${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`));
  }
  outLine(parts.join(", "));

  result.ok =
    result.errors.length === 0 &&
    result.keptRelative.length === 0 &&
    !(argv.check && result.rewritten.length > 0);
  return result;
}

function printManifest(
  manifest: string,
  forms: ManifestImportForms,
  argv: Pick<ReleaseImportsArgv, "check" | "dryRun">,
  log: Logger,
): void {
  for (const { alias, source, to } of forms.rewritten) {
    if (argv.check) {
      outErrLine(`${manifest}  ${log.err.error("✗")}  ${alias}: ${source}  differs — the command writes ${to}`);
    } else {
      outLine(`${manifest}  ${log.ok("→")}  ${alias}: ${source} → ${log.ok(to)}${argv.dryRun ? log.dim("  (dry-run)") : ""}`);
    }
  }
  for (const { alias, source, reason } of forms.keptRelative) {
    const verdict = isLocalPathSource(source) ? "kept relative" : "written relative";
    outErrLine(`${manifest}  ${log.err.warn("·")}  ${alias}: ${source}  ${verdict} — ${reason}`);
  }
  for (const { alias, source, message } of forms.errors) {
    const what = alias !== undefined ? `${alias}: ${source}  ` : "";
    outErrLine(`${manifest}  ${log.err.error("✗")}  ${what}${message}`);
  }
}

export async function releaseImportsCommand(argv: {
  paths: string[];
  as: ImportForm;
  check: boolean;
  dryRun: boolean;
  registry?: string;
}): Promise<void> {
  const result = await releaseImports({
    paths: argv.paths,
    as: argv.as,
    check: argv.check,
    dryRun: argv.dryRun,
    rungs: {
      ...(argv.registry ? { flag: argv.registry } : {}),
      ...(process.env.TELO_OCI_REGISTRY ? { env: process.env.TELO_OCI_REGISTRY } : {}),
    },
  });
  outEmit(result);
  if (!result.ok) process.exitCode = 1;
}
