/**
 * The `helm` ecosystem's evidence half.
 *
 * Its layer is the chart `helm package` builds — the file set the chart's
 * `.helmignore` admits, with the `Chart.yaml` helm writes — unpacked and
 * digested, so the number is the one a chart pulled back from its OCI registry
 * gives, the planner's own bookkeeping (`.changes/`) left out of both. It publishes to `<registry>/<Chart.yaml name>`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AnchorRef, EvidenceAdapter, EvidenceSession, ReadBack } from "../evidence.js";
import { digestFileSet, withoutBookkeeping, type FileSetEntry } from "../files-digest.js";
import { readTarGz, stripPrefix } from "../tar.js";
import type { ReleaseWorkspace } from "../workspace.js";

function helm(args: string[], what: string): { status: number; stderr: string } {
  const run = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`${what}: helm could not start (${run.error.message}). Install Helm 3.8 or later.`);
  return { status: run.status ?? 1, stderr: (run.stderr || run.stdout).trim() };
}

/** The one `.tgz` a helm command wrote into a scratch directory, read. */
function withScratch<T>(body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telorun-release-helm-"));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function chartFiles(dir: string, chart: string, where: string): FileSetEntry[] {
  const tarballs = fs.readdirSync(dir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`${where}: helm wrote ${tarballs.length} charts, expected one.`);
  return stripPrefix(readTarGz(fs.readFileSync(path.join(dir, tarballs[0]!)), where), chart, where);
}

export const helmEvidence: EvidenceAdapter = {
  ecosystem: "helm",
  needsDestination: true,
  async open(workspace: ReleaseWorkspace): Promise<EvidenceSession> {
    const destination = (ref: AnchorRef): string | undefined => {
      const registry = ref.anchor.settings.registry;
      return typeof registry === "string" && ref.anchor.package.name
        ? `${registry.replace(/\/+$/, "")}/${ref.anchor.package.name}`
        : undefined;
    };
    return {
      async collect(ref) {
        const chart = ref.anchor.package.name!;
        const entries = withScratch((dir) => {
          const run = helm(["package", path.join(workspace.root, ref.anchor.dir), "--destination", dir], ref.unit.key);
          if (run.status !== 0) throw new Error(`${ref.unit.key}: \`helm package\` failed: ${run.stderr}`);
          return withoutBookkeeping(chartFiles(dir, chart, `${ref.unit.key}'s packaged chart`), ref.anchor.dir);
        });
        return {
          layer: digestFileSet(entries),
          files: entries.map((entry) => (ref.anchor.dir === "" ? entry.path : `${ref.anchor.dir}/${entry.path}`)),
        };
      },
      async imports() {
        return [];
      },
      destination,
      async readBack(ref, version, recorded): Promise<ReadBack> {
        const chartRef = destination(ref);
        if (!chartRef) return { kind: "unverifiable", reason: "no registry names where the chart is published" };
        return withScratch((dir) => {
          const run = helm(["pull", chartRef, "--version", version, "--destination", dir], ref.unit.key);
          if (run.status !== 0) {
            if (/not found|404|manifest unknown/i.test(run.stderr)) return { kind: "absent" } as const;
            throw new Error(`${ref.unit.key}: \`helm pull ${chartRef} --version ${version}\` failed: ${run.stderr}`);
          }
          const layer = digestFileSet(
            withoutBookkeeping(chartFiles(dir, ref.anchor.package.name!, `${chartRef}:${version}`), ref.anchor.dir),
          );
          return { kind: "published", layer, drift: recorded !== undefined && recorded !== layer ? [`helm/${ref.anchor.anchor}`] : [] } as const;
        });
      },
    };
  },
};
