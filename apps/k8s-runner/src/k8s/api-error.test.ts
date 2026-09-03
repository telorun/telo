import { ApiException } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { apiFailure, apiReason } from "./api-error.js";

/** A 403 with an arbitrary admission message. `body` is the raw JSON text,
 *  which is what the client-node deserializer leaves for a status code it does
 *  not recognize — exactly the 403 case ("Unknown API Status Code!"). */
function forbidden(message: string): ApiException<string> {
  const body = JSON.stringify({
    kind: "Status",
    apiVersion: "v1",
    status: "Failure",
    message,
    reason: "Forbidden",
    code: 403,
  });
  return new ApiException<string>(403, "Unknown API Status Code!", body, {
    "audit-id": "240bebaf-17aa-4684-8732-210b5b720f5a",
    "x-kubernetes-pf-flowschema-uid": "f895735a-d707-400c-88de-23e24406fa8c",
  });
}

const RBAC_DENIAL =
  'pods is forbidden: User "system:serviceaccount:telo-runner:telo-k8s-runner" cannot create resource "pods" in the namespace "telo-sessions"';
const QUOTA_DENIAL =
  'pods "telo-run-abc" is forbidden: exceeded quota: telo-k8s-runner-sessions, requested: pods=1, used: pods=32, limited: pods=32';

describe("apiReason", () => {
  it("keeps the status and reason, and nothing else the exception carried", () => {
    const reason = apiReason(forbidden(RBAC_DENIAL));
    expect(reason).toContain("Forbidden");
    expect(reason).toContain("403");
    // The whole point: no cluster identities, no audit id, no headers.
    expect(reason).not.toContain("system:serviceaccount");
    expect(reason).not.toContain("audit-id");
    expect(reason).not.toContain("flowschema");
  });

  it("names RBAC as the fix for a rejection only the operator can clear", () => {
    expect(apiReason(forbidden(RBAC_DENIAL))).toContain("RBAC");
  });

  it("tells a quota rejection from an RBAC one — same code, same reason", () => {
    // The chart ships a 32-pod ResourceQuota enabled by default, so the 33rd
    // session is a 403 `Forbidden` that has nothing to do with RBAC. Sending
    // that operator to re-check a Role is the wrong action at the one moment
    // the message is read under load.
    const reason = apiReason(forbidden(QUOTA_DENIAL));
    expect(reason).toContain("quota");
    expect(reason).not.toContain("RBAC");
    // The admission message is classified, never echoed.
    expect(reason).not.toContain("telo-k8s-runner-sessions");
  });

  it("stays neutral on a 403 whose message identifies neither", () => {
    const reason = apiReason(forbidden("denied by a validating webhook"));
    expect(reason).toContain("rejected the request");
    expect(reason).not.toContain("RBAC");
    expect(reason).not.toContain("quota");
  });

  it("reads a parsed status body as well as a raw one", () => {
    const parsed = new ApiException<unknown>(404, "Not Found", { reason: "NotFound" }, {});
    expect(apiReason(parsed)).toContain("NotFound");
  });

  it("reports an unreachable apiserver as unreachable, not as a rejection", () => {
    // A system error's `code` is a STRING and a DOMException's is a small
    // number, both in the field an HTTP status also lands in. Reading either as
    // a status claimed the apiserver refused something it was never asked.
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const aborted = Object.assign(new Error("The operation was aborted"), { code: 20 });
    for (const err of [refused, aborted, new Error("socket hang up")]) {
      expect(apiReason(err)).toBe("the Kubernetes API could not be reached");
    }
  });
});

describe("apiFailure", () => {
  it("carries the raw exception as `cause` so the runner log keeps the detail", () => {
    const raw = forbidden(RBAC_DENIAL);
    const failure = apiFailure(raw, "create", "could not create the session pod");
    expect(failure.stage).toBe("create");
    expect(failure.message).toContain("could not create the session pod");
    expect(failure.message).not.toContain("system:serviceaccount");
    expect(failure.cause).toBe(raw);
  });
});
