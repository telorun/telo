/**
 * The wire form of a step target — `kernel/specs/durable-execution.md` §5.3.
 *
 * The refusals are the point of these tests, not the round trip: an identity too
 * incomplete to resolve elsewhere must fail at the SENDER, where the manifest
 * that produced it is still in reach. Encoded anyway, it resolves at the far end
 * to a resource that merely SHARES A NAME with the one the step meant — a step
 * executed against the wrong resource, which is the one failure durable
 * execution must never produce quietly.
 */
import { describe, expect, it } from "vitest";
import {
  DURABLE_TARGET_ENCODING_VERSION,
  decodeDurableTarget,
  encodeDurableTarget,
} from "../src/durable-target-encoding.js";
import type { DurableTarget } from "../src/durable-run.js";

const moduleLevel: DurableTarget = {
  kind: "Mail.Send",
  name: "sendMail",
  module: "oci://ghcr.io/acme/mail@1.2.0",
};

describe("durable target encoding", () => {
  it("round-trips a module-level target", () => {
    expect(decodeDurableTarget(encodeDurableTarget(moduleLevel))).toEqual(moduleLevel);
  });

  it("round-trips an inline target with its pointer", () => {
    const inline: DurableTarget = { ...moduleLevel, pointer: "onboard#/steps/0/invoke" };
    expect(decodeDurableTarget(encodeDurableTarget(inline))).toEqual(inline);
  });

  it("round-trips a scoped target with its full tuple", () => {
    const scoped: DurableTarget = {
      ...moduleLevel,
      scoped: true,
      scope: { owner: "onboard", site: "/with", stepPath: "steps/charge" },
    };
    // `scoped` is derived from the tuple's presence on the way back in — it is
    // the flag for a tuple that could not be DERIVED, and one that survived
    // encoding has the tuple itself.
    expect(decodeDurableTarget(encodeDurableTarget(scoped))).toEqual({
      ...moduleLevel,
      scope: scoped.scope,
    });
  });

  it("writes a canonical key order, so two producers of one identity produce one string", () => {
    const shuffled = { name: "sendMail", module: moduleLevel.module, kind: "Mail.Send" };
    expect(encodeDurableTarget(shuffled)).toBe(encodeDurableTarget(moduleLevel));
    expect(encodeDurableTarget(moduleLevel)).toBe(
      `{"v":${DURABLE_TARGET_ENCODING_VERSION},"kind":"Mail.Send","name":"sendMail",` +
        `"module":"oci://ghcr.io/acme/mail@1.2.0"}`,
    );
  });

  it("REFUSES a scoped target whose scope run could not be identified", () => {
    // The case the runtime actually produces: the step engine can see that a
    // name resolved inside a scope, and cannot yet see WHICH RUN of it. Shipped
    // as module-level, this would resolve at the far end to a different resource
    // of the same name.
    expect(() => encodeDurableTarget({ ...moduleLevel, scoped: true })).toThrow(
      /declared inside a 'with:' scope but records no owner/,
    );
  });

  it("REFUSES a scope missing any one of its three fields", () => {
    expect(() =>
      encodeDurableTarget({
        ...moduleLevel,
        scope: { owner: "onboard", site: "/with", stepPath: "" },
      }),
    ).toThrow(/records no stepPath/);
  });

  it("REFUSES a target with no declaring module", () => {
    expect(() => encodeDurableTarget({ kind: "Mail.Send", name: "sendMail" })).toThrow(
      /carries no declaring module/,
    );
  });

  it("REFUSES a target that is both scoped and inline", () => {
    expect(() =>
      encodeDurableTarget({ ...moduleLevel, scoped: true, pointer: "onboard#/steps/0" }),
    ).toThrow(/describes no declaration site/);
  });

  it("REFUSES an encoding version it does not read, rather than the fields it recognizes", () => {
    const future = JSON.stringify({ ...JSON.parse(encodeDurableTarget(moduleLevel)), v: 99 });
    expect(() => decodeDurableTarget(future)).toThrow(/encoding version 99/);
  });

  it("REFUSES a malformed or incomplete payload", () => {
    expect(() => decodeDurableTarget("not json")).toThrow(/not valid JSON/);
    expect(() => decodeDurableTarget("[]")).toThrow(/not an object/);
    expect(() => decodeDurableTarget('{"v":1,"kind":"Mail.Send"}')).toThrow(
      /without a kind, a name or a module/,
    );
  });
});
