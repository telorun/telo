import { describe, expect, it } from "vitest";
import { CloudApiError, type ProjectPlacementOption } from "../api";
import { consoleAppUrl, consoleEnvironmentUrl, consoleStagesUrl } from "../console-links";
import {
  initialPlacement,
  namespaceProblem,
  placementKey,
  placementLabel,
  placementRef,
  projectRefusalMessage,
  slugFrom,
  slugProblem,
} from "../new-project";
import { hasPermission } from "../session";

function option(id: string, overrides: Partial<ProjectPlacementOption> = {}): ProjectPlacementOption {
  return {
    placement: { kind: "target", targetId: id },
    name: id,
    provider: null,
    isDefault: false,
    ...overrides,
  };
}

describe("a new project's slug", () => {
  it("is derived from the name as Telo Cloud derives it", () => {
    expect(slugFrom("Online Shop")).toBe("online-shop");
    expect(slugFrom("  Café — 2  ")).toBe("cafe-2");
    expect(slugFrom("Über Résumé")).toBe("uber-resume");
    expect(slugFrom("!!!")).toBe("");
    expect(slugFrom("a".repeat(70))).toHaveLength(63);
    expect(slugFrom(`${"a".repeat(62)} b`)).toBe("a".repeat(62));
  });

  it("is refused before the request when Telo Cloud would refuse it", () => {
    expect(slugProblem("online-shop")).toBeNull();
    expect(slugProblem("")).not.toBeNull();
    expect(slugProblem("-shop")).not.toBeNull();
    expect(slugProblem("Shop")).not.toBeNull();
  });
});

describe("a registry namespace", () => {
  it("is 3 to 40 lowercase letters, digits and single hyphens", () => {
    expect(namespaceProblem("acme")).toBeNull();
    expect(namespaceProblem("ac")).not.toBeNull();
    expect(namespaceProblem("ac--me")).not.toBeNull();
    expect(namespaceProblem("Acme")).not.toBeNull();
  });
});

describe("where a new project's form starts", () => {
  it("starts on the organization's default", () => {
    const options = [option("tgt_1"), option("tgt_2", { isDefault: true })];
    expect(initialPlacement(options)).toBe("target:tgt_2");
  });

  it("starts on the only place there is", () => {
    expect(initialPlacement([option("tgt_1")])).toBe("target:tgt_1");
  });

  it("starts on none with several places and no default, and with no place at all", () => {
    expect(initialPlacement([option("tgt_1"), option("tgt_2")])).toBeNull();
    expect(initialPlacement([])).toBeNull();
  });

  it("names a placement by its kind and id, and sends nothing else of a listed one", () => {
    const listed = {
      kind: "subscription",
      subscriptionId: "sub_1",
      tierName: "Free",
      status: "active",
    } as unknown as ProjectPlacementOption["placement"];
    expect(placementKey(listed)).toBe("subscription:sub_1");
    expect(placementRef(listed)).toEqual({ kind: "subscription", subscriptionId: "sub_1" });
  });

  it("labels a place with its provider and with being the default", () => {
    expect(placementLabel(option("Cluster"))).toBe("Cluster");
    expect(
      placementLabel(
        option("Free", { provider: { name: "Acme Hosting", verified: true }, isDefault: true }),
      ),
    ).toBe("Free by Acme Hosting (organization default)");
  });
});

describe("a refused project", () => {
  it("is told in words by its code", () => {
    const refusal = (code: string, detail?: string) =>
      projectRefusalMessage(new CloudApiError(409, code, detail ? { detail } : {}));
    expect(refusal("slug_unavailable")).toMatch(/already has that slug/);
    expect(refusal("placement_required")).toMatch(/Choose where/);
    expect(refusal("subscription_ended")).toMatch(/has ended/);
    // The tier's own sentence says which limit, so it is shown as it came.
    expect(refusal("tier_limit_exceeded", "The tier allows 1 project.")).toBe(
      "The tier allows 1 project.",
    );
  });
});

describe("what a session may do", () => {
  it("is read from a signed-in session's permissions only", () => {
    const signedIn = {
      status: "signedIn" as const,
      identity: {
        user: { id: "usr_1", name: null, email: null },
        org: { id: "org_1" },
        permissions: ["cloud:access", "cloud:projects.create"],
        expiresAt: "t",
        consoleUrl: null,
      },
    };
    expect(hasPermission(signedIn, "cloud:projects.create")).toBe(true);
    expect(hasPermission(signedIn, "cloud:registry.manage")).toBe(false);
    expect(hasPermission({ status: "anonymous" }, "cloud:projects.create")).toBe(false);
    expect(hasPermission({ status: "loading" }, "cloud:projects.create")).toBe(false);
  });
});

describe("links to the console", () => {
  it("are built on the origin the session names, at the console's paths", () => {
    const origin = "https://console.telo.cloud";
    expect(consoleStagesUrl(origin, "prj_1")).toBe("https://console.telo.cloud/p/prj_1/stages");
    expect(consoleAppUrl(origin, "prj_1", "app_1")).toBe(
      "https://console.telo.cloud/p/prj_1/apps/app_1",
    );
    expect(consoleEnvironmentUrl(origin, "prj_1", "app_1", "env_1")).toBe(
      "https://console.telo.cloud/p/prj_1/apps/app_1/env/env_1",
    );
  });

  it("are not built when the session names no console, or names no address", () => {
    expect(consoleStagesUrl(null, "prj_1")).toBeNull();
    expect(consoleStagesUrl("not an address", "prj_1")).toBeNull();
  });
});
