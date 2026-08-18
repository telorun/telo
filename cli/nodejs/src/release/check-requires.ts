/**
 * Workspace-wide verification of declared `requires.telo` ranges — the CI half of
 * declared runtime requirements.
 *
 * The same property `verify-requires.ts` proves per module, proven for every
 * module at once and batched by edge: `telo check` takes many manifest paths, so
 * modules sharing an edge share one CLI invocation. Across a standard library
 * declaring one or two distinct lower bounds that is one or two runs, not sixty.
 *
 * It lives in `telo release check` rather than behind a new verb because that is
 * already the modules-in-a-workspace gate and this is a module-level claim. A
 * third party with no `telo-workspace.yaml` still gets the check at publish; the
 * two callers are the same function applied to different scopes.
 *
 * **Transitive propagation costs nothing.** In-repo modules import siblings by
 * relative path, so an old CLI checking a dependent reads the working copy of its
 * dependency. When a sibling adopts new syntax, every dependent fails its own
 * edge check until its range moves. Nothing walks a graph — the check is the
 * walk.
 *
 * **A forward-declared edge is not a failure here.** A module adopting new syntax
 * declares the release that will carry it, and on the commit that does so that
 * release does not exist yet — which is the point of declaring the bound before
 * it. Such an edge is reported `pending` and never runs; `publish` is where it
 * becomes fatal, by which time npm has published and the version exists.
 */

import { lowerBound, readRequires, upperBound } from "@telorun/analyzer";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags } from "@telorun/templating";

import { publishedTeloVersions, unreleasedEdge } from "./verify-requires.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

const run = promisify(execFile);

/** Generous by design: an edge CLI is fetched on first use. Bounds a hang, does
 *  not pace the work. */
const EDGE_TIMEOUT_MS = 600_000;

export interface EdgeCheck {
  /** The telo version the manifests below were checked with. */
  edge: string;
  /** Module keys checked at this edge. */
  modules: string[];
  /** `pending` means the edge names a version newer than anything published, so
   *  there was nothing to install — see `unreleasedEdge`. It is informational
   *  here and fatal at publish. */
  status: "passed" | "failed" | "pending" | "unavailable";
  detail?: string;
}

export interface CheckRequiresResult {
  checks: EdgeCheck[];
  /** True when an edge CLI ran and rejected manifests — the declarations are
   *  false and CI must fail. An `unavailable` edge is unproven, not disproven. */
  refuted: boolean;
}

/** The edges a module's declared range must be verified at, or `[]` when it
 *  declares nothing. The high edge of an open range is HEAD, which the ordinary
 *  check already covers, so only a closed bound contributes one. */
function edgesFor(module: DiscoveredModule, currentVersion: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(module.manifestPath, "utf8");
  } catch {
    return [];
  }
  let doc: Record<string, unknown> | undefined;
  try {
    const docs = parseAllDocuments(text, { customTags: defaultCustomTags });
    const owner = docs.find((d) => {
      const kind = d.get("kind");
      return kind === "Telo.Application" || kind === "Telo.Library";
    });
    doc = owner?.toJS() as Record<string, unknown> | undefined;
  } catch {
    return [];
  }
  if (!doc) return [];

  const { block } = readRequires(doc);
  if (!block.telo) return [];

  const edges: string[] = [];
  const low = lowerBound(block.telo);
  const high = upperBound(block.telo);
  // Checking at the version already running is what the ordinary CI check does;
  // spawning a copy of ourselves to learn what we already know is pure latency.
  if (low && low.raw !== currentVersion) edges.push(low.raw);
  if (high && high.raw !== currentVersion && high.raw !== low?.raw) edges.push(high.raw);
  return edges;
}

/**
 * Verify every workspace module against the edges of its own declared range.
 *
 * A module declaring nothing contributes no edge — absent means no requirement,
 * permanently, for everything published before this mechanism existed.
 */
