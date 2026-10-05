import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpRunnerAdapter } from "../adapter";
import { TeloVersionRefusedError, type RunRequest } from "../../../types";

/** The editor's half of version alignment on the wire: what a run naming its
 *  telo version sends, and what a runner's refusal becomes. */
const CONFIG = { baseUrl: "http://runner.test", image: "img", pullPolicy: "missing" as const };

const REQUEST: RunRequest = {
  bundle: { entryRelativePath: "telo.yaml", files: [{ relativePath: "telo.yaml", contents: "x" }] },
};

let bodies: Array<Record<string, unknown>>;

function stubFetch(response: () => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return response();
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
      readyState = 0;
      static readonly CLOSED = 2;
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      addEventListener() {}
      close() {}
      readyState = 0;
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("a run naming its telo version", () => {
  it("sends the version and leaves out the config the runner deprecates for it", async () => {
    stubFetch(() => json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }));

    await httpRunnerAdapter.start({ ...REQUEST, telo: "0.80.0", withheldConfig: ["image"] }, CONFIG);

    expect(bodies[0]!.telo).toBe("0.80.0");
    expect(bodies[0]!.config).toEqual({ pullPolicy: "missing" });
  });

  it("sends neither to a runner that aligns nothing", async () => {
    stubFetch(() => json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }));

    await httpRunnerAdapter.start(REQUEST, CONFIG);

    expect(bodies[0]).not.toHaveProperty("telo");
    expect(bodies[0]!.config).toEqual({ image: "img", pullPolicy: "missing" });
  });

  it("turns the runner's refusal into its own error, carrying the runner's reason", async () => {
    stubFetch(() =>
      json(
        {
          error: "telo_version_unavailable",
          message: "telo 0.80.0 cannot be run for app 'app': no release",
          app: "app",
          version: "0.80.0",
          reason: "telo 0.80.0 publishes no binary for linux-amd64-gnu (HTTP 404)",
        },
        400,
      ),
    );

    const refusal = await httpRunnerAdapter
      .start({ ...REQUEST, telo: "0.80.0" }, CONFIG)
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(TeloVersionRefusedError);
    expect(refusal).toMatchObject({
      code: "telo_version_unavailable",
      version: "0.80.0",
      reason: "telo 0.80.0 publishes no binary for linux-amd64-gnu (HTTP 404)",
    });
  });
});
