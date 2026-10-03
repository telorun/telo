/**
 * The text the emitter writes is **pinned**, beside the generation a change to it owes.
 *
 * `EMITTER_FORMAT_GENERATION` is bumped on any change to the text the emitter writes for any
 * tree — not only when the module's shape changes — because the narrower rule asks whoever
 * makes the change to judge that a text difference is semantically neutral, and that
 * judgement is what produces the unrecoverable failure. This emitter's own first defect is
 * the case: temporaries numbered per function let a comprehension body shadow its caller's
 * bound value, no declaration moved, and a module cached before the fix would have answered
 * `[2, 4, 6]` for `[3, 4, 5]` forever.
 *
 * So the fixture holds the generation and a digest of the code the emitter wrote for a
 * corpus drawn from the package's own total enumerations. A change to that text fails here,
 * naming the bump it owes.
 *
 * **Its filter, and its ceiling, which is low and worth saying plainly:** the digest and the
 * generation sit in one file and can be re-recorded in one edit. So this gate cannot *stop*
 * anyone — what it converts is a silent "stale module served, wrong answer forever" into a
 * fixture diff a reviewer has to approve, with the bump named in the failure. Beyond that it
 * is blind to a text change inside an expression the corpus does not write, which is why the
 * corpus is generated from enumerations rather than written out, and why the one group that
 * *is* written out says so (`emitter-text-corpus.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMITTER_FORMAT_GENERATION } from "../src/index.js";
import { sha256OfText } from "../src/sha256.js";
import { emitterTextCorpus, emitterTextEnvironment, NODE_KIND_EXPRESSIONS } from "./emitter-text-corpus.js";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "emitter-text.json");

interface Pinned {
  readonly formatGeneration: number;
  readonly expressions: number;
  readonly codeDigest: string;
}

const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Pinned;

const environment = emitterTextEnvironment();
const corpus = emitterTextCorpus(environment);
const text = environment.emit(corpus).text;

/**
 * The code the emitter wrote: the factory and everything in it, which is the whole of what
 * the emitter decides about a tree. The envelope above it — the banner, the header line, the
 * expression comments and the `integrity` export — is **not** pinned, and deliberately: it
 * carries the engine version and the environment digest, so pinning it would re-record this
 * fixture on every release and on every change to a library the corpus happens to list,
 * which is how a pin stops meaning anything.
 */
const code = text.slice(text.indexOf("export default function"));

describe("the text the emitter writes", () => {
  it("is the text the fixture pins, or the generation owes a bump", () => {
    const digest = sha256OfText(code);
    expect(
      { formatGeneration: EMITTER_FORMAT_GENERATION, expressions: corpus.length, codeDigest: digest },
      digest === pinned.codeDigest
        ? "the generation or the expression count moved"
        : `the emitter writes different code than tests/__fixtures__/emitter-text.json pins.\n` +
            `If that is intended, bump EMITTER_FORMAT_GENERATION to ${EMITTER_FORMAT_GENERATION + 1} ` +
            `and re-record the fixture — a module cached under generation ${EMITTER_FORMAT_GENERATION} ` +
            `would otherwise go on running the text this engine no longer writes.\n` +
            `  pinned   ${pinned.codeDigest}\n  emitted  ${digest}`,
    ).toEqual(pinned);
  });

  it("is pinned over a corpus that writes every node kind, every binding form and every call", () => {
    // The corpus's own totality, asserted rather than assumed: the three enumerations are
    // read from the package, so the only way the corpus shrinks is by one of them shrinking.
    const kinds = Object.entries(NODE_KIND_EXPRESSIONS).filter(([, held]) => held !== null);
    for (const [kind, held] of kinds) {
      expect(corpus, kind).toContain(held);
    }
    expect(corpus.length).toBeGreaterThan(environment.definitions().functions.length);
    // Every entry reads whole, or the pin is over a module that refused to be emitted.
    expect(corpus.filter((source) => environment.parse(source).diagnostics.length > 0)).toEqual([]);
  });
});
