import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { podFailureMessage } from "./backend.js";

function pod(status: V1Pod["status"]): V1Pod {
  return { apiVersion: "v1", kind: "Pod", status };
}

describe("podFailureMessage — surfaces the real cause", () => {
  it("reports a failed init container (the supervisor copy)", () => {
    const msg = podFailureMessage(
      pod({
        phase: "Failed",
        initContainerStatuses: [
          {
            name: "supervisor",
            image: "busybox",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 1, reason: "Error" } },
          },
        ],
      }),
    );
    expect(msg).toBe('init container "supervisor" failed: Error (exit code 1)');
  });

  it("includes the terminated message when present", () => {
    const msg = podFailureMessage(
      pod({
        phase: "Failed",
        initContainerStatuses: [
          {
            name: "supervisor",
            image: "busybox",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 1, reason: "Error", message: "cp: cannot stat" } },
          },
        ],
      }),
    );
    expect(msg).toBe('init container "supervisor" failed: Error (exit code 1): cp: cannot stat');
  });

  it("surfaces a blocking waiting reason like ImagePullBackOff", () => {
    const msg = podFailureMessage(
      pod({
        phase: "Pending",
        initContainerStatuses: [
          {
            name: "supervisor",
            image: "busybox",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } },
          },
        ],
      }),
    );
    expect(msg).toBe('init container "supervisor" waiting: ImagePullBackOff: Back-off pulling image');
  });

  it("skips a succeeded init container and reports the failing main container", () => {
    const msg = podFailureMessage(
      pod({
        phase: "Failed",
        initContainerStatuses: [
          {
            name: "supervisor",
            image: "busybox",
            imageID: "",
            ready: true,
            restartCount: 0,
            state: { terminated: { exitCode: 0, reason: "Completed" } },
          },
        ],
        containerStatuses: [
          {
            name: "session",
            image: "telo",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
          },
        ],
      }),
    );
    expect(msg).toBe('container "session" failed: OOMKilled (exit code 137)');
  });

  it("ignores benign transient waiting reasons", () => {
    const msg = podFailureMessage(
      pod({
        phase: "Failed",
        reason: "DeadlineExceeded",
        message: "Pod was active on the node longer than the specified deadline",
        containerStatuses: [
          {
            name: "session",
            image: "telo",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: "PodInitializing" } },
          },
        ],
      }),
    );
    expect(msg).toBe("Pod was active on the node longer than the specified deadline");
  });

  it("falls back to pod-level reason when no container detail exists", () => {
    const msg = podFailureMessage(pod({ phase: "Failed", reason: "Evicted" }));
    expect(msg).toBe("Evicted");
  });

  it("returns the bare fallback only when nothing is known", () => {
    expect(podFailureMessage(pod({ phase: "Failed" }))).toBe("pod failed");
    expect(podFailureMessage(undefined)).toBe("pod failed");
  });

  it("truncates an oversized detail message", () => {
    const long = "x".repeat(800);
    const msg = podFailureMessage(
      pod({
        phase: "Failed",
        containerStatuses: [
          {
            name: "session",
            image: "telo",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 1, message: long } },
          },
        ],
      }),
    );
    expect(msg.endsWith("…")).toBe(true);
    expect(msg.length).toBeLessThan(560);
  });
});
