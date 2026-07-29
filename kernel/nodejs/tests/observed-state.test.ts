import { describe, expect, it } from "vitest";
import { RuntimeError } from "@telorun/sdk";
import {
  acceptReportedStatus,
  buildPublishedProps,
  diagnoseObservedStateAccess,
  observedStateInfo,
} from "../src/observed-state.js";

const STATUS = {
  type: "object",
  properties: {
    port: { type: "integer" },
    redirectUri: { type: "string" },
  },
};

const base = {
  kind: "OAuthClient.RedirectListener",
  name: "loopback",
  module: "oauth-client",
  statusSchema: STATUS,
};

describe("observed state — what reaches resources.<name>", () => {
  it("keeps the flat half untouched and omits status until the resource reports", () => {
    const props = buildPublishedProps(
      { port: 0 },
      { ...base, started: false, completed: false },
    );

    expect(props).toEqual({ port: 0 });
    expect("status" in props).toBe(false);
  });

  it("publishes status once the resource has started", () => {
    const props = buildPublishedProps(
      { port: 0 },
      {
        ...base,
        status: { port: 51234, redirectUri: "http://127.0.0.1:51234" },
        started: true,
        completed: true,
      },
    );

    expect(props).toEqual({
      port: 0,
      status: { port: 51234, redirectUri: "http://127.0.0.1:51234" },
    });
  });

  it("refuses a snapshot field that would land on the status key", () => {
    // Only for a kind that declares `status:` — the two would collide, and
    // letting one silently win is worse than refusing.
    expect(() =>
      buildPublishedProps({ status: "configured" }, { ...base, started: true, completed: true }),
    ).toThrowError(
      expect.objectContaining({ code: "ERR_OBSERVED_STATE_KEY_COLLISION" } as Partial<RuntimeError>),
    );
  });

  it("lets a kind that declares no status: use the name freely", () => {
    // No reserved key: with the two halves on separate channels there is nothing
    // to collide with.
    const props = buildPublishedProps(
      { status: "connected" },
      { kind: "Http.Probe", name: "probe", started: true, completed: true },
    );

    expect(props).toEqual({ status: "connected" });
  });

  it("leaves an undeclared kind's flat snapshot alone", () => {
    const props = buildPublishedProps(
      { baseUrl: "http://x", timeout: 10000 },
      { kind: "Http.Client", name: "api", started: false, completed: false },
    );

    expect(props).toEqual({ baseUrl: "http://x", timeout: 10000 });
    expect(observedStateInfo(props)).toBeUndefined();
  });

  it("rejects a report that does not match the declared shape, at the call that made it", () => {
    expect(() =>
      acceptReportedStatus({ port: "not-a-port" }, base),
    ).toThrowError(
      expect.objectContaining({ code: "ERR_OBSERVED_STATE_INVALID" } as Partial<RuntimeError>),
    );
  });

  it("rejects a report from a kind that declares no status:", () => {
    expect(() =>
      acceptReportedStatus({ anything: 1 }, { kind: "Http.Probe", name: "probe" }),
    ).toThrowError(
      expect.objectContaining({ code: "ERR_OBSERVED_STATE_UNDECLARED" } as Partial<RuntimeError>),
    );
  });

  it("marks published values invisibly to CEL — a Symbol, not a key", () => {
    const props = buildPublishedProps({}, { ...base, status: { port: 1 }, started: true, completed: true });

    expect(Object.keys(props)).toEqual(["status"]);
    expect(observedStateInfo(props)).toMatchObject({
      name: "loopback",
      fields: ["port", "redirectUri"],
      started: true,
    });
  });
});

