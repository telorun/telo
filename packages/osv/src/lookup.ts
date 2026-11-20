import { AdvisoryLookupError } from "./advisory-lookup-error.js";
import { LOOKUP_BUDGET_MS, osvRequest, type LookupRuntime } from "./osv-request.js";
import { isChecked, OSV_ECOSYSTEMS, osvPackageName, purlType } from "./purl-types.js";
import { stripTrailingSlashes } from "./repository-address.js";
import { sameRepository, vcsEcosystem, vcsRepository } from "./vcs-tools.js";

export const DEFAULT_OSV_URL = "https://api.osv.dev";
/** OSV's limit on queries in one `querybatch` request. */
export const BATCH_LIMIT = 1000;
const RECORD_CONCURRENCY = 8;

/** The repository and commit a component is built from. */
export interface ComponentVcs {
  /** `git+https://<host>/<path>`, no revision. */
  url: string;
  /** The full commit id; the caller has proven it reachable from a branch or tag of `url`. */
  revision: string;
}

export interface ComponentInput {
  /** The package URL without a version, never carrying `vcs_url`. */
  purl: string;
  version: string;
  vcs?: ComponentVcs;
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  /** As OSV records it; may be empty. */
  severity: { type: string; score: string }[];
  /** `purl@version` of the affected component. */
  component: string;
  /** Versions of the component's package that fix it, from the advisory's affected ranges;
   *  for an advisory matched by the component's revision alone, the `fixed` commits of
   *  the ranges recorded against its repository. */
  fixed: string[];
  /** What matched it: the component's package and version, or its revision alone. */
  matchedBy: "version" | "revision";
}

export interface ComponentAnswer {
  purl: string;
  version: string;
  vcs?: ComponentVcs;
  /** True when OSV matches the package type by version, or matches the component's
   *  revision in a repository it records; otherwise `advisories` is empty and no verdict. */
  checked: boolean;
  advisories: Advisory[];
}

export interface LookupOptions {
  /** The OSV endpoint; `https://api.osv.dev` when omitted. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Aborting it rejects the lookup with a `LookupCancelledError`, at once, mid-request or mid-backoff. */
  signal?: AbortSignal;
}

