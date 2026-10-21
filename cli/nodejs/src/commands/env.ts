import { DEFAULT_ENV_FILES, envFileDestination, type EnvFileEntry } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Argv } from "yargs";
import { resolveEnvFiles } from "../env-files.js";
import { readEnvFileIfPresent, warnIfNotIgnored } from "../env-file-writes.js";
import {
  appendEntries,
  entriesMissingFrom,
  envTemplateEntries,
  renderEnvFile,
  type EnvTemplateEntry,
} from "../env-template.js";
import { loadNeedTable } from "../load-need-table.js";
import { createLogger, type Logger } from "../logger.js";
import { buildNeedsReport } from "../needs-report.js";
import { outEmit, outErrLine, outLine, output } from "../output.js";

/**
 * `telo env template <manifest>` — every environment variable the application
 * reads, as commented-out env-file lines, with nothing booted. Printed by
 * default; `--write` adds to the files the application reads — beside the
 * manifest, or in the working directory for a packaged executable — only the
 * variables they do not already mention, never touching a line that is there. Sensitive
 * values go to the last sensitive entry of the workspace's `env.files`, the
 * rest to the last entry that is not — `.env.local` and `.env` by default.
 */
async function runTemplate(argv: { manifest: string; write: boolean }): Promise<void> {
  const log = createLogger(false);
  const loaded = await loadNeedTable(argv.manifest, log, "environment template");
  if (!loaded) return;
  const entries = envTemplateEntries(
    loaded.root,
    buildNeedsReport(loaded.graph, loaded.table),
    loaded.table.environment,
  );
  const appName = String(loaded.root.metadata?.name ?? "the application");

  const onDisk = !/^https?:\/\//.test(loaded.entryPath);
  if (argv.write && !onDisk) {
    refuse(log, `--write needs a manifest on disk; ${loaded.entryPath} is a URL. Print the template instead.`);
    return;
  }
  // Where the application reads its env files: beside the manifest, or — for a
  // packaged executable — the working directory it is started in.
  const directory = loaded.input.packaged
    ? loaded.input.packaged.envAnchor
    : onDisk
      ? fs.statSync(loaded.entryPath).isDirectory()
        ? loaded.entryPath
        : path.dirname(loaded.entryPath)
      : undefined;
  const files = await templateFiles(directory, entries, log);
  if (!files) return;

  if (!argv.write) {
    const texts = files.map((file) => ({ name: file.name, text: renderEnvFile(appName, file.sensitive, entries) }));
    if (output().isJson) {
      output().document({ files: texts });
      return;
    }
    output().raw(texts.map(({ name, text }) => `# ---- ${name} ----\n${text}`).join("\n"));
    return;
  }
  writeTemplate(directory!, appName, entries, files, log);
}

/**
 * The file each kind of value goes to — one that may be committed, then the
 * sensitive one — read from the `env.files` the walk from `directory` finds, or
 * the defaults for a manifest that is not on disk. A kind the template has
 * values for and the workspace has no file for refuses, naming what to declare;
 * one it has nothing for is left out.
 */
async function templateFiles(
  directory: string | undefined,
  entries: readonly EnvTemplateEntry[],
  log: Logger,
): Promise<EnvFileEntry[] | undefined> {
  let declared: readonly EnvFileEntry[] = DEFAULT_ENV_FILES;
  if (directory !== undefined) {
    const resolution = await resolveEnvFiles(directory);
    if (resolution.failed !== undefined) {
      refuse(log, resolution.failed);
      return undefined;
    }
    declared = resolution.entries;
  }
  const files: EnvFileEntry[] = [];
  for (const sensitive of [false, true]) {
    const destination = envFileDestination(declared, sensitive);
    if ("name" in destination) files.push({ name: destination.name, sensitive });
    else if (entries.some((entry) => entry.sensitive === sensitive)) {
      refuse(log, destination.refused);
      return undefined;
    }
  }
  return files;
}

function writeTemplate(
  directory: string,
  appName: string,
  entries: readonly EnvTemplateEntry[],
  files: readonly EnvFileEntry[],
  log: Logger,
): void {
  const written: Array<{ path: string; created: boolean; added: string[] }> = [];
  for (const file of files) {
    const own = entries.filter((entry) => entry.sensitive === file.sensitive);
    if (own.length === 0) continue;
    const target = path.join(directory, file.name);
    const existing = readEnvFileIfPresent(target);
    const missing = existing === undefined ? own : entriesMissingFrom(existing, own);
    if (missing.length > 0) {
      fs.writeFileSync(
        target,
        existing === undefined ? renderEnvFile(appName, file.sensitive, own) : appendEntries(existing, missing),
      );
    }
    written.push({ path: target, created: existing === undefined, added: missing.map((entry) => entry.name) });
  }

  for (const { path: target, created, added } of written) {
    const shown = path.relative(process.cwd(), target) || target;
    if (created) outLine(`created ${shown} with ${added.length} variable${added.length === 1 ? "" : "s"}`);
    else if (added.length > 0) outLine(`added ${added.join(", ")} to ${shown}`);
    else outLine(`${shown} already mentions every variable it holds`);
  }
  for (const file of files) {
    const target = path.join(directory, file.name);
    if (file.sensitive && written.some((entry) => entry.path === target)) warnIfNotIgnored(target, log);
  }
  outEmit({ ok: true, files: written });
}

function refuse(log: Logger, message: string): void {
  outErrLine(`${log.err.error("error")}  ${message}`);
  process.exitCode = 1;
}

export function envCommand(yargs: Argv): Argv {
  return yargs.command(
    "env <subcommand>",
    "Work with the environment files an application reads",
    (y) =>
      y
        .command(
          "template <manifest>",
          "Write every environment variable the application reads as commented-out .env / .env.local lines — secrets and sensitive need fields go to .env.local; nothing is booted",
          (yy) =>
            yy
              .positional("manifest", {
                describe:
                  "Path to the application's manifest, a directory containing telo.yaml, or a packaged executable",
                type: "string",
                demandOption: true,
              })
              .option("write", {
                describe:
                  "Add to the .env and .env.local the application reads (beside the manifest; the working directory for a packaged executable) the variables they do not mention yet, instead of printing",
                type: "boolean",
                default: false,
              }),
          async (argv) => {
            await runTemplate(argv as unknown as { manifest: string; write: boolean });
          },
        )
        .demandCommand(1, "Specify an env subcommand (template)"),
    () => {},
  );
}
