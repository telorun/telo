/**
 * A stand-in git host speaking smart HTTP version 2: it serves `info/refs`, and
 * `ls-refs` and `fetch` on `git-upload-pack`, packing the commits the wants reach
 * (the second one as a delta against the first, so the reader applies deltas).
 * Like a fork network, it also holds a commit no ref of the repository reaches.
 * Its modes misbehave the ways a host may: redirects, refusals, oversized answers.
 */

import { createHash } from "node:crypto";
import * as http from "node:http";
import { deflateSync } from "node:zlib";

export interface FakeCommit {
  readonly id: string;
  readonly text: string;
  readonly parents: readonly string[];
}

function commit(message: string, parents: readonly string[]): FakeCommit {
  const text =
    `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n` +
    parents.map((parent) => `parent ${parent}\n`).join("") +
    `author A <a@example.test> 1700000000 +0000\ncommitter A <a@example.test> 1700000000 +0000\n\n${message}\n`;
  const id = createHash("sha1").update(`commit ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  return { id, text, parents };
}

/** `root` ← `tagged` ← `head` (branch `main`, tag `v1` on `tagged`), and `fork`, a child of `head` no ref names. */
export function fakeHistory() {
  const root = commit("root", []);
  const tagged = commit("tagged", [root.id]);
  const head = commit("head", [tagged.id]);
  const fork = commit("fork", [head.id]);
  return { root, tagged, head, fork, all: [root, tagged, head, fork] };
}

/** Taken before any test replaces the global. */
const realFetch = globalThis.fetch;

const pkt = (text: string | Buffer): Buffer => {
  const payload = typeof text === "string" ? Buffer.from(text) : text;
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
};
const FLUSH = Buffer.from("0000");

/** A pack object's header: its type and inflated size. */
export function header(type: number, size: number): Buffer {
  const bytes = [((type & 7) << 4) | (size & 0x0f) | (size > 0x0f ? 0x80 : 0)];
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0));
    rest >>= 7;
  }
  return Buffer.from(bytes);
}

/** A delta's size encoding. */
export function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value >>= 7;
  } while (value > 0);
  return bytes;
}

/** An OFS_DELTA's distance back to its base. */
export function offsetEncoding(distance: number): Buffer {
  const bytes = [distance & 0x7f];
  let rest = distance >> 7;
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest >>= 7;
  }
  return Buffer.from(bytes);
}

/** A pack of the given objects, each already framed: the header, the count and the trailing checksum added. */
export function packOf(objects: readonly Buffer[]): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length);
  const content = Buffer.concat([Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), count, ...objects]);
  return Buffer.concat([content, createHash("sha1").update(content).digest()]);
}

/** A pack of `commits`: the first whole, each later one an OFS_DELTA copying the
 *  shared `tree …\n` line from the first and inserting the rest. */
function pack(commits: readonly FakeCommit[]): Buffer {
  const parts: Buffer[] = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2]!.writeUInt32BE(commits.length);
  let at = 12;
  let firstOffset = -1;
  let first: Buffer | undefined;
  for (const entry of commits) {
    const body = Buffer.from(entry.text);
    let object: Buffer;
    if (!first) {
      first = body;
      firstOffset = at;
      object = Buffer.concat([header(1, body.length), deflateSync(body)]);
    } else {
      const shared = body.indexOf("\n") + 1;
      const insert = body.subarray(shared);
      const instructions: number[] = [...varint(first.length), ...varint(body.length), 0x90, shared];
      for (let i = 0; i < insert.length; i += 127) {
        const chunk = insert.subarray(i, i + 127);
        instructions.push(chunk.length, ...chunk);
      }
      const delta = Buffer.from(instructions);
      object = Buffer.concat([header(6, delta.length), offsetEncoding(at - firstOffset), deflateSync(delta)]);
    }
    parts.push(object);
    at += object.length;
  }
  const content = Buffer.concat(parts);
  return Buffer.concat([content, createHash("sha1").update(content).digest()]);
}

/** The one repository path the stand-in serves; a redirect is built from it, never from the request. */
const REPOSITORY = "/acme/repo";
const INFO_REFS = "/info/refs?service=git-upload-pack";

export type HostMode =
  | "ok"
  | "version-0"
  | "no-filter"
  | "failing"
  | "missing"
  /** `info/refs` answers at `<repo>.git` only, after a redirect, as GitLab does. */
  | "redirect-git"
  /** `info/refs` redirects to a plain-http address. */
  | "redirect-http"
  /** `ls-refs` answers with a redirect. */
  | "redirect-post"
  /** `info/refs` answers 64 KiB of advertisement, chunked. */
  | "huge";

export class FakeGitHost {
  readonly requests: string[] = [];
  mode: HostMode = "ok";
  private server?: http.Server;
  private base = "";

  constructor(
    private readonly commits: readonly FakeCommit[],
    private readonly refs: Readonly<Record<string, { id: string; peeled?: string }>>,
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => this.answer(req, Buffer.concat(chunks), res));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Every `https://git.test/…` request goes to the stand-in. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = await realFetch(url.replace(/^https:\/\/git\.test/, this.base), init);
    return new Response(await answer.arrayBuffer(), { status: answer.status, headers: answer.headers });
  }) as typeof fetch;

  private answer(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
    this.requests.push(`${req.method} ${req.url}`);
    const send = (status: number, bytes: Buffer) => {
      res.writeHead(status);
      res.end(bytes);
    };
    if (this.mode === "failing") return send(503, Buffer.from(""));
    if (this.mode === "missing") return send(404, Buffer.from("not found"));
    const redirect = (location: string) => {
      res.writeHead(302, { location });
      res.end();
    };
    if (req.method === "GET" && req.url?.endsWith("/info/refs?service=git-upload-pack")) {
      if (this.mode === "redirect-http") return redirect(`http://git.test${REPOSITORY}${INFO_REFS}`);
      if (this.mode === "redirect-git" && !req.url.includes(".git/")) {
        return redirect(`https://git.test${REPOSITORY}.git${INFO_REFS}`);
      }
      if (this.mode === "huge") {
        res.writeHead(200);
        for (let i = 0; i < 64; i++) res.write(pkt(`agent=${"x".repeat(1000)}\n`));
        return void res.end();
      }
      if (this.mode === "version-0") {
        return send(200, Buffer.concat([pkt("# service=git-upload-pack\n"), FLUSH, pkt(`${this.commits[0]!.id} HEAD\0multi_ack\n`), FLUSH]));
      }
      const fetchLine = this.mode === "no-filter" ? "fetch=shallow\n" : "fetch=shallow wait-for-done filter\n";
      return send(
        200,
        Buffer.concat([pkt("version 2\n"), pkt("agent=fake\n"), pkt("ls-refs=unborn\n"), pkt(fetchLine), pkt("object-format=sha1\n"), FLUSH]),
      );
    }
    if (req.method === "POST" && req.url?.endsWith("/git-upload-pack")) {
      if (this.mode === "redirect-post") return redirect(`https://git.test${REPOSITORY}/git-upload-pack`);
      const lines: string[] = [];
      for (let at = 0; at < body.length; ) {
        const length = parseInt(body.subarray(at, at + 4).toString(), 16);
        if (length > 4) lines.push(body.subarray(at + 4, at + length).toString().replace(/\n$/, ""));
        at += length < 4 ? 4 : length;
      }
      if (lines.includes("command=ls-refs")) {
        const listed = Object.entries(this.refs).map(([name, ref]) => pkt(`${ref.id} ${name}${ref.peeled ? ` peeled:${ref.peeled}` : ""}\n`));
        return send(200, Buffer.concat([...listed, FLUSH]));
      }
      if (lines.includes("command=fetch")) {
        if (!lines.includes("filter tree:0")) return send(400, Buffer.from("no filter"));
        const byId = new Map(this.commits.map((entry) => [entry.id, entry]));
        const reached: FakeCommit[] = [];
        const queue = lines.filter((line) => line.startsWith("want ")).map((line) => line.slice(5));
        const seen = new Set<string>();
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const entry = byId.get(id);
          if (!entry || seen.has(id)) continue;
          seen.add(id);
          reached.push(entry);
          queue.push(...entry.parents);
        }
        const data = pack(reached.reverse());
        const bands: Buffer[] = [];
        for (let i = 0; i < data.length; i += 1000) bands.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 1000)])));
        return send(200, Buffer.concat([pkt("packfile\n"), pkt(Buffer.concat([Buffer.from([2]), Buffer.from("counting\n")])), ...bands, FLUSH]));
      }
    }
    send(400, Buffer.from("unexpected"));
  }
}