interface OsvRecord {
  id: string;
  aliases?: unknown;
  summary?: unknown;
  severity?: unknown;
  affected?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The package URL with its version, which goes before any qualifiers or subpath. */
function componentOf(input: ComponentInput): string {
  const cut = input.purl.search(/[?#]/);
  const head = cut < 0 ? input.purl : input.purl.slice(0, cut);
  const tail = cut < 0 ? "" : input.purl.slice(cut);
  return `${head}@${encodeURIComponent(input.version)}${tail}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizePurl(purl: string): string {
  try {
    return decodeURIComponent(purl).toLowerCase();
  } catch {
    return purl.toLowerCase();
  }
}

function fixedVersions(record: OsvRecord, purl: string): string[] {
  const type = purlType(purl);
  const ecosystem = type === undefined ? undefined : OSV_ECOSYSTEMS[type];
  const name = osvPackageName(purl);
  const fixed: string[] = [];
  for (const entry of Array.isArray(record.affected) ? record.affected : []) {
    if (!isObject(entry) || !isObject(entry.package)) continue;
    const pkg = entry.package;
    const byPurl = typeof pkg.purl === "string" && normalizePurl(pkg.purl) === normalizePurl(purl);
    const byName =
      typeof pkg.ecosystem === "string" &&
      pkg.ecosystem.split(":", 1)[0] === ecosystem &&
      pkg.name === name;
    if (!byPurl && !byName) continue;
    for (const range of Array.isArray(entry.ranges) ? entry.ranges : []) {
      if (!isObject(range) || range.type === "GIT") continue;
      for (const event of Array.isArray(range.events) ? range.events : []) {
        if (isObject(event) && typeof event.fixed === "string" && !fixed.includes(event.fixed)) {
          fixed.push(event.fixed);
        }
      }
    }
  }
  return fixed;
}

function fixedCommits(record: OsvRecord, repository: string): string[] {
  const fixed: string[] = [];
  for (const entry of Array.isArray(record.affected) ? record.affected : []) {
    if (!isObject(entry)) continue;
    for (const range of Array.isArray(entry.ranges) ? entry.ranges : []) {
      if (!isObject(range) || range.type !== "GIT" || typeof range.repo !== "string") continue;
      if (!sameRepository(range.repo, repository)) continue;
      for (const event of Array.isArray(range.events) ? range.events : []) {
        if (isObject(event) && typeof event.fixed === "string" && !fixed.includes(event.fixed)) {
          fixed.push(event.fixed);
        }
      }
    }
  }
  return fixed;
}

function shape(record: OsvRecord, input: ComponentInput, byRevisionOnly: boolean): Advisory {
  const severity: Advisory["severity"] = [];
  for (const entry of Array.isArray(record.severity) ? record.severity : []) {
    if (isObject(entry) && typeof entry.type === "string" && typeof entry.score === "string") {
      severity.push({ type: entry.type, score: entry.score });
    }
  }
  return {
    id: record.id,
    aliases: strings(record.aliases),
    summary: typeof record.summary === "string" ? record.summary : "",
    severity,
    component: componentOf(input),
    fixed: byRevisionOnly && input.vcs ? fixedCommits(record, vcsRepository(input.vcs.url)) : fixedVersions(record, input.purl),
    matchedBy: byRevisionOnly ? "revision" : "version",
  };
}

function malformed(url: string, what: string): AdvisoryLookupError {
  return new AdvisoryLookupError(url, 1, `the answer is not what OSV documents (${what})`);
}

type OsvQuery =
  | { package: { purl: string } }
  | { package: { ecosystem: string; name: string } }
  | { commit: string };

/**
 * Sends every query through `querybatch`, chunked at OSV's limit, following each
 * query's page tokens — until none is left, or, with `firstHit`, until a page
 * names an advisory. Resolves with each query's advisory ids, in order.
 */
async function runQueries(
  runtime: LookupRuntime,
  batchUrl: string,
  queries: readonly OsvQuery[],
  options: { firstHit?: boolean } = {},
): Promise<string[][]> {
  const ids: string[][] = queries.map(() => []);
  let pending = queries.map((_, index) => ({ index, token: undefined as string | undefined }));
  while (pending.length > 0) {
    const next: typeof pending = [];
    for (let start = 0; start < pending.length; start += BATCH_LIMIT) {
      const chunk = pending.slice(start, start + BATCH_LIMIT);
      const body = {
        queries: chunk.map(({ index, token }) => ({ ...queries[index], ...(token === undefined ? {} : { page_token: token }) })),
      };
      const answer = await osvRequest(runtime, batchUrl, { method: "POST", body });
      const results = isObject(answer) ? answer.results : undefined;
      if (!Array.isArray(results) || results.length !== chunk.length) throw malformed(batchUrl, "`results` does not match the queries sent");
      results.forEach((result, position) => {
        const { index } = chunk[position]!;
        if (!isObject(result)) throw malformed(batchUrl, "a result is not an object");
        for (const vuln of Array.isArray(result.vulns) ? result.vulns : []) {
          if (!isObject(vuln) || typeof vuln.id !== "string") throw malformed(batchUrl, "a vulnerability has no id");
          if (!ids[index]!.includes(vuln.id)) ids[index]!.push(vuln.id);
        }
        if (options.firstHit && ids[index]!.length > 0) return;
        if (typeof result.next_page_token === "string" && result.next_page_token !== "") {
          next.push({ index, token: result.next_page_token });
        }
      });
    }
    pending = next;
  }
  return ids;
}

/**
 * Looks up every component against OSV. Resolves with one answer per input, in order;
 * rejects with an `AdvisoryLookupError` when any request fails after its retries, so
 * an answer is never partial.
 *
 * A component with `vcs` whose tool OSV matches is checked by its revision when OSV
 * names its repository in at least one record (one probe per distinct repository,
 * a package query with no version); its advisories are then the answer to a
 * commit query, added to the purl-and-version answer when the purl's type is
 * matched too. That the revision is in the repository's history is the caller's
 * to prove before calling.
 */
export async function lookupAdvisories(
  components: readonly ComponentInput[],
  options: LookupOptions = {},
): Promise<ComponentAnswer[]> {
  const base = stripTrailingSlashes(options.baseUrl ?? DEFAULT_OSV_URL);
  const now = options.now ?? Date.now;
  const runtime: LookupRuntime = {
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now,
    random: options.random ?? Math.random,
    deadline: now() + LOOKUP_BUDGET_MS,
    signal: options.signal,
  };
  const batchUrl = `${base}/v1/querybatch`;

  // Which repositories OSV records: the first page naming any advisory is enough.
  const repositories = new Map<string, string>();
  for (const component of components) {
    const ecosystem = component.vcs ? vcsEcosystem(component.vcs.url) : undefined;
    if (ecosystem !== undefined) repositories.set(`${ecosystem}\0${vcsRepository(component.vcs!.url)}`, ecosystem);
  }
  const probed = [...repositories];
  const probeIds = await runQueries(
    runtime,
    batchUrl,
    probed.map(([key, ecosystem]) => ({ package: { ecosystem, name: key.slice(ecosystem.length + 1) } })),
    { firstHit: true },
  );
  const recorded = new Set(probed.filter((_, index) => probeIds[index]!.length > 0).map(([key]) => key));
  const byRevision = (component: ComponentInput): boolean => {
    const ecosystem = component.vcs ? vcsEcosystem(component.vcs.url) : undefined;
    return ecosystem !== undefined && recorded.has(`${ecosystem}\0${vcsRepository(component.vcs!.url)}`);
  };

  const answers: ComponentAnswer[] = components.map((c) => ({
    purl: c.purl,
    version: c.version,
    ...(c.vcs ? { vcs: { url: c.vcs.url, revision: c.vcs.revision } } : {}),
    checked: isChecked(c.purl) || byRevision(c),
    advisories: [],
  }));

  const queries: Array<{ index: number; byRevision: boolean; query: OsvQuery }> = [];
  components.forEach((component, index) => {
    if (isChecked(component.purl)) queries.push({ index, byRevision: false, query: { package: { purl: componentOf(component) } } });
    if (byRevision(component)) queries.push({ index, byRevision: true, query: { commit: component.vcs!.revision } });
  });
  const found = await runQueries(runtime, batchUrl, queries.map((entry) => entry.query));
  const byVersion: Array<Set<string>> = components.map(() => new Set());
  const ids: string[][] = components.map(() => []);
  queries.forEach((entry, position) => {
    for (const id of found[position]!) {
      if (!entry.byRevision) byVersion[entry.index]!.add(id);
      if (!ids[entry.index]!.includes(id)) ids[entry.index]!.push(id);
    }
  });

  const records = new Map<string, OsvRecord>();
  const queue = [...new Set(ids.flat())];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const url = `${base}/v1/vulns/${encodeURIComponent(id)}`;
      const record = await osvRequest(runtime, url, { method: "GET" });
      if (!isObject(record) || typeof record.id !== "string") throw malformed(url, "the record has no id");
      records.set(id, record as unknown as OsvRecord);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECORD_CONCURRENCY, queue.length) }, worker));

  answers.forEach((answer, index) => {
    answer.advisories = ids[index]!.map((id) => shape(records.get(id)!, components[index]!, !byVersion[index]!.has(id)));
  });
  return answers;
}
