/**
 * Whether a commit is in a git repository's history — reachable from one of its
 * branches or tags — read over git's smart HTTP protocol (version 2) with no
 * local git: the refs are listed (`ls-refs`), then every branch and tag tip is
 * fetched with `filter tree:0`, so the pack holds commits and nothing else, and
 * the commit is reachable exactly when the pack holds it. A host serving a
 * commit by id is no proof: GitHub answers a fork network's commits through
 * every repository of the network.
 *
 * Every request follows the kernel's egress policy (`TELO_EGRESS`), and every
 * answer is bounded: in bytes, per object, and in time for the whole read.
 */

import { assertPublicEgress } from "@telorun/kernel";
import { PackBoundError, packCommitIds, type ObjectFormat } from "./git-pack-commits.js";
import { concatBytes, DELIM_PKT, excerpt, FLUSH_PKT, pktLine, PktLineReader, pktText, readPktLines } from "./pkt-line.js";

const ATTEMPTS = 3;
const REFS_TIMEOUT_MS = 30_000;
const PACK_TIMEOUT_MS = 180_000;
const BACKOFF_MS = 500;
const MIB = 1024 * 1024;
/** The largest answer to `info/refs` or `ls-refs`. */
export const MAX_REFS_BYTES = 16 * MIB;
/** The largest answer to `fetch`: the commits of every branch and tag. */
export const MAX_PACK_BYTES = 1024 * MIB;
/** The longest one repository's read may take, every request and retry included. */
export const READ_BUDGET_MS = 600_000;
/** The most redirects `info/refs` may take, as for a staged archive. */
export const MAX_REDIRECTS = 10;

/** The host gave no history: it refused the protocol, broke a bound, or failed after retries. */
export class RepositoryUnreadableError extends Error {
  constructor(
    readonly repository: string,
    readonly host: string,
    readonly detail: string,
  ) {
    super(`${host} gave no history of ${repository}: ${detail}`);
    this.name = "RepositoryUnreadableError";
  }
}

export interface CommitHistoryOptions {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Overrides the bounds, for tests. */
  readonly limits?: Partial<{ refsBytes: number; packBytes: number; readBudgetMs: number }>;
}

interface Advertised {
  /** Where the commands go: the repository's address after the host's redirects, as git uses it. */
  readonly base: string;
  readonly format: ObjectFormat;
}

/** One repository's answer, kept for every revision asked of it in one run. */
interface History {
  readonly tips: Set<string>;
  readonly commits: Set<string>;
}

/** The HTTPS address of a `vcs-url` location: the location without `git+`. */
export function repositoryAddress(vcsUrl: string): string {
  return vcsUrl.replace(/^git\+/, "");
}

/** A refusal no retry changes. */
class Refusal extends Error {}

/** One repository's read: the deadline every request and retry of it shares. */
interface Read {
  readonly budget: AbortSignal;
  readonly budgetMs: number;
}

const httpsProblem = (url: string): string | undefined => {
  try {
    return new URL(url).protocol === "https:" ? undefined : "it is not an https address";
  } catch {
    return "it is not an absolute address";
  }
};

/** Reads repositories' histories, each at most once per instance. */
export class CommitHistoryReader {
  private readonly histories = new Map<string, Promise<History>>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refsBytes: number;
  private readonly packBytes: number;
  private readonly readBudgetMs: number;

  constructor(options: CommitHistoryOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.refsBytes = options.limits?.refsBytes ?? MAX_REFS_BYTES;
    this.packBytes = options.limits?.packBytes ?? MAX_PACK_BYTES;
    this.readBudgetMs = options.limits?.readBudgetMs ?? READ_BUDGET_MS;
  }

  /** Whether `revision` is reachable from a branch or tag of `vcsUrl`; throws a
   *  `RepositoryUnreadableError` when the host gives no history. */
  async reachable(vcsUrl: string, revision: string): Promise<boolean> {
    const repository = repositoryAddress(vcsUrl);
    let history = this.histories.get(repository);
    if (!history) {
      history = this.read(repository);
      this.histories.set(repository, history);
    }
    const { tips, commits } = await history;
    return tips.has(revision) || commits.has(revision);
  }

