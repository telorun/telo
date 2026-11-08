import { makeTarGz } from "@telorun/kernel";
import { createHash } from "node:crypto";
import nock from "nock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upgradeManifest } from "../src/commands/upgrade.js";
import { createLogger } from "../src/logger.js";
import { Output, installOutput } from "../src/output.js";

const HOST = "oci.example.test";
const ORIGIN = `https://${HOST}`;
const REPO = "acme/geocode";
const log = createLogger(false);

const BROKEN = "Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.";
const NODE = "Lookup's HTTP client crashes on Node 24; a fix ships in 1.3.0.";
const LIFTED = "Lookup works on every telo again since telo 0.122.1 fixed the regression.";

const doc = (version: string, floor: string, restrictions = ""): string =>
  `kind: Telo.Library\nmetadata:\n  name: Geocode\n  version: ${version}\nrequires:\n  telo: "${floor}"\n${restrictions}`;

const HISTORY: Record<string, string> = {
  "1.1.0": doc("1.1.0", ">=0.119.0"),
  "1.2.0": doc("1.2.0", ">=0.121.0"),
  "1.2.1": doc(
    "1.2.1",
    ">=0.121.0",
    `restrictions:
  - versions: ">=1.2.0"
    requires: { telo: "<0.122.0" }
    reason: ${BROKEN}
  - versions: ">=1.2.0"
    requires: { host: { node: "<24.0.0" } }
    reason: ${NODE}
`,
  ),
  "1.3.0": doc("1.3.0", ">=0.123.0"),
  "1.3.1": doc(
    "1.3.1",
    ">=0.123.0",
    `restrictions:
  - versions: ">=1.2.0 <=1.2.1"
    requires: { telo: ">=0.121.0" }
    reason: ${LIFTED}
`,
  ),
  "1.3.0-rc.1": doc(
    "1.3.0-rc.1",
    ">=0.123.0",
    `restrictions:
  - versions: ">=1.2.0"
    requires: { telo: "<0.122.0" }
    reason: ${BROKEN}
`,
  ),
  "1.4.0": doc(
    "1.4.0",
    ">=0.123.0",
    `restrictions:
  - versions: ">=1.2.0 <=1.2.0"
    requires: { telo: ">=0.121.0" }
    reason: ${LIFTED}
`,
  ),
};

let stdout: string;
let restore: () => void;

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());

beforeEach(() => {
  stdout = "";
  const sink = (capture: boolean) => ({
    isTTY: false,
    write(chunk: string) {
      if (capture) stdout += chunk;
      return true;
    },
  });
  restore = installOutput(new Output({ format: "text", stdout: sink(true), stderr: sink(false), env: {} }));
});

afterEach(() => {
  restore();
  nock.cleanAll();
});

/** The registry serving `versions` of Geocode, each with its own manifest. */
async function serve(versions: string[]): Promise<void> {
  nock(ORIGIN).persist().get(`/v2/${REPO}/tags/list`).query(true).reply(200, { name: REPO, tags: versions });
  for (const version of versions) {
    const tar = await makeTarGz([{ name: "telo.yaml", content: HISTORY[version]! }]);
    const digest = `sha256:${createHash("sha256").update(tar).digest("hex")}`;
    nock(ORIGIN)
      .persist()
      .get(`/v2/${REPO}/manifests/${version}`)
      .reply(200, {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.oci.empty.v1+json", digest, size: 0 },
        layers: [{ mediaType: "application/vnd.telo.module.manifest.v1+tar", digest, size: tar.length }],
      });
    nock(ORIGIN).persist().get(`/v2/${REPO}/blobs/${digest}`).reply(200, tar);
  }
}

const app = (pin: string): string =>
  `kind: Telo.Application\nmetadata:\n  name: StoreLocator\n  version: 1.0.0\nimports:\n  Geocode: oci://${HOST}/${REPO}@${pin}#sha256-PINNED\n`;

async function upgradeOn(telo: string, node: string, pin: string, versions: string[]) {
  await serve(versions);
  const input = app(pin);
  const { content, result } = await upgradeManifest({
    content: input,
    includePrerelease: false,
    log,
    runtime: { telo, host: { node } },
  });
  return { input, content, result, printed: stdout.replace(/\x1b\[[0-9;]*m/g, "") };
}

describe("telo upgrade — restrictions", () => {
  it("names the restriction a later version puts on the pin, and holds that version back", async () => {
    const { input, content, printed } = await upgradeOn("0.122.0", "22.0.0", "1.2.0", ["1.1.0", "1.2.0", "1.2.1"]);
    expect(content).toBe(input);
    expect(printed).toContain(`Geocode: oci://${HOST}/${REPO}@1.2.0 is restricted by 1.2.1: ${BROKEN}`);
    expect(printed).toContain(`held back: 1.2.1 — ${BROKEN}`);
  });

  it("leaves a pin below the restricted versions where it is, grouping the versions held by one reason", async () => {
    const { input, content, printed } = await upgradeOn("0.122.0", "22.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.2.1"]);
    expect(content).toBe(input);
    expect(printed).toContain(`Geocode: oci://${HOST}/${REPO}@1.1.0 is the newest version this telo can use.`);
    expect(printed).toContain(`held back: 1.2.1 and 1.2.0 — ${BROKEN}`);
  });

  it("holds a version back for the telo it requires, beside the restriction that still holds", async () => {
    const { printed } = await upgradeOn("0.122.0", "22.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.2.1", "1.3.0"]);
    expect(printed).toContain("held back: 1.3.0 requires telo '>=0.123.0'; this runtime reports 0.122.0.");
    expect(printed).toContain(`held back: 1.2.1 and 1.2.0 — ${BROKEN}`);
  });

  it("selects the version a later release lifted the restriction from, and keeps the one its own entry holds", async () => {
    const { content, printed } = await upgradeOn("0.122.1", "22.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.2.1", "1.3.0", "1.3.1"]);
    expect(content).toContain(`oci://${HOST}/${REPO}@1.2.0`);
    expect(printed).toContain("held back: 1.3.1 and 1.3.0 require telo '>=0.123.0'; this runtime reports 0.122.1.");
    expect(printed).toContain(`held back: 1.2.1 — ${BROKEN}`);
  });

  it("holds both back on a Node the entry restricts, and selects the newest on the one it does not", async () => {
    const onNode24 = await upgradeOn("0.121.0", "24.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.2.1"]);
    expect(onNode24.content).toBe(onNode24.input);
    expect(onNode24.printed).toContain(`held back: 1.2.1 and 1.2.0 — ${NODE}`);

    nock.cleanAll();
    stdout = "";
    const onNode22 = await upgradeOn("0.121.0", "22.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.2.1"]);
    expect(onNode22.content).toContain(`oci://${HOST}/${REPO}@1.2.1`);
  });

  it("lets a prerelease restrict a version when no release speaks, and never when one does", async () => {
    const pre = await upgradeOn("0.122.0", "22.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.3.0-rc.1"]);
    expect(pre.content).toBe(pre.input);
    expect(pre.printed).toContain(`held back: 1.2.0 — ${BROKEN}`);

    nock.cleanAll();
    stdout = "";
    const released = await upgradeOn("0.122.0", "22.0.0", "1.1.0", ["1.1.0", "1.2.0", "1.3.0-rc.1", "1.4.0"]);
    expect(released.content).toContain(`oci://${HOST}/${REPO}@1.2.0`);
  });
});
