import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { base64Url } from "../dpop-proof";
import { indexedDbDpopKeyStore } from "../dpop-key-store";
import { RunnerTokenSource, type RunnerTokenAnswer, type RunnerTokenHolder } from "../runner-token";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { desktopRunnerTokenHolder } from "../desktop-runner-token-holder";

const TOKEN_ENDPOINT = "https://issuer.test/token";
const RUNNER = "https://runner.test";

/** RFC 7638: the SHA-256 thumbprint of the proof header's EC key. */
async function thumbprintOf(proof: string): Promise<string> {
  const part = proof.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
  const { jwk } = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4))) as {
    jwk: { crv: string; kty: string; x: string; y: string };
  };
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

/** A holder that asks for a proof, then answers a token, recording each proof. */
function recordingHolder(proofs: string[]): RunnerTokenHolder {
  return {
    async exchange(_resource, proof): Promise<RunnerTokenAnswer> {
      if (proof === null) return { kind: "proof", tokenEndpoint: TOKEN_ENDPOINT };
      proofs.push(proof);
      return { kind: "token", accessToken: "at", expiresIn: 300 };
    },
  };
}

describe("runner tokens with the installation's key", () => {
  it("binds every token request to the same key across page loads", async () => {
    const factory = new IDBFactory();
    const proofs: string[] = [];
    for (let load = 0; load < 2; load++) {
      const store = indexedDbDpopKeyStore(() => factory);
      const source = new RunnerTokenSource(recordingHolder(proofs), () => store.key("user-1"));
      await source.token(RUNNER);
    }
    expect(proofs).toHaveLength(2);
    expect(await thumbprintOf(proofs[1]!)).toBe(await thumbprintOf(proofs[0]!));
  });
});

describe("a runner the desktop shell authorizes again", () => {
  beforeEach(() => invoke.mockReset());

  it("tells the user, then signs a fresh proof for the authorization that follows", async () => {
    invoke
      .mockResolvedValueOnce({ status: "proofRequired", tokenEndpoint: TOKEN_ENDPOINT, nonce: null })
      .mockResolvedValueOnce({ status: "reauthorizing", tokenEndpoint: TOKEN_ENDPOINT, nonce: "n-1" })
      .mockResolvedValueOnce({ status: "token", accessToken: "at", expiresIn: 300 });
    const store = indexedDbDpopKeyStore(() => new IDBFactory());
    const reauthorizing = vi.fn();
    const source = new RunnerTokenSource(desktopRunnerTokenHolder(), () => store.key("user-1"), Date.now, reauthorizing);

    expect((await source.token(RUNNER)).accessToken).toBe("at");
    expect(reauthorizing.mock.calls).toEqual([[RUNNER]]);
    const proofs = invoke.mock.calls.map(([, args]) => (args as { proof: string | null }).proof);
    expect(proofs[0]).toBeNull();
    expect(proofs[2]).not.toBe(proofs[1]);
    const claims = JSON.parse(atob(proofs[2]!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      nonce?: string;
    };
    expect(claims.nonce).toBe("n-1");
  });
});
