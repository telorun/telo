import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A family member's identity is `<family><index path>` where the kernel names a
 * resource — its span's `telo.resource.name` — and is keyed by its element, so
 * an app rebuilt with an element inserted before it names it the same.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.resolve(here, "../../../modules");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const app = (jobs: string) => `kind: Telo.Application
metadata: { name: FamilyIdentity }
imports:
  Schedule: ${path.join(MODULES, "scheduler")}
  Run: ${path.join(MODULES, "run")}
logging:
  sinks:
    - kind: Telo.ConsoleSink
      destination: stdout
      encoding: json
tracing:
  sinks:
    - kind: Telo.LogTraceSink
targets:
  - !ref jobs
---
kind: Telo.Definition
metadata: { name: ScheduledJobs }
capability: Telo.Service
schema:
  type: object
  required: [jobs]
  properties:
    jobs:
      type: object
      additionalProperties:
        type: object
        required: [cron, invoke]
        properties:
          cron: { type: string }
          invoke: { x-telo-ref: { kind: Telo.Executable, use: trigger.inbound } }
resources:
  - !for-each
    metadata: { name: crons }
    in: !cel "self.jobs"
    emit:
      kind: Schedule.Cron
      cron: !cel "each.value.cron"
      invoke: !cel "each.value.invoke"
targets:
  - !for-each
    in: !cel "self.jobs"
    emit: !ref crons[each.key]
---
kind: Run.Sequence
metadata: { name: buildReport }
steps:
  - name: report
    value: 1
---
kind: Self.ScheduledJobs
metadata: { name: jobs }
jobs:
${jobs}
`;

const NIGHTLY = `  nightlyReport:
    cron: "* * * * * *"
    invoke: !ref buildReport
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CLEANUP = `  hourlyCleanup:
    cron: "* * * * * *"
    invoke: !ref buildReport
`;

/** Boot `text`, let the crons fire, and answer the resource names its spans
 *  carry. */
async function spanResourceNames(appPath: string, text: string): Promise<(string | undefined)[]> {
  await fs.writeFile(appPath, text);
  const chunks: string[] = [];
  const stdout = { write: (chunk: string) => void chunks.push(String(chunk)) } as never;
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {}, stdout });
  try {
    await kernel.load(appPath);
    await kernel.boot();
    await kernel.runTargets();
    await sleep(1300);
  } finally {
    await kernel.teardown();
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((record) => record.event_name === "telo.span")
    .map((record) => record.attributes?.["telo.resource.name"] as string | undefined);
}

describe("a family member's identity", () => {
  it("names its spans by its family and its element's key, whatever position the element takes", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-family-identity-")));
    dirs.push(dir);
    const appPath = path.join(dir, "telo.yaml");

    const first = await spanResourceNames(appPath, app(NIGHTLY));
    expect(first).toContain("crons['nightlyReport']");

    // The app rebuilt with an element inserted before it: the member keeps its name.
    const second = await spanResourceNames(appPath, app(`${CLEANUP}${NIGHTLY}`));
    expect(second).toContain("crons['nightlyReport']");
    expect(second).toContain("crons['hourlyCleanup']");
  }, 20_000);
});
