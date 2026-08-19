/**
 * A process killed mid-append leaves a partial final record.
 *
 * Two halves have to agree about what that means, and the failure when they do
 * not is severe: the reader treats an unterminated last line as work that never
 * completed and drops it, so if the WRITER simply appends after it the two
 * records fuse into one unparseable line — which is no longer last, and which
 * the reader must then refuse, because discarding a record in the middle would
 * mean skipping work that may have happened. A journal that was resumable a
 * moment earlier becomes permanently unresumable.
 */
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "../src/journal.js";

let dir: string;
let journal: any;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telo-journal-"));
  journal = await create({ directory: dir, metadata: { name: "j" } } as never, {} as never);
  await journal.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileFor = (run: string) => join(dir, `${encodeURIComponent(run)}.ndjson`);

/** Records carry MULTI-BYTE characters, deliberately. A repair that located the
 *  last newline in decoded TEXT and truncated to that index would be short by
 *  one byte per multi-byte character before it — landing inside an earlier
 *  record and tearing a line that was intact. Pure-ASCII fixtures cannot see
 *  that class of bug at all, and the real journal is full of `✓` and `…`. */
const MARK = "  {green ✓ stock reserved} … →";

/** Cut bytes off the end, which is what an interrupted append leaves behind. */
async function tearTail(run: string, bytes: number): Promise<void> {
  const path = fileFor(run);
  const size = (await readFile(path)).length;
  await truncate(path, size - bytes);
}

async function lines(run: string): Promise<string[]> {
  return (await readFile(fileFor(run), "utf8")).split("\n").filter(Boolean);
}

describe("a torn final record", () => {
  it("is dropped on read — the work it described never completed", async () => {
    await journal.admitRun("r");
    await journal.append("r", { path: "steps/a", kind: "step", value: { note: MARK } });
    await journal.append("r", { path: "steps/b", kind: "step", value: { note: MARK } });
    await tearTail("r", 20);

    // The torn record is gone; everything before it survives. That is the whole
    // point of appending and flushing per record.
    const entries = await journal.readEntries("r");
    expect(entries.map((e: any) => e.path)).toEqual(["steps/a"]);
  });

  it("does not fuse with the next append", async () => {
    await journal.admitRun("r");
    await journal.append("r", { path: "steps/a", kind: "step", value: { note: MARK } });
    await journal.append("r", { path: "steps/b", kind: "step", value: { note: MARK } });
    await tearTail("r", 20);

    // A fresh process resumes and writes. Without repair this appends ONTO the
    // partial line, producing one unparseable record in the middle of the file.
    const resumed = await create({ directory: dir, metadata: { name: "j" } } as never, {} as never);
    await resumed.init();
    await resumed.append("r", { path: "steps/b", kind: "step", value: { ok: 3 } });

    for (const [i, line] of (await lines("r")).entries()) {
      expect(() => JSON.parse(line), `line ${i + 1}: ${line.slice(0, 80)}`).not.toThrow();
    }
    const entries = await resumed.readEntries("r");
    expect(entries.map((e: any) => e.path)).toEqual(["steps/a", "steps/b"]);
    // `steps/b` re-ran, which is correct: its record never finished being
    // written, so the work it described never finished either. `steps/a` is
    // untouched — a repair that miscounted bytes would have eaten into it.
    expect(entries.find((e: any) => e.path === "steps/b").value).toEqual({ ok: 3 });
    expect(entries.find((e: any) => e.path === "steps/a").value).toEqual({ note: MARK });
  });

  it("still refuses a record damaged in the MIDDLE", async () => {
    // The one case that must stay a hard failure: replaying past it would skip a
    // record that may describe work which did happen.
    await journal.admitRun("r");
    await journal.append("r", { path: "steps/a", kind: "step", value: { ok: 1 } });
    await journal.append("r", { path: "steps/b", kind: "step", value: { ok: 2 } });
    const text = await readFile(fileFor("r"), "utf8");
    const rows = text.split("\n").filter(Boolean);
    rows[0] = rows[0].slice(0, 30);
    await writeFile(fileFor("r"), rows.join("\n") + "\n");

    await expect(journal.readEntries("r")).rejects.toMatchObject({
      code: "ERR_DURABLE_JOURNAL_CORRUPT",
    });
  });

  it("survives a tear that removes the whole last record", async () => {
    await journal.admitRun("r");
    await journal.append("r", { path: "steps/a", kind: "step", value: { note: MARK } });
    const size = (await readFile(fileFor("r"))).length;
    await truncate(fileFor("r"), size - 1); // drop just the newline

    // The record is complete but unterminated. Dropping it re-runs one step,
    // which is the safe direction; fusing the next write onto it is not.
    const resumed = await create({ directory: dir, metadata: { name: "j" } } as never, {} as never);
    await resumed.init();
    await resumed.append("r", { path: "steps/b", kind: "step", value: { ok: 2 } });
    for (const line of await lines("r")) expect(() => JSON.parse(line)).not.toThrow();
  });
});
