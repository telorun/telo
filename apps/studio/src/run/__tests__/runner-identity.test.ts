import { describe, expect, it } from "vitest";

import { runnerIdentityEligibility, type IdentityEligibilityInput } from "../runner-identity";

const ISSUER = "https://accounts.test";
const accepted: IdentityEligibilityInput = {
  signedIn: true,
  connectedBaseUrl: "https://runner.test/base",
  identity: {
    resource: "https://runner.test/base",
    authorization_servers: ["https://other.test", ISSUER],
    dpop_bound_access_tokens_required: true,
    dpop_signing_alg_values_supported: ["ES256", "EdDSA"],
  },
  issuer: ISSUER,
};

function reasonFor(change: Partial<IdentityEligibilityInput>): string | null {
  const answer = runnerIdentityEligibility({ ...accepted, ...change });
  if (answer.use) throw new Error("expected the identity not to be used");
  return answer.reason;
}

describe("whether a runner session uses the signed-in identity", () => {
  it("does when the runner's resource is the address Studio connects to and it trusts Studio's issuer", () => {
    expect(runnerIdentityEligibility(accepted)).toEqual({ use: true, resource: "https://runner.test/base" });
  });

  it("does not when signed out or on a runner that takes resume secrets only, and has nothing to explain", () => {
    expect(reasonFor({ signedIn: false })).toBeNull();
    expect(reasonFor({ identity: undefined })).toBeNull();
  });

  it("does not, and says why, for each condition that fails", () => {
    const identity = accepted.identity as Record<string, unknown>;
    expect(reasonFor({ identity: { resource: 7 } })).toMatch(/advertises a sign-in Studio cannot read/);
    expect(reasonFor({ connectedBaseUrl: "http://runner.test/base" })).toMatch(/not a canonical https address/);
    expect(reasonFor({ connectedBaseUrl: "https://runner.test/base/" })).toMatch(/not a canonical https address/);
    expect(reasonFor({ identity: { ...identity, resource: "https://elsewhere.test" } })).toMatch(
      /advertised address \(https:\/\/elsewhere\.test\) does not match the address Studio connects to \(https:\/\/runner\.test\/base\)/,
    );
    expect(reasonFor({ identity: { ...identity, authorization_servers: ["https://other.test"] } })).toMatch(
      /does not accept sign-ins from Studio's identity provider \(https:\/\/accounts\.test\)/,
    );
    expect(reasonFor({ identity: { ...identity, dpop_signing_alg_values_supported: ["EdDSA"] } })).toMatch(/ES256/);
  });
});
