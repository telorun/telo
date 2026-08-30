import { afterEach, describe, expect, it, vi } from "vitest";

import { launchAgentSession } from "../launch";
import { TermsRequiredError } from "../../run/types";

const terms = { version: "2026-01", title: "Usage terms", body: "Be nice." };

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("launchAgentSession", () => {
  // A terms-enforcing runner refuses the launch with the agreement itself. It
  // has to reach the caller intact, or the panel can only tell the user to go
  // and find the terms somewhere else in the editor.
  it("carries a 428's terms out as TermsRequiredError", async () => {
    respondWith(428, { error: "terms_required", terms });
    await expect(launchAgentSession("http://runner")).rejects.toMatchObject({
      name: "TermsRequiredError",
      terms,
    });
    await expect(launchAgentSession("http://runner")).rejects.toBeInstanceOf(TermsRequiredError);
  });

  it("reports a 428 with no terms as a plain error", async () => {
    respondWith(428, undefined);
    await expect(launchAgentSession("http://runner")).rejects.not.toBeInstanceOf(
      TermsRequiredError,
    );
  });

  it("sends the accepted terms version so an accepted agreement isn't re-gated", async () => {
    respondWith(428, { error: "terms_required", terms });
    await launchAgentSession("http://runner", "2026-01").catch(() => undefined);
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["x-telo-accepted-terms"]).toBe("2026-01");
  });
});
