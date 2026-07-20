import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/**
 * The kernel-integration half of `kernel/specs/logging.md` §16.1 — the vectors
 * that need a real load/boot/teardown cycle rather than the pipeline in
 * isolation. Numbering follows the spec.
 */

class Capture {
  readonly chunks: string[] = [];
  get text(): string {
    return this.chunks.join("");
  }
  get records(): Record<string, unknown>[] {
    return this.text
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
}

async function bootApp(
  manifest: string,
  options: { env?: Record<string, string | undefined>; extra?: Record<string, string> } = {},
) {
  const memory = new MemorySource();
  memory.set("app", manifest);
  for (const [name, text] of Object.entries(options.extra ?? {})) memory.set(name, text);

  const stderr = new Capture();
  const stdout = new Capture();
  const kernel = new Kernel({
    sources: [memory],
    env: options.env ?? {},
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  await kernel.load("memory://app");
  await kernel.boot();
  return { kernel, stderr, stdout };
}

describe("vector 9 — configuration isolation", () => {
  it("ignores TELO_LOG_LEVEL entirely; the manifest is the only source", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: IsolationApp
logging:
  level: error
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
`;
    const { kernel, stderr } = await bootApp(manifest, {
      env: { TELO_LOG_LEVEL: "trace", TELO_LOG_FORMAT: "pretty" },
    });

    kernel.logging.kernelLogger().info("should be suppressed at error");
    kernel.logging.kernelLogger().error("should appear");
    await kernel.teardown();

    const messages = stderr.records.map((r) => r["msg"]);
    expect(messages).toContain("should appear");
    expect(messages).not.toContain("should be suppressed at error");
  });

  it("derives a level from the environment only through variables + !cel", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: CelLevelApp
variables:
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
logging:
  level: !cel "variables.logLevel"
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
`;
    const { kernel, stderr } = await bootApp(manifest, { env: { LOG_LEVEL: "debug" } });

    kernel.logging.kernelLogger().debug("debug via declared variable");
    await kernel.teardown();

    expect(stderr.records.map((r) => r["msg"])).toContain("debug via declared variable");
  });
});

describe("vector 12 — sink configuration", () => {
  async function blockDiagnostics(manifest: string): Promise<string> {
    // `on_full: block` is statically detectable (§10.3), so it is rejected at
    // load with an ERR_MANIFEST_VALIDATION_FAILED whose diagnostics name the
    // sink — never silently degraded to dropping, which would hand back the
    // opposite durability guarantee.
    try {
      await bootApp(manifest);
    } catch (err) {
      const diagnostics = (err as { diagnostics?: { message: string }[] }).diagnostics ?? [];
      return diagnostics.map((d) => d.message).join("\n");
    }
    throw new Error("expected a manifest validation failure");
  }

  it("rejects on_full: block at load with a diagnostic naming the sink", async () => {
    const detail = await blockDiagnostics(`kind: Telo.Application
metadata:
  name: BlockApp
logging:
  sinks:
    - kind: Telo.FileSink
      destination: /tmp/telo-block-test.jsonl
      on_full: block
`);
    expect(detail).toMatch(/on_full: block is not supported/);
  });

  it("names the supported values", async () => {
    const detail = await blockDiagnostics(`kind: Telo.Application
metadata:
  name: BlockNamedApp
logging:
  sinks:
    - kind: Telo.FileSink
      destination: /tmp/telo-block-test-2.jsonl
      on_full: block
`);
    expect(detail).toMatch(/drop_new.*drop_old/s);
  });

  it("yields exactly one Telo.ConsoleSink writing to stderr when sinks: is omitted", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: DefaultSinkApp
`;
    const { kernel, stderr, stdout } = await bootApp(manifest);

    kernel.logging.kernelLogger().info("zero config");
    await kernel.teardown();

    expect(stderr.text).toContain("zero config");
    expect(stdout.text).not.toContain("zero config");
  });

  it("the zero-config console sink honours the root logging.level in both directions", async () => {
    // §12.1: omitting `sinks:` behaves exactly as if a single Telo.ConsoleSink
    // were declared, and a declared sink with no explicit level takes the
    // resolved scope threshold — so the root level must gate the zero-config
    // sink, not a hardcoded `info`.
    const debugApp = await bootApp(
      `kind: Telo.Application\nmetadata:\n  name: ZeroDebug\nlogging:\n  level: debug\n`,
    );
    debugApp.kernel.logging.kernelLogger().debug("debug-appears");
    await debugApp.kernel.teardown();
    expect(debugApp.stderr.text).toContain("debug-appears");

    const warnApp = await bootApp(
      `kind: Telo.Application\nmetadata:\n  name: ZeroWarn\nlogging:\n  level: warn\n`,
    );
    warnApp.kernel.logging.kernelLogger().info("info-suppressed");
    await warnApp.kernel.teardown();
    expect(warnApp.stderr.text).not.toContain("info-suppressed");
  });
});

describe("a module-authored sink kind validates", () => {
  it("accepts a Telo.Definition with capability: Telo.Sink", async () => {
    // Regression: Telo.Sink was in KNOWN_CAPABILITIES but had no oneOf branch,
    // so every module-authored sink — the whole third-party ecosystem this
    // feature exists to enable — failed `validateResourceDefinition` when the
    // kind was instantiated (the resource-definition-controller's create()).
    const { validateResourceDefinition } = await import("../src/manifest-schemas.js");
    const ok = validateResourceDefinition({
      kind: "Telo.Definition",
      metadata: { name: "Sink" },
      capability: "Telo.Sink",
      extends: "Telo.LogSink",
      controllers: ["pkg:npm/@acme/sink@1.0.0"],
      schema: { type: "object" },
    });
    expect(ok).toBe(true);

    // A sink is written to directly, never dispatched, so `throws:` is a schema
    // error on it, exactly as for Mount/Provider.
    expect(
      validateResourceDefinition({
        kind: "Telo.Definition",
        metadata: { name: "Sink" },
        capability: "Telo.Sink",
        throws: [{ code: "X" }],
      }),
    ).toBe(false);
  });
});

describe("vector 14 — late attach and replay", () => {
  it("replays records emitted before a sink attached, in original order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telo-replay-"));
    const file = join(dir, "replay.jsonl");
    const manifest = `kind: Telo.Application
metadata:
  name: ReplayApp
logging:
  level: debug
  sinks:
    - kind: Telo.FileSink
      destination: ${file}
      level: debug
`;
    const memory = new MemorySource();
    memory.set("app", manifest);
    const stderr = new Capture();
    const kernel = new Kernel({ sources: [memory], env: {}, stderr: stderr.stream });

    // Emitted during load — before the declared sink resource exists at all.
    await kernel.load("memory://app");
    kernel.logging.kernelLogger().info("before attach A");
    kernel.logging.kernelLogger().info("before attach B");

    await kernel.boot();
    await kernel.teardown();

    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg: string });
    const messages = lines.map((l) => l.msg);

    expect(messages).toContain("before attach A");
    expect(messages).toContain("before attach B");
    expect(messages.indexOf("before attach A")).toBeLessThan(messages.indexOf("before attach B"));

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("§13.1 — the kernel routes its own diagnostics through the logger", () => {
  it("emits kernel diagnostics as structured records, not raw stderr writes", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: KernelDiagApp
logging:
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
`;
    const { kernel, stderr } = await bootApp(manifest);

    kernel.logging.kernelLogger().warn("kernel diagnostic", { "telo.subsystem": "test" });
    await kernel.teardown();

    const record = stderr.records.find((r) => r["msg"] === "kernel diagnostic");
    expect(record).toBeDefined();
    expect(record!["level"]).toBe("WARN");
    expect(record!["severity"]).toBe(13);
    expect(record!["attributes"]).toMatchObject({ "telo.subsystem": "test" });
  });
});

describe("§10.5 — shutdown flush", () => {
  it("flushes a file sink's tail during teardown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telo-flush-"));
    const file = join(dir, "tail.jsonl");
    const manifest = `kind: Telo.Application
metadata:
  name: FlushApp
logging:
  sinks:
    - kind: Telo.FileSink
      destination: ${file}
`;
    const { kernel } = await bootApp(manifest);

    kernel.logging.kernelLogger().info("tail record");
    await kernel.teardown();

    expect(readFileSync(file, "utf8")).toContain("tail record");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("§14 — manifest secrets redact with no configuration", () => {
  it("replaces a secret value wherever it appears in attributes", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: SecretApp
secrets:
  apiKey:
    env: API_KEY
    type: string
logging:
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
`;
    const { kernel, stderr } = await bootApp(manifest, { env: { API_KEY: "sup3r-s3cret" } });

    kernel.logging.kernelLogger().info("calling out", { token: "sup3r-s3cret" });
    await kernel.teardown();

    const record = stderr.records.find((r) => r["msg"] === "calling out");
    expect(record!["attributes"]).toEqual({ token: "[redacted]" });
    expect(stderr.text).not.toContain("sup3r-s3cret");
  });
});

describe("vector 10 — scope resolution", () => {
  const leaf = `kind: Telo.Library
metadata:
  name: leaf
`;

  it("raises one import's instance alone, leaving the other at the root default", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: ScopeApp
logging:
  level: info
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
      level: trace
imports:
  Loud:
    source: memory://leaf
    logging:
      level: debug
  Quiet:
    source: memory://leaf
`;
    const { kernel, stderr } = await bootApp(manifest, { extra: { leaf } });

    const scopes = kernel.loggingScopes();

    expect(scopes.get("Loud")?.threshold).toBe(5); // debug
    expect(scopes.get("Quiet")?.threshold).toBe(9); // info, the root default

    await kernel.teardown();
    void stderr;
  });

  it("stamps each record with the scope that selected its threshold", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: ScopeStampApp
logging:
  level: debug
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
      level: trace
imports:
  Db:
    source: memory://leaf
`;
    const { kernel, stderr } = await bootApp(manifest, { extra: { leaf } });

    kernel.logging.createLogger(kernel.loggingScopes().get("Db")).info("from the import");
    await kernel.teardown();

    const record = stderr.records.find((r) => r["msg"] === "from the import");
    expect(record!["scope"]).toBe("Db");
    expect(record!["module"]).toBe("leaf");
  });
});

describe("vector 11 — cascade", () => {
  const inner = `kind: Telo.Library
metadata:
  name: inner
`;

  it("applies a parent import's override to a nested import that declares none", async () => {
    const outer = `kind: Telo.Library
metadata:
  name: outer
imports:
  Inner:
    source: memory://inner
`;
    const manifest = `kind: Telo.Application
metadata:
  name: CascadeApp
logging:
  level: info
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
imports:
  Api:
    source: memory://outer
    logging:
      level: debug
`;
    const { kernel } = await bootApp(manifest, { extra: { outer, inner } });

    const scopes = kernel.loggingScopes();

    // Raising Api lifts everything beneath it without editing Api's manifest.
    expect(scopes.get("Api")?.threshold).toBe(5);
    expect(scopes.get("Api.Inner")?.threshold).toBe(5);

    await kernel.teardown();
  });

  it("lets a nested import's own override win over its parent's", async () => {
    const outer = `kind: Telo.Library
metadata:
  name: outer
imports:
  Inner:
    source: memory://inner
    logging:
      level: error
`;
    const manifest = `kind: Telo.Application
metadata:
  name: CascadeNarrowApp
logging:
  level: info
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
imports:
  Api:
    source: memory://outer
    logging:
      level: debug
`;
    const { kernel } = await bootApp(manifest, { extra: { outer, inner } });

    const scopes = kernel.loggingScopes();

    expect(scopes.get("Api")?.threshold).toBe(5); // debug
    expect(scopes.get("Api.Inner")?.threshold).toBe(17); // error — narrowed at the hop

    await kernel.teardown();
  });
});
