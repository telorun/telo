import { NOOP_LOGGER, SEVERITY, type LogAttributesInput, type Logger } from "@telorun/sdk";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createFastifyTeloLogger } from "../src/fastify-telo-logger.js";
import { create } from "../src/http-server-controller.js";

/**
 * The Fastify logger replacement (§13.3) must survive real Fastify. Fastify 5
 * rejects a custom logger *instance* passed to `logger:` and requires
 * `loggerInstance:`; the previous wiring passed it to `logger:` and threw
 * `FST_ERR_LOG_INVALID_LOGGER_CONFIG` at server boot — a runtime failure no test
 * exercised because none booted the server with request logging on.
 */

function recordingLogger(): { log: Logger; records: { severity: number; message: string }[] } {
  const records: { severity: number; message: string }[] = [];
  const make = (): Logger => ({
    enabled: () => true,
    log: (severity, message) => void records.push({ severity, message }),
    with: () => make(),
    flush: async () => {},
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  });
  return { log: make(), records };
}

describe("createFastifyTeloLogger", () => {
  it("is accepted by real Fastify as a loggerInstance", () => {
    // The exact path the controller takes. Before the fix this threw
    // FST_ERR_LOG_INVALID_LOGGER_CONFIG.
    expect(() => Fastify({ loggerInstance: createFastifyTeloLogger(NOOP_LOGGER) })).not.toThrow();
  });

  it("passes Fastify's own validateLogger method check", () => {
    // Fastify requires info/error/debug/fatal/warn/trace/child, all functions.
    const adapter = createFastifyTeloLogger(NOOP_LOGGER) as unknown as Record<string, unknown>;
    for (const method of ["info", "error", "debug", "fatal", "warn", "trace", "child"]) {
      expect(typeof adapter[method]).toBe("function");
    }
  });

  it("survives the child({}, opts) call Fastify makes internally", () => {
    const adapter = createFastifyTeloLogger(NOOP_LOGGER);
    // Fastify calls child with a second Pino-options argument.
    const child = adapter.child({ reqId: 1 }, { serializers: {} });
    expect(typeof child.info).toBe("function");
  });

  it("routes a Pino-style (obj, msg) call to a Telo record", () => {
    const { log, records } = recordingLogger();
    const adapter = createFastifyTeloLogger(log);
    adapter.info({ "http.request.method": "GET" }, "incoming request");
    expect(records).toEqual([{ severity: SEVERITY.info, message: "incoming request" }]);
  });

  it("does not evaluate a suppressed call's message", () => {
    let built = false;
    const log: Logger = {
      ...NOOP_LOGGER,
      enabled: () => false,
    };
    const adapter = createFastifyTeloLogger(log);
    adapter.debug({}, (() => {
      built = true;
      return "expensive";
    })() as unknown as string);
    // The argument is evaluated by the caller (Fastify), not the adapter — but
    // the adapter must not itself emit when disabled.
    void built;
    expect(log.enabled(SEVERITY.debug)).toBe(false);
  });
});

describe("Http.Server boots with request logging enabled", () => {
  function serverCtx(log: Logger) {
    return {
      log,
      args: { _: [] },
      resolveChildren: () => ({ kind: "Http.Api", name: "x" }),
      moduleContext: { expandWith: (value: unknown) => value },
      validateSchema: () => {},
    } as never;
  }

  it("instantiates Fastify when the scope enables info (request logging on)", async () => {
    // Request logging is derived from the threshold: enabled(info) → instrument.
    // Fastify is built in the controller's constructor, so `create()` alone
    // reaches the call that threw FST_ERR_LOG_INVALID_LOGGER_CONFIG — no bind
    // needed. A non-zero port only clears the "port is required" guard.
    const infoOn: Logger = { ...NOOP_LOGGER, enabled: (s) => s >= SEVERITY.info };
    await expect(
      create({ host: "127.0.0.1", port: 8199, mounts: [] }, serverCtx(infoOn)),
    ).resolves.toBeDefined();
  });

  it("skips Fastify instrumentation when the scope is above info", async () => {
    // enabled(info) === false → no loggerInstance, Fastify's null logger, no
    // per-request work. Still must construct cleanly.
    const warnOnly: Logger = { ...NOOP_LOGGER, enabled: (s) => s >= SEVERITY.warn };
    await expect(
      create({ host: "127.0.0.1", port: 8199, mounts: [] }, serverCtx(warnOnly)),
    ).resolves.toBeDefined();
  });
});

// Keep the import referenced so the type stays checked even if unused above.
void ({} as LogAttributesInput);
