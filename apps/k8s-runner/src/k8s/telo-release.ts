import { randomUUID } from "node:crypto";

import { SupervisorClient, type SupervisorRunEnding, type SupervisorTermination } from "@telorun/runner-core";

import { RELEASES_DIR } from "./pod-spec.js";

/** Where the binary of telo `version` is kept in the apps container. */
export function teloBinaryPath(version: string): string {
  return `${RELEASES_DIR}/${version}/telo`;
}

/**
 * Downloads one release into its own directory and checks it against the
 * release's `checksums.txt` before it is moved into place, so a path that exists
 * holds verified bytes and a half-written download is never one. It runs in the
 * apps container (node, tar), whose image the session picked, and does nothing
 * when the version is already there — the directory is on the session volume,
 * so a resumed session finds it.
 */
const FETCH_SCRIPT = `
const crypto = require("crypto"), fs = require("fs"), cp = require("child_process");
const [version, base, dir] = process.argv.slice(1);
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
const musl = !process.report.getReport().header.glibcVersionRuntime;
const target = "linux-" + arch + "-" + (musl ? "musl" : "gnu");
const asset = "telo-" + version + "-" + target + ".tar.gz";
const get = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP " + response.status + " at " + url);
  return Buffer.from(await response.arrayBuffer());
};
(async () => {
  if (fs.existsSync(dir + "/telo")) return;
  if (!arch || target === "linux-arm64-musl") throw new Error("no telo binary is published for " + process.platform + "-" + process.arch + (musl ? "-musl" : ""));
  const url = base + "/v" + version;
  const archive = await get(url + "/" + asset);
  const sums = (await get(url + "/checksums.txt")).toString();
  const expected = sums.split("\\n").map((l) => l.trim().split(/\\s+/)).find((p) => (p[1] || "").replace(/^\\*/, "") === asset);
  if (!expected) throw new Error("checksums.txt beside " + asset + " does not list it, so it cannot be verified");
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (actual !== expected[0]) throw new Error("checksum mismatch for " + asset + ": expected " + expected[0] + ", got " + actual);
  const partial = dir + ".partial";
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(partial + "/archive.tar.gz", archive);
  cp.execFileSync("tar", ["-xzf", partial + "/archive.tar.gz", "-C", partial, "--strip-components=1"]);
  fs.rmSync(partial + "/archive.tar.gz");
  fs.chmodSync(partial + "/telo", 0o755);
  fs.renameSync(partial, dir);
})().catch((err) => { console.error(err.message); process.exit(1); });
`;

export interface TeloFetcherAddress {
  host: string;
  port: number;
  token: string;
}

/**
 * Fetches telo releases through the supervisor of the apps container's tooling
 * slot. It is a raw supervisor client, not an app slot: what it runs is the
 * runner's own task, so it reports no app state and no app output.
 */
export class TeloReleaseFetcher {
  private readonly client: SupervisorClient;
  private queue: Promise<unknown> = Promise.resolve();
  private current:
    | { runId: string; output: string; done: (ending: SupervisorRunEnding | Error) => void }
    | undefined;

  constructor(
    address: TeloFetcherAddress,
    private readonly releasesUrl: string,
    onTerminated: (termination: SupervisorTermination) => void,
  ) {
    this.client = new SupervisorClient({
      ...address,
      listener: {
        onConnected: () => {},
        onStarted: () => {},
        onExited: (ending) => {
          if (this.current?.runId === ending.runId) this.current.done(ending);
        },
        onFailed: (runId, reason) => {
          if (this.current?.runId === runId) this.current.done(new Error(reason));
        },
        onRefused: () => {},
        onOutput: (chunk) => {
          if (this.current) this.current.output += chunk.toString("utf8");
        },
        onGap: () => {},
        onDisconnected: () => {},
        onTerminated,
      },
    });
  }

  async connect(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the apps container's tooling supervisor did not answer within ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([this.client.connect(), timeout]);
    } catch (err) {
      await this.client.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The binary's path once telo `version` is in the container; fetches are
   *  serialized, since the tooling slot runs one thing at a time. */
  ensure(version: string): Promise<string> {
    const result = this.queue.then(() => this.fetch(version));
    this.queue = result.catch(() => {});
    return result;
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private async fetch(version: string): Promise<string> {
    const runId = randomUUID();
    const finished = new Promise<SupervisorRunEnding | Error>((resolve) => {
      this.current = { runId, output: "", done: resolve };
    });
    try {
      await this.client.run({
        runId,
        argv: ["node", "-e", FETCH_SCRIPT, version, this.releasesUrl, `${RELEASES_DIR}/${version}`],
        env: {},
        cwd: ".",
        io: "streams",
      });
      const ending = await finished;
      const output = this.current?.output.trim() ?? "";
      if (ending instanceof Error) throw new Error(ending.message);
      if (ending.code !== 0) {
        throw new Error(
          `fetching telo ${version} from ${this.releasesUrl} failed` +
            (output ? `: ${output}` : ` (${ending.signal ?? `exit ${ending.code}`})`),
        );
      }
      return teloBinaryPath(version);
    } finally {
      this.current = undefined;
    }
  }
}