export async function checkWorkspaceRequires(
  workspace: Workspace,
  currentVersion: string,
): Promise<CheckRequiresResult> {
  const byEdge = new Map<string, DiscoveredModule[]>();
  for (const module of workspace.modules) {
    for (const edge of edgesFor(module, currentVersion)) {
      const list = byEdge.get(edge);
      if (list) list.push(module);
      else byEdge.set(edge, [module]);
    }
  }

  // Asked ONCE for the whole workspace, before any edge runs: the normal way new
  // syntax lands is a module declaring the range of the release that will carry
  // it, and until that release ships there is nothing to install. Spawning `npx`
  // at such an edge has one possible outcome, and npm's ETARGET arrives wrapped
  // in install noise indistinguishable from being offline.
  const published = byEdge.size > 0 ? await publishedTeloVersions() : null;

  const checks: EdgeCheck[] = [];
  for (const [edge, modules] of [...byEdge].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const latestPublished = unreleasedEdge(edge, published);
    if (latestPublished !== undefined) {
      checks.push({
        edge,
        modules: modules.map((m) => m.key),
        status: "pending",
        detail: latestPublished,
      });
      continue;
    }
    checks.push(...(await checkEdge(edge, modules)));
  }
  return { checks, refuted: checks.some((c) => c.status === "failed") };
}

/**
 * One edge, batched — then **disambiguated per manifest if the batch fails**.
 *
 * The batch is the fast path and the common one. But a batched non-zero exit
 * says only "this invocation failed", and `telo check` exits non-zero for
 * plenty that is not a false declaration: an argument shape an older CLI's
 * parser does not accept (it would reject the whole `check <paths..>` batch), an
 * unreachable remote import, a pre-existing unrelated error in one manifest.
 * Reporting that as *"telo 0.40.0 rejects 23 modules declaring it"* is exactly
 * the misattribution this mechanism exists to eliminate — reproducing it inside
 * the mechanism would be the worst place for it.
 *
 * So a failed batch is never itself a verdict. Each manifest is re-run alone,
 * and only a module whose OWN run fails, with output naming its manifest, is
 * reported as refuted. Everything else lands in `unavailable` — unproven, which
 * is what a CLI that could not tell us anything actually leaves behind.
 */
async function checkEdge(edge: string, modules: DiscoveredModule[]): Promise<EdgeCheck[]> {
  const batch = await runCheck(edge, modules.map((m) => m.manifestPath));
  if (batch.status === "passed") {
    return [{ edge, modules: modules.map((m) => m.key), status: "passed" }];
  }
  if (batch.status === "unavailable" || modules.length === 1) {
    // A single-module batch is already per-manifest, so its verdict stands as-is.
    if (modules.length === 1 && batch.status === "failed") {
      return [
        {
          edge,
          modules: [modules[0]!.key],
          status: attributable(batch.output, modules[0]!.manifestPath) ? "failed" : "unavailable",
          detail: batch.output,
        },
      ];
    }
    return [
      { edge, modules: modules.map((m) => m.key), status: "unavailable", detail: batch.output },
    ];
  }

  const failed: DiscoveredModule[] = [];
  const passed: DiscoveredModule[] = [];
  const unavailable: Array<{ module: DiscoveredModule; detail: string }> = [];
  const details: string[] = [];

  for (const module of modules) {
    const one = await runCheck(edge, [module.manifestPath]);
    if (one.status === "passed") passed.push(module);
    else if (one.status === "failed" && attributable(one.output, module.manifestPath)) {
      failed.push(module);
      details.push(`${module.key}:\n${one.output}`);
    } else unavailable.push({ module, detail: one.output });
  }

  const out: EdgeCheck[] = [];
  if (passed.length > 0) {
    out.push({ edge, modules: passed.map((m) => m.key), status: "passed" });
  }
  if (failed.length > 0) {
    out.push({ edge, modules: failed.map((m) => m.key), status: "failed", detail: details.join("\n\n") });
  }
  if (unavailable.length > 0) {
    out.push({
      edge,
      modules: unavailable.map((u) => u.module.key),
      status: "unavailable",
      detail: unavailable[0]?.detail,
    });
  }
  return out;
}

type RunOutcome =
  | { status: "passed" }
  | { status: "failed"; output: string }
  | { status: "unavailable"; output: string };

async function runCheck(edge: string, paths: string[]): Promise<RunOutcome> {
  try {
    await run("npx", ["-y", `@telorun/cli@${edge}`, "check", ...paths], {
      timeout: EDGE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: "passed" };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || (e.message ?? "check failed");
    // A non-zero exit from a CLI that RAN is a candidate verdict; anything else
    // — the binary missing, a fetch failure, a timeout — never ran at all.
    return typeof e.code === "number"
      ? { status: "failed", output }
      : { status: "unavailable", output };
  }
}

/** Whether a failing run said anything about the manifest under test. Compared
 *  on a trailing path fragment too, since a CLI renders paths relative to its
 *  own cwd. */
function attributable(output: string, manifestPath: string): boolean {
  if (!output) return false;
  const tail = manifestPath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  return output.includes(manifestPath) || (tail.length > 0 && output.includes(tail));
}
