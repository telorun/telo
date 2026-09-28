import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * Trace export (`kernel/specs/tracing.md`): a root Application's `tracing.sinks`
 * with an attached `Telo.LogTraceSink` turns tracing on, and every finished span
 * reaches the logging pipeline as one record carrying the span's own ids.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/trace-export/telo.yaml");

type Record_ = Record<string, any>;

async function bootApp(env: Record<string, string> = {}) {
  const chunks: string[] = [];
  const stdout = { write: (chunk: string) => void chunks.push(String(chunk)) } as never;
  const kernel = new Kernel({ sources: [new LocalFileSource()], env, stdout });
  await kernel.load(APP);
  await kernel.boot();
  const spans = (): Record_[] =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record_)
      .filter((record) => record.event_name === "telo.span");
  return { kernel, spans, text: () => chunks.join("") };
}

describe("trace export", () => {
  it("exports every finished span with its identity, outcome and declared attributes, never its payload", async () => {
    const { kernel, spans, text } = await bootApp();

    await kernel.invoke("Run.Sequence.turn", { turnId: "turn-7", note: "private note text" });
    await kernel.teardown();

    const byName = new Map(spans().map((span) => [span.msg as string, span]));
    const turn = byName.get("invoke turn")!;
    const measure = byName.get("invoke measure")!;
    const refuse = byName.get("invoke refuse")!;

    expect(turn.attributes).toMatchObject({ "telo.span.outcome": "ok" });
    expect(turn.attributes["telo.span.parent_span_id"]).toBeUndefined();
    for (const child of [measure, refuse]) {
      expect(child.trace_id).toBe(turn.trace_id);
      expect(child.attributes["telo.span.parent_span_id"]).toBe(turn.span_id);
    }
    expect(measure.attributes).toMatchObject({
      "telo.span.outcome": "ok",
      "telo.resource.kind": "Run.Value",
      "telo.resource.name": "measure",
      "telo.agent.turn.id": "turn-7",
      "app.context.id": "ctx-1",
      "app.step.id": "step-1",
      "app.note.length": 17,
    });
    expect(refuse.attributes).toMatchObject({
      "telo.span.outcome": "rejected",
      "error.type": "ERR_REFUSED",
    });
    // Inputs and outputs are payload; a span carries only what a contract marks.
    expect(text()).not.toContain("private note text");
  });

  it("records why a cancelled dispatch ended", async () => {
    const { kernel, spans } = await bootApp();
    const aborted = new AbortController();
    aborted.abort("client went away");

    await expect(
      kernel.invoke("Run.Value.measure", { turnId: "t", note: "n" }, { signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
    await kernel.teardown();

    expect(spans().find((span) => span.msg === "invoke measure")?.attributes).toMatchObject({
      "telo.span.outcome": "cancelled",
      "telo.cancellation.reason": "client went away",
    });
  });

  it("leaves a sink whose `when` is false unattached, and tracing off", async () => {
    const { kernel, spans } = await bootApp({ EXPORT_SPANS: "false" });
    let startEvents = 0;
    kernel.on("measure.Invoking", () => {
      startEvents += 1;
    });

    await kernel.invoke("Run.Sequence.turn", { turnId: "turn-8", note: "n" });
    await kernel.teardown();

    expect(spans()).toEqual([]);
    // Start events are emitted only while tracing is on.
    expect(startEvents).toBe(0);
  });

  it("produces one record per finished span", async () => {
    const { kernel, spans } = await bootApp();

    await kernel.invoke("Run.Sequence.turn", { turnId: "turn-9", note: "n" });
    await kernel.teardown();

    expect(spans().map((span) => span.msg).sort()).toEqual(["invoke measure", "invoke refuse", "invoke turn"]);
  });
});

/**
 * A sink attaches only through the root Application's lists: one declared
 * anywhere else is created and never written to.
 */
describe("a sink no list names", () => {
  const RUN = pathToFileURL(path.resolve(here, "../../../modules/run")).href;

  async function bootUnlisted() {
    const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "telo-unlisted-sinks-")));
    const libraryLog = path.join(dir, "library.log");
    mkdirSync(path.join(dir, "lib"));
    writeFileSync(
      path.join(dir, "lib", "telo.yaml"),
      `kind: Telo.Library
metadata:
  name: UnlistedLibrary
---
kind: Telo.FileSink
metadata:
  name: libraryLog
destination: ${JSON.stringify(libraryLog)}
`,
    );
    writeFileSync(
      path.join(dir, "telo.yaml"),
      `kind: Telo.Application
metadata:
  name: UnlistedSinks
imports:
  Run: ${RUN}
  Lib: ./lib
logging:
  sinks:
    - kind: Telo.ConsoleSink
      destination: stdout
      encoding: json
---
kind: Telo.LogTraceSink
metadata:
  name: traces
---
kind: Run.Value
metadata:
  name: measure
value: { done: true }
`,
    );
    const chunks: string[] = [];
    const stdout = { write: (chunk: string) => void chunks.push(String(chunk)) } as never;
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {}, stdout });
    await kernel.load(path.join(dir, "telo.yaml"));
    await kernel.boot();
    const read = () => ({
      output: chunks.join(""),
      // The sink opens its file when it is created, so the file exists either way.
      library: readFileSync(libraryLog, "utf8"),
    });
    return { kernel, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("exports no span through an unlisted trace sink", async () => {
    const { kernel, read, cleanup } = await bootUnlisted();

    await kernel.invoke("Run.Value.measure", {});
    kernel.logging.kernelLogger().info("a record for every attached sink");
    await kernel.teardown();

    expect(read().output).toContain("a record for every attached sink");
    expect(read().output).not.toContain("telo.span");
    cleanup();
  });

  it("writes nothing to a log sink an imported library declares", async () => {
    const { kernel, read, cleanup } = await bootUnlisted();

    kernel.logging.kernelLogger().info("a record for every attached sink");
    await kernel.teardown();

    expect(read().output).toContain("a record for every attached sink");
    expect(read().library).toBe("");
    cleanup();
  });
});
