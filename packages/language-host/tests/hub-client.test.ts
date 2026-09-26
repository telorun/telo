import { describe, expect, it } from "vitest";
import { HubClient } from "../src/hub-client.js";

const PIN = `sha256-${"Ab1_".repeat(11).slice(0, 43)}`;

function hub(answer: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  const client = new HubClient({
    url: () => "https://hub.test/",
    fetch: (async (input: string | URL | Request) => {
      asked.push(String(input));
      return answer(String(input));
    }) as typeof globalThis.fetch,
  });
  return { client, asked };
}

const json = (body: unknown) => new Response(JSON.stringify(body));

describe("the hub client", () => {
  it("reads a module's versions in the route's order, with their pins", async () => {
    const { client, asked } = hub(() =>
      json({ ref: "oci://ghcr.io/telorun/timer", versions: [{ version: "2.1.0", integrity: PIN }, { version: "2.0.0" }] }),
    );
    expect(await client.listVersions("oci://ghcr.io/telorun/timer")).toEqual([
      { version: "2.1.0", integrity: PIN },
      { version: "2.0.0" },
    ]);
    expect(asked).toEqual(["https://hub.test/module/versions?ref=oci%3A%2F%2Fghcr.io%2Ftelorun%2Ftimer"]);
  });

  // A pin is spliced into the author's YAML, so a malformed one becomes "no
  // pin", never corrupt text.
  it("drops an integrity that is not a canonical pin, keeping the version", async () => {
    const { client } = hub(() => json({ versions: [{ version: "1.0.0", integrity: "sha256-nope" }] }));
    expect(await client.listVersions("oci://x/y")).toEqual([{ version: "1.0.0" }]);
  });

  it("tolerates every shape a hub could answer with", async () => {
    for (const body of [null, {}, { versions: "1.0.0" }, { versions: ["1.0.0", { version: "" }, null] }]) {
      expect(await hub(() => json(body)).client.listVersions("oci://x/y")).toEqual([]);
    }
  });

  it("answers an untracked ref with no versions", async () => {
    expect(await hub(() => new Response("", { status: 404 })).client.listVersions("oci://x/y")).toEqual([]);
  });

  it("rejects naming the hub when it cannot be reached or fails", async () => {
    await expect(
      hub(() => {
        throw new TypeError("fetch failed");
      }).client.searchRefs("timer"),
    ).rejects.toThrow("could not reach the telo hub at https://hub.test: fetch failed");
    await expect(hub(() => new Response("", { status: 500 })).client.searchRefs("timer")).rejects.toThrow(
      /the telo hub answered HTTP 500/,
    );
  });

  it("rejects naming the hub when its answer is not JSON", async () => {
    await expect(
      hub(() => new Response("<html>502 Bad Gateway</html>", { status: 200 })).client.listVersions("oci://x/y"),
    ).rejects.toThrow(
      /^the telo hub at https:\/\/hub\.test answered https:\/\/hub\.test\/module\/versions\?ref=oci%3A%2F%2Fx%2Fy with something that is not JSON: /,
    );
  });

  it("reads ref search results, dropping entries with no ref", async () => {
    const { client } = hub(() =>
      json({ refs: [{ ref: "oci://ghcr.io/telorun/timer", latestVersion: "2.1.0", description: "Timers" }, { latestVersion: "1" }] }),
    );
    expect(await client.searchRefs("timer")).toEqual([
      { ref: "oci://ghcr.io/telorun/timer", latestVersion: "2.1.0", description: "Timers" },
    ]);
  });
});
