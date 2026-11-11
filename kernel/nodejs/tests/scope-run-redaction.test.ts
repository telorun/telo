import { describe, expect, it } from "vitest";
import { InvokeError, SEVERITY, type LogRecord, type ResourceInstance } from "@telorun/sdk";
import { EvaluationContext } from "../src/evaluation-context.js";
import { bindContract, recordBoundInput, type BoundContract } from "../src/invocation-contract-binding.js";
import { LoggingPipeline } from "../src/logging/logging-pipeline.js";
import { compileRedactionPolicy } from "../src/logging/redact-attributes.js";
import {
  attachErrorRedaction,
  errorRedactionOf,
  RunRedaction,
  textsAtPaths,
} from "../src/scope-run-redaction.js";

describe("a scope run's redaction set", () => {
  it("replaces every occurrence of a value at any length, the enclosing run's too", () => {
    const outer = new RunRedaction(["k"], undefined);
    const run = new RunRedaction(["s3cr3t"], outer);
    expect(run.scrub("Bearer s3cr3t, again s3cr3t; k")).toBe("Bearer [redacted], again [redacted]; [redacted]");
    const value = { headers: { authorization: "Bearer s3cr3t" }, list: ["s3cr3t"], untouched: 1 };
    expect(run.scrubValue(value)).toEqual({
      headers: { authorization: "Bearer [redacted]" },
      list: ["[redacted]"],
      untouched: 1,
    });
    expect(value.headers.authorization).toBe("Bearer s3cr3t");
  });

  it("is filled from every string at or beneath a sensitive path", () => {
    const inputs = { apiKey: "a", nested: { tokens: ["b", { deep: "c" }] }, rows: [{ pin: "d" }], plain: "e", count: 3 };
    expect(textsAtPaths(inputs, [["apiKey"], ["nested"], ["rows", "[]", "pin"]]).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("follows a failure through the errors wrapping it", () => {
    const run = new RunRedaction(["s3cr3t"], undefined);
    const inner = new Error("upstream said s3cr3t");
    attachErrorRedaction(inner, run);
    const outer = new Error("wrapped", { cause: inner });
    expect(errorRedactionOf(outer)).toBe(run);
    expect(errorRedactionOf(new Error("unrelated"))).toBeUndefined();
  });
});

describe("a log record under a scope run", () => {
  const capture = () => {
    const records: LogRecord[] = [];
    const pipeline = new LoggingPipeline({ fallbackStream: { write: () => {} } });
    pipeline.attach({
      sinkId: "capture",
      level: SEVERITY.trace,
      syncFlushable: true,
      write: (record: LogRecord) => void records.push(record),
      flush: async () => {},
      flushSync: () => {},
      close: async () => {},
    } as never);
    return { pipeline, records };
  };
  const scope = { threshold: SEVERITY.info, redaction: compileRedactionPolicy({}) };

  it("is redacted in its message, attributes and error by the writer's run", () => {
    const { pipeline, records } = capture();
    const runRedaction = new RunRedaction(["s3cr3t"], undefined);
    pipeline
      .createLogger({ ...scope, runRedaction })
      .warn("sent s3cr3t", { header: "Bearer s3cr3t" }, { error: new Error("rejected s3cr3t") });
    expect(records[0]!.message).toBe("sent [redacted]");
    expect(records[0]!.attributes).toEqual({ header: "Bearer [redacted]" });
    expect(records[0]!.error!.message).toBe("rejected [redacted]");
  });

  it("is redacted in a failure that left a run, whoever writes it", () => {
    const { pipeline, records } = capture();
    const failure = new Error("upstream echoed s3cr3t");
    attachErrorRedaction(failure, new RunRedaction(["s3cr3t"], undefined));
    pipeline.createLogger(scope).error("request failed", undefined, { error: failure });
    expect(records[0]!.error!.message).toBe("upstream echoed [redacted]");
  });
});

/** A bound input contract filling `greeting`'s default and refusing what lacks it. */
const greetingContract = (minProperties = 0): BoundContract =>
  ({
    direction: "inputType",
    validate: (value: Record<string, unknown>) => {
      value.greeting ??= "hi";
      if (Object.keys(value).length < minProperties) throw new Error("must have more properties");
    },
    defaultPaths: () => [["greeting"]],
    scalarPaths: () => [],
    sensitivePaths: () => [["apiKey"]],
    spanAttributes: () => [],
    resolveProjections: () => {},
    buildMembers: (value: unknown) => ({ value, redacted: [], refusals: [] }),
    payloadView: (value: unknown) => value,
  }) as unknown as BoundContract;

describe("a run of an instance with an input contract", () => {
  it("receives its contract applied to {}, after the dispatch context", () => {
    const received: unknown[] = [];
    const instance = { run: (...args: unknown[]) => void received.push(...args) } as unknown as ResourceInstance;
    bindContract(instance, { input: greetingContract(), describeTarget: () => "Test.Seq/seq" });
    const ctx = { cancellation: {} };
    (instance.run as (c: unknown) => void)(ctx);
    expect(received).toEqual([ctx, { greeting: "hi" }]);
  });

  it("is refused when the contract refuses {}", () => {
    const instance = { run: () => {} } as unknown as ResourceInstance;
    bindContract(instance, { input: greetingContract(2), describeTarget: () => "Test.Seq/seq" });
    let raised: unknown;
    try {
      (instance.run as (c?: unknown) => void)();
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(InvokeError);
    expect((raised as InvokeError).code).toBe("ERR_INPUT_INVALID");
  });
});

describe("opening a scope", () => {
  const holder = { kind: "Test.Seq", metadata: { name: "seq" } };
  const owner = () => {
    const context = new EvaluationContext("file:///app/telo.yaml", {}, async () => null, new Set(["module-secret"]), (async () => {}) as never);
    const instance = {} as ResourceInstance;
    recordBoundInput(instance, greetingContract());
    (context as unknown as { resourceInstances: Map<string, unknown> }).resourceInstances.set("seq", {
      resource: holder,
      instance,
    });
    return context;
  };
  const opening = async (handle: { run: (...args: unknown[]) => Promise<unknown> }, ...args: unknown[]) => {
    try {
      await handle.run(...args);
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return "opened";
  };

  it("takes an object on a scope opened by dispatch and null on any other", async () => {
    const context = owner();
    const dispatched = context.createScopeHandle([], holder as never, "with", true);
    const plain = context.createScopeHandle([], holder as never, "with", false);
    expect(await opening(dispatched, { apiKey: "k" }, async () => {})).toBe("opened");
    expect(await opening(dispatched, null, async () => {})).toBe("ERR_SCOPE_OPENING_INVALID");
    expect(await opening(plain, null, async () => {})).toBe("opened");
    expect(await opening(plain, { apiKey: "k" }, async () => {})).toBe("ERR_SCOPE_OPENING_INVALID");
  });

  it("reads a legacy one-argument open as null", async () => {
    const context = owner();
    expect(await opening(context.createScopeHandle([], holder as never, "with", false), async () => {})).toBe("opened");
    expect(await opening(context.createScopeHandle([], holder as never, "with", true), async () => {})).toBe(
      "ERR_SCOPE_OPENING_INVALID",
    );
  });

  it("leaves the module context's set the size it was, however many runs open", async () => {
    const context = owner();
    const handle = context.createScopeHandle([], holder as never, "with", true);
    const before = context.secretValues.size;
    for (let i = 0; i < 10_000; i++) await handle.run({ apiKey: `key-${i}` }, async () => {});
    expect(context.secretValues.size).toBe(before);
  });
});
