import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/verifier-controller.js";

const directCtx = { resolveRef: (value: unknown) => value } as unknown as ResourceContext;
const challenge = { scheme: "Basic", parameters: { realm: "Orders", charset: "UTF-8" } };
const principal = { subject: "alice", via: "passwords" };

function passwordsAnswering(answer: unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    async invoke(inputs: unknown) {
      calls.push(inputs);
      return answer;
    },
  };
}

const basic = (username: string, password: string) => ({
  presentation: { type: "basic", username, password },
  confirmation: {},
  resource: null,
});

async function verifierOver(passwords: object) {
  return create({ metadata: { name: "basic" }, passwords, realm: "Orders" }, directCtx);
}

describe("AuthBasic.Verifier", () => {
  it("hands the identifier and password to the checker and answers its principal as its own", async () => {
    const passwords = passwordsAnswering({ principal });
    const verifier = await verifierOver(passwords);
    expect(await verifier.invoke(basic("alice", "s3cret"))).toEqual({ principal: { subject: "alice", via: "basic" } });
    expect(passwords.calls).toEqual([{ identifier: "alice", password: "s3cret" }]);
  });

  it("refuses with the challenge and the checker's reason, for every reason", async () => {
    for (const reason of ["unknown", "mismatch", "disabled", "throttled"]) {
      const verifier = await verifierOver(passwordsAnswering({ refused: true, reason }));
      expect(await verifier.invoke(basic("alice", "x"))).toEqual({ refused: true, reason, challenge });
    }
  });

  it("refuses a presentation that is not basic as malformed, without asking the checker", async () => {
    const passwords = passwordsAnswering({ principal });
    const verifier = await verifierOver(passwords);
    const answer = await verifier.invoke({ presentation: { type: "token", token: "t" } } as never);
    expect(answer).toEqual({ refused: true, reason: "malformed", challenge });
    expect(passwords.calls).toEqual([]);
  });

  it("publishes the challenge from its realm", async () => {
    const verifier = await verifierOver(passwordsAnswering({}));
    expect(verifier.snapshot()).toEqual({ challenges: [challenge] });
  });
});
