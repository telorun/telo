import { InvokeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/emit-controller.js";

const handler = (name: string) => ({
  target: { ref: { kind: "Domain.Handler", name } },
  instance: {},
});

function emitWith(outcomes: Record<string, () => Promise<unknown>>) {
  const ran: string[] = [];
  const ctx = {
    resolveCoReferrers: () => Object.keys(outcomes).map(handler),
    invokeResolved: async (_kind: string, name: string) => {
      ran.push(name);
      return outcomes[name]!();
    },
  };
  return { ran, emit: create({ event: { name: "UserCreated" } }, ctx as never) };
}

describe("Domain.Emit", () => {
  it("wraps a handler failure with the event, the handler and the cause", async () => {
    const failure = new InvokeError("SIGN_UP_REFUSED", "refused");
    const { emit } = emitWith({ refuse: () => Promise.reject(failure), never: async () => ({}) });
    const err = (await (await emit).invoke({}, {} as never).catch((e) => e)) as InvokeError;
    expect(err.code).toBe("ERR_DOMAIN_EVENT_HANDLER_FAILED");
    expect(err.data).toEqual({ event: "UserCreated", handler: "refuse" });
    expect(err.cause).toBe(failure);
  });

  it("keeps the handler failure's display message on the wrapped error", async () => {
    const displayMessage = { text: "Sign-up refused", context: null, lang: "und", computed: false };
    const failure = new InvokeError("SIGN_UP_REFUSED", "refused", undefined, { displayMessage });
    const { emit } = emitWith({ refuse: () => Promise.reject(failure) });
    const err = (await (await emit).invoke({}, {} as never).catch((e) => e)) as InvokeError;
    expect(err.code).toBe("ERR_DOMAIN_EVENT_HANDLER_FAILED");
    expect(err.displayMessage).toBe(displayMessage);
  });

  it("attaches no display message when the handler failure has none", async () => {
    const failure = new InvokeError("SIGN_UP_REFUSED", "refused");
    const { emit } = emitWith({ refuse: () => Promise.reject(failure) });
    const err = (await (await emit).invoke({}, {} as never).catch((e) => e)) as InvokeError;
    expect(err.code).toBe("ERR_DOMAIN_EVENT_HANDLER_FAILED");
    expect(err.displayMessage).toBeUndefined();
  });

  it("stops at the first failing handler", async () => {
    const { ran, emit } = emitWith({
      refuse: () => Promise.reject(new Error("x")),
      never: async () => ({}),
    });
    await (await emit).invoke({}, {} as never).catch(() => undefined);
    expect(ran).toEqual(["refuse"]);
  });

  it.each(["ERR_INVOKE_CANCELLED", "ERR_DURABLE_SUSPENDED"])("passes %s through unchanged", async (code) => {
    const signal = new InvokeError(code, "signal");
    const { emit } = emitWith({ h: () => Promise.reject(signal) });
    const err = await (await emit).invoke({}, {} as never).catch((e) => e);
    expect(err).toBe(signal);
  });
});
