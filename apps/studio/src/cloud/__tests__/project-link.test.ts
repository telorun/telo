import { describe, expect, it } from "vitest";
import { decideProjectLink, readProjectLink, type ProjectLink } from "../project-link";
import type { CloudSessionState } from "../session";

const ORG = "org_01a0f92460f37169af67f8721c706a9f";
const PROJECT = "prj_01a12c60321271f49c132cf280d89a74";
const LINK: ProjectLink = { orgId: ORG, projectId: PROJECT, modulePath: null };

function signedInTo(orgId: string): CloudSessionState {
  return {
    status: "signedIn",
    identity: {
      user: { id: "usr_1", name: "Ada", email: null },
      org: { id: orgId },
      permissions: ["cloud:access"],
      consoleUrl: null,
      expiresAt: "2026-11-01T00:00:00Z",
    },
  };
}

describe("readProjectLink", () => {
  it("reads the organization and the project, with the root module", () => {
    expect(readProjectLink(`?org=${ORG}&project=${PROJECT}`)).toEqual(LINK);
  });

  it("reads the module's directory without its surrounding slashes", () => {
    expect(readProjectLink(`?org=${ORG}&project=${PROJECT}&module=%2Fapps%2Ftodo%2F`)).toEqual({
      ...LINK,
      modulePath: "apps/todo",
    });
  });

  it("is no link without both ids, with a malformed one, or beside `open`", () => {
    expect(readProjectLink("")).toBeNull();
    expect(readProjectLink(`?project=${PROJECT}`)).toBeNull();
    expect(readProjectLink(`?org=${ORG}`)).toBeNull();
    expect(readProjectLink(`?org=acme&project=${PROJECT}`)).toBeNull();
    expect(readProjectLink(`?org=${ORG}&project=../x`)).toBeNull();
    expect(readProjectLink(`?org=${ORG}&project=${PROJECT}&open=https%3A%2F%2Fx%2Ftelo.yaml`)).toBeNull();
  });
});

describe("decideProjectLink", () => {
  it("waits for the session", () => {
    expect(decideProjectLink(LINK, { status: "loading" }, false)).toEqual({ action: "wait" });
  });

  it("ignores the link on an origin with no Cloud", () => {
    expect(decideProjectLink(LINK, { status: "unavailable" }, false)).toEqual({ action: "ignore" });
  });

  it("opens the project when signed in to its organization", () => {
    expect(decideProjectLink(LINK, signedInTo(ORG), false)).toEqual({ action: "open" });
    expect(decideProjectLink(LINK, signedInTo(ORG), true)).toEqual({ action: "open" });
  });

  it("signs in once when signed out or in another organization", () => {
    expect(decideProjectLink(LINK, { status: "anonymous" }, false)).toEqual({ action: "signIn" });
    expect(decideProjectLink(LINK, signedInTo("org_ff"), false)).toEqual({ action: "signIn" });
  });

  it("refuses instead of signing in a second time", () => {
    expect(decideProjectLink(LINK, { status: "anonymous" }, true).action).toBe("refuse");
    expect(decideProjectLink(LINK, signedInTo("org_ff"), true).action).toBe("refuse");
  });

  it("refuses when Cloud could not be asked", () => {
    expect(decideProjectLink(LINK, { status: "unreachable", message: "offline" }, false)).toEqual({
      action: "refuse",
      message: "Telo Cloud could not be reached, so the linked project was not opened: offline",
    });
  });
});