describe("observed state — publication is a reading, not a live window", () => {
  it("does not alias what the controller returned", () => {
    // A controller that keeps the object it returned and mutates it would
    // otherwise keep rewriting an already-published value. No schema check can
    // catch that — the shape never changes, only the contents.
    const live = { port: 0, redirectUri: "" };
    const accepted = acceptReportedStatus(live, base);

    live.port = 51234;
    live.redirectUri = "http://127.0.0.1:51234";

    expect(accepted).toEqual({ port: 0, redirectUri: "" });
  });

  it("detaches nested containers on the flat half too", () => {
    const headers: Record<string, string> = { accept: "application/json" };
    const props = buildPublishedProps(
      { headers },
      { kind: "Http.Client", name: "api", started: false, completed: false },
    );

    headers.authorization = "Bearer leaked";

    expect(props.headers).toEqual({ accept: "application/json" });
  });

  it("passes a class instance through by reference — copying one would break it", () => {
    class Pool {
      readonly kind = "pool";
    }
    const pool = new Pool();
    const props = buildPublishedProps(
      { pool },
      { kind: "Sql.Connection", name: "db", started: true, completed: false },
    );

    expect(props.pool).toBe(pool);
  });

  it("survives a cycle", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    const props = buildPublishedProps(
      { node },
      { kind: "X.Y", name: "x", started: false, completed: false },
    );

    const published = props.node as Record<string, unknown>;
    expect(published).not.toBe(node);
    expect(published.self).toBe(published);
  });
});

describe("observed state — the three runtime read failures", () => {
  it("says 'has not started' when the whole segment is missing", () => {
    const props = buildPublishedProps({}, { ...base, started: false, completed: false });

    const message = diagnoseObservedStateAccess(props, "status");
    expect(message).toContain("has not started yet");
    expect(message).toContain("'redirectUri'");
  });

  it("blames the producing module only once run() has RETURNED", () => {
    const props = buildPublishedProps({}, { ...base, started: true, completed: true });

    const message = diagnoseObservedStateAccess(props, "status");
    expect(message).toContain("finished running without ever reporting");
    expect(message).toContain("oauth-client");
    expect(message).toContain("no change to this manifest will fix it");
  });

  it("calls a still-running producer a race, not a defect", () => {
    // A Service that binds asynchronously is started but not finished. Blaming
    // the producing module there would send the reader to audit someone else's
    // code for what is ordering — and a Service's run() never returns at all.
    const props = buildPublishedProps({}, { ...base, started: true, completed: false });

    const message = diagnoseObservedStateAccess(props, "status");
    expect(message).toContain("still running, so this read raced it");
    expect(message).not.toContain("defect");
  });

  it("lists what is reported for a field the kind does not declare", () => {
    const props = buildPublishedProps({}, { ...base, status: { port: 1 }, started: true, completed: true });

    expect(diagnoseObservedStateAccess(props.status, "redirectUrl")).toBe(
      "'loopback' reports no 'redirectUrl'. It reports 'port', 'redirectUri'.",
    );
  });

  it("stays out of the way of failures that are not about observed state", () => {
    expect(diagnoseObservedStateAccess({ baseUrl: "x" }, "timeout")).toBeNull();
  });
});

describe("observed state — reporting is pushed, and sticky", () => {
  it("replaces rather than merges", () => {
    // "This is my observed state now." Merging would put the shape in two
    // places; a declared field an update omits reads as missing, which is the
    // truth — a sometimes-absent field is declared nullable and reported null.
    const first = acceptReportedStatus({ port: 1, redirectUri: "a" }, base);
    const second = acceptReportedStatus({ port: 2, redirectUri: "b" }, base);

    expect(second).toEqual({ port: 2, redirectUri: "b" });
    expect(first).toEqual({ port: 1, redirectUri: "a" });
  });

  it("keeps the last reading published when a later dispatch reports nothing", () => {
    // Sticky: a listener's bound address does not stop being true between calls.
    const reported = acceptReportedStatus({ port: 51234, redirectUri: "u" }, base);
    const afterAnotherInvoke = buildPublishedProps(
      { port: 0 },
      { ...base, status: reported, started: true, completed: false },
    );

    expect(afterAnotherInvoke.status).toEqual({ port: 51234, redirectUri: "u" });
  });
});