  private async read(repository: string): Promise<History> {
    const problem = httpsProblem(repository);
    if (problem) throw new RepositoryUnreadableError(repository, repository, problem);
    const host = new URL(repository).host;
    const read: Read = { budget: AbortSignal.timeout(this.readBudgetMs), budgetMs: this.readBudgetMs };
    try {
      const advertised = await this.advertisement(repository, read);
      const tips = await this.listTips(advertised, read);
      if (tips.size === 0) return { tips, commits: new Set() };
      const commits = await this.commits(advertised, tips, read);
      return { tips, commits };
    } catch (error) {
      if (error instanceof RepositoryUnreadableError) throw error;
      const detail = read.budget.aborted
        ? `reading its history took longer than the ${read.budgetMs / 1000} s limit on one repository`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new RepositoryUnreadableError(repository, host, detail);
    }
  }

  /** One request, retried on a network error, a 5xx or a 429; its answer is the
   *  response, unread. The egress policy is applied before it goes out. */
  private async send(
    url: string,
    init: { body?: Uint8Array; timeoutMs: number; redirect: "manual" | "error" },
    read: Read,
  ): Promise<Response> {
    let detail = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await assertPublicEgress(url);
      } catch (error) {
        throw new Refusal(`the request to ${url} was refused: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const response = await this.fetchImpl(url, {
          method: init.body ? "POST" : "GET",
          headers: {
            "Git-Protocol": "version=2",
            "User-Agent": "git/2.47.0 (telo)",
            ...(init.body
              ? { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result" }
              : {}),
          },
          body: init.body as Uint8Array<ArrayBuffer> | undefined,
          redirect: init.redirect,
          signal: AbortSignal.any([AbortSignal.timeout(init.timeoutMs), read.budget]),
        });
        if (response.ok) return response;
        const redirected = response.status >= 300 && response.status < 400;
        if (redirected && init.redirect === "manual") return response;
        await response.body?.cancel();
        if (redirected) throw new Refusal(`${url} answered with a redirect, which git follows only for info/refs`);
        const status = `HTTP ${response.status}${response.statusText ? ` ${excerpt(response.statusText)}` : ""}`;
        if (response.status !== 429 && response.status < 500) throw new Refusal(`${url} answered ${status}`);
        detail = `${url} answered ${status}`;
      } catch (error) {
        if (error instanceof Refusal || read.budget.aborted) throw error;
        const cause = (error as { cause?: unknown }).cause;
        const causeText = cause instanceof Error ? cause.message : "";
        if (init.redirect === "error" && /redirect/i.test(causeText)) {
          throw new Refusal(`${url} answered with a redirect, which git follows only for info/refs`);
        }
        detail = `${url}: ${error instanceof Error ? error.message : String(error)}${causeText ? ` (${causeText})` : ""}`;
      }
      if (attempt < ATTEMPTS) await this.sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw new Error(`no answer after ${ATTEMPTS} attempts, the last: ${detail}`);
  }

  /** Every chunk of `response`'s body, refusing it once it passes `maxBytes`. */
  private async *chunks(response: Response, url: string, maxBytes: number): AsyncGenerator<Uint8Array> {
    const limit = maxBytes % MIB === 0 ? `${maxBytes / MIB} MiB` : `${maxBytes}-byte`;
    const tooLarge = () => new Refusal(`the answer of ${url} is larger than the ${limit} limit`);
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) return;
    let total = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw tooLarge();
        yield chunk.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async bytes(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.chunks(response, url, maxBytes)) parts.push(chunk);
    return concatBytes(parts);
  }

  /** `info/refs`, following the host's redirects one hop at a time, each to an https address. */
  private async advertisement(repository: string, read: Read): Promise<Advertised> {
    const suffix = "/info/refs?service=git-upload-pack";
    let url = `${repository}${suffix}`;
    let response: Response;
    for (let hops = 0; ; hops++) {
      response = await this.send(url, { timeoutMs: REFS_TIMEOUT_MS, redirect: "manual" }, read);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || location === null) break;
      await response.body?.cancel();
      if (hops === MAX_REDIRECTS) throw new Refusal(`info/refs was redirected more than ${MAX_REDIRECTS} times`);
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        throw new Refusal("info/refs was redirected to an address that does not read");
      }
      const problem = httpsProblem(next);
      if (problem) throw new Refusal(`info/refs was redirected to ${excerpt(next)}: ${problem}`);
      url = next;
    }
    if (!response.ok) throw new Refusal(`${url} answered HTTP ${response.status} with no address to follow`);
    const base = url.endsWith(suffix) ? url.slice(0, -suffix.length) : repository;
    const lines = readPktLines(await this.bytes(response, url, this.refsBytes))
      .map(pktText)
      .filter((line): line is string => line !== undefined && !line.startsWith("# service="));
    if (lines[0] !== "version 2") {
      throw new Error("it does not speak version 2 of git's protocol, which reading commits alone needs");
    }
    const fetchLine = lines.find((line) => line === "fetch" || line.startsWith("fetch="));
    const format = lines.find((line) => line.startsWith("object-format="))?.slice("object-format=".length) ?? "sha1";
    if (!lines.some((line) => line === "ls-refs" || line.startsWith("ls-refs="))) throw new Error("it offers no ls-refs command");
    if (!fetchLine) throw new Error("it offers no fetch command");
    if (format !== "sha1" && format !== "sha256") throw new Error(`its object format '${excerpt(format)}' is not one git defines`);
    if (!fetchLine.slice("fetch=".length).split(" ").includes("filter")) {
      throw new Error("it offers no filter, so its history cannot be read without every file");
    }
    return { base, format };
  }

  private command(name: string, format: ObjectFormat, args: readonly string[]): Uint8Array {
    return concatBytes([
      pktLine(`command=${name}\n`),
      pktLine(`object-format=${format}\n`),
      DELIM_PKT,
      ...args.map((arg) => pktLine(`${arg}\n`)),
      FLUSH_PKT,
    ]);
  }

  /** The commit each branch and tag names, a tag peeled to its commit. */
  private async listTips(advertised: Advertised, read: Read): Promise<Set<string>> {
    const body = this.command("ls-refs", advertised.format, ["peel", "ref-prefix refs/heads/", "ref-prefix refs/tags/"]);
    const url = `${advertised.base}/git-upload-pack`;
    const response = await this.send(url, { body, timeoutMs: REFS_TIMEOUT_MS, redirect: "error" }, read);
    const idLength = advertised.format === "sha1" ? 40 : 64;
    const tips = new Set<string>();
    let position = 0;
    for (const line of readPktLines(await this.bytes(response, url, this.refsBytes))) {
      const text = pktText(line);
      if (text === undefined) continue;
      position++;
      const [id, , ...attributes] = text.split(" ");
      const peeled = attributes.find((attribute) => attribute.startsWith("peeled:"))?.slice("peeled:".length);
      const tip = peeled ?? id;
      if (!tip || tip.length !== idLength || !/^[0-9a-f]+$/.test(tip)) {
        throw new Error(`listed ref ${position} (${text.length} characters) is not '<id> <name>'`);
      }
      tips.add(tip);
    }
    return tips;
  }

  private async commits(advertised: Advertised, tips: Set<string>, read: Read): Promise<Set<string>> {
    const body = this.command("fetch", advertised.format, [
      "no-progress",
      "ofs-delta",
      "filter tree:0",
      ...[...tips].map((tip) => `want ${tip}`),
      "done",
    ]);
    const url = `${advertised.base}/git-upload-pack`;
    const response = await this.send(url, { body, timeoutMs: PACK_TIMEOUT_MS, redirect: "error" }, read);
    const pack: Uint8Array[] = [];
    const lines = new PktLineReader();
    let inPack = false;
    let ended = false;
    for await (const chunk of this.chunks(response, url, this.packBytes)) {
      for (const line of lines.push(chunk)) {
        if (ended) continue;
        if (line.kind !== "data") {
          if (inPack && line.kind === "flush") ended = true;
          continue;
        }
        if (!inPack) {
          if (pktText(line) === "packfile") inPack = true;
          continue;
        }
        const band = line.payload[0];
        if (band === 1) pack.push(line.payload.subarray(1));
        else if (band === 3) throw new Refusal(`it refused the fetch: ${excerpt(new TextDecoder().decode(line.payload.subarray(1)))}`);
      }
    }
    lines.end();
    if (!inPack) throw new Error("its answer to the fetch holds no packfile");
    try {
      return packCommitIds(concatBytes(pack), advertised.format);
    } catch (error) {
      if (error instanceof PackBoundError) throw new Error(`its pack breaks a bound: ${error.message}`);
      throw new Error(`its pack does not read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
