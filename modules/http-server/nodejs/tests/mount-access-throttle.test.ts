import { InvokeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { accessRefusalOf } from "../src/access-refusal.js";
import { mountAccessHook, type MountAccessOptions } from "../src/mount-access.js";

type Call = { name: string; inputs: Record<string, unknown> };

/** A mount over one header-only source and verifier, with a budget whose `settle` may fail. */
function harness(behaviour: { verifier: "accepts" | "throws" | "throwsUncoded"; settle: "works" | "fails" }) {
  const calls: Call[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const source = { snapshot: () => ({ schemes: ["Bearer"] }) } as unknown as ResourceInstance;
  const verifier = { snapshot: () => ({ challenges: [] }) } as unknown as ResourceInstance;
  const budget = {} as ResourceInstance;
  const ctx = {
    log: { warn: (_message: string, fields: Record<string, unknown>) => warnings.push(fields) },
    invokeResolved: async (_kind: string, name: string, instance: ResourceInstance, inputs: Record<string, unknown>) => {
      calls.push({ name, inputs });
      if (instance === source) return { scheme: "Bearer", token: "t" };
      if (instance === verifier) {
        if (behaviour.verifier === "throwsUncoded") throw new Error("keys unreachable");
        if (behaviour.verifier === "throws") throw new InvokeError("ERR_KEYS_UNREACHABLE", "keys unreachable");
        return { principal: { subject: "alice" } };
      }
      if (inputs.op === "settle" && behaviour.settle === "fails") throw new InvokeError("ERR_STORE_DOWN", "store down");
      return { allowed: true, reserved: 1, retryAfter: 0 };
    },
  } as unknown as ResourceContext;
  const options: MountAccessOptions = {
    ctx,
    label: "mount",
    path: "",
    authentication: {
      verifiers: [
        {
          verifier: { kind: "V", name: "verifier", instance: verifier, calledAt: "/v" },
          from: { kind: "S", name: "source", instance: source, calledAt: "/s" },
        },
      ],
      throttle: { budget: { kind: "RateLimit.Budget", name: "budget", instance: budget, calledAt: "/b" }, key: (view) => view.ip },
    },
    trace: () => ({ context: {}, principal: null, reject: () => {} }) as never,
    credentialRequest: () => ({ ip: "10.0.0.1" }) as never,
    readBody: async () => new Uint8Array(),
    declaredDisplayMessage: () => undefined,
  };
  const request = { routeOptions: { config: {} }, headers: {}, method: "GET", protocol: "http", host: "h", url: "/" } as unknown as FastifyRequest;
  const run = async () => {
    try {
      await mountAccessHook(options)(request, { header: () => {} } as unknown as FastifyReply);
      return undefined;
    } catch (error) {
      return error as InvokeError;
    }
  };
  return { run, calls, warnings };
}

describe("authentication.throttle settle failures", () => {
  it("answers a valid credential 503 at stage throttle when only the settle fails", async () => {
    const { run } = harness({ verifier: "accepts", settle: "fails" });
    const error = (await run())!;
    expect(error.code).toBe("ERR_HTTP_ACCESS_CHECK_UNAVAILABLE");
    expect(error.data).toEqual({ stage: "throttle" });
    expect(accessRefusalOf(error)?.status).toBe(503);
  });

  it("keeps stage verifier when the verifier threw too, and logs the settle failure in the same record", async () => {
    const { run, warnings } = harness({ verifier: "throws", settle: "fails" });
    const error = (await run())!;
    expect(error.data).toEqual({ stage: "verifier" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      "httpserver.access.stage": "verifier",
      "error.type": "ERR_KEYS_UNREACHABLE",
      "httpserver.access.throttle.settle_failed": true,
      "httpserver.access.throttle.settle_error": "store down",
    });
  });
});

describe("authentication.throttle after a verifier throw", () => {
  it("settles the reservation to 0 when the verifier threw an uncoded error", async () => {
    const { run, calls } = harness({ verifier: "throwsUncoded", settle: "works" });
    const error = (await run())!;
    expect(error.message).toBe("keys unreachable");
    expect(calls.filter((call) => call.inputs.op === "settle")).toHaveLength(1);
  });
});
