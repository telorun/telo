import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/declared-users-controller.js";

const directCtx = { resolveRef: (value: unknown) => value } as unknown as ResourceContext;

/** A hasher whose "hash" of a password is `h:<password>`, recording every call. */
function hasherSpy() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async invoke(inputs: Record<string, unknown>) {
      calls.push(inputs);
      if (inputs.op === "hash") return { hash: "dummy-hash" };
      return { valid: inputs.hash === `h:${inputs.password}`, rehash: false };
    },
  };
}

async function usersOver(hasher: object) {
  return create(
    {
      metadata: { name: "users" },
      hasher,
      users: {
        alice: { passwordHash: "h:s3cret", roles: ["admin"], scopes: ["orders:read"], claims: { team: "a" } },
        bob: { passwordHash: "h:hunter2", subject: "user-bob" },
      },
    },
    directCtx,
  );
}

describe("Identity.DeclaredUsers", () => {
  it("answers the user as the principal, with subject defaulting to the identifier", async () => {
    const users = await usersOver(hasherSpy());
    expect(await users.invoke({ identifier: "alice", password: "s3cret" })).toMatchObject({
      principal: {
        subject: "alice",
        kind: "user",
        roles: ["admin"],
        scopes: ["orders:read"],
        claims: { team: "a" },
        via: "users",
      },
    });
    expect(await users.invoke({ identifier: "bob", password: "hunter2" })).toMatchObject({
      principal: { subject: "user-bob", roles: [], scopes: [], claims: {} },
    });
  });

  it("refuses a wrong password as mismatch", async () => {
    const users = await usersOver(hasherSpy());
    expect(await users.invoke({ identifier: "alice", password: "nope" })).toEqual({ refused: true, reason: "mismatch" });
  });

  it("verifies an unknown identifier against the dummy hash, as one verify like a wrong password", async () => {
    const spy = hasherSpy();
    const users = await usersOver(spy);
    spy.calls.length = 0;

    expect(await users.invoke({ identifier: "mallory", password: "s3cret" })).toEqual({ refused: true, reason: "unknown" });
    const unknownCalls = spy.calls.splice(0);
    await users.invoke({ identifier: "alice", password: "nope" });
    const wrongCalls = spy.calls.splice(0);

    expect(unknownCalls).toEqual([{ op: "verify", password: "s3cret", hash: "dummy-hash" }]);
    expect(wrongCalls.map((call) => call.op)).toEqual(unknownCalls.map((call) => call.op));
  });

  it("does not treat an inherited property name as a user", async () => {
    const users = await usersOver(hasherSpy());
    expect(await users.invoke({ identifier: "constructor", password: "x" })).toEqual({ refused: true, reason: "unknown" });
    expect(await users.invoke({ identifier: "__proto__", password: "x" })).toEqual({ refused: true, reason: "unknown" });
  });
});
