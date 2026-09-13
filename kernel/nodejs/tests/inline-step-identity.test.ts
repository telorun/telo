import { getRefIdentity } from "@telorun/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/inline-step-identity/telo.yaml");

/**
 * The names an inline step target has always been registered under, spelled out
 * rather than computed: `<OwnerKind><ownerName><step path><stepName>`, each part
 * PascalCased. They are durable identity — a journal records its target by kind,
 * name and module, and a replay that reaches a different name refuses the run — so
 * moving where the name is minted must not move the name.
 */
const EXPECTED = [
  "SequenceSeqSteps0First",
  "SequenceSeqSteps1Nested",
  "SequenceSequenceSeqSteps1NestedSteps0Deep",
  "LoopPollSteps0Tick",
  "IterationIterSteps0Each",
  "ProjectionProjSteps0Each",
  "IdempotentRegionSteps0Write",
  "WorkflowFlowSteps0Prepare",
];

describe("inline step targets keep the identity the step engine gave them", () => {
  let journalDir: string;
  beforeAll(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-step-identity-"));
  });
  afterAll(() => {
    fs.rmSync(journalDir, { recursive: true, force: true });
  });

  it("registers every inline step target under its path-derived name, with no pointer", async () => {
    const kernel = new Kernel({
      sources: [new LocalFileSource()],
      env: { INLINE_STEP_IDENTITY_JOURNAL: journalDir },
    });
    await kernel.load(APP);
    await kernel.boot();

    const root = (kernel as unknown as { rootContext: any }).rootContext;
    const identities = EXPECTED.map((name) => {
      const instance = root.resourceInstances.get(name)?.instance;
      return { name, identity: instance ? getRefIdentity(instance) : undefined };
    });

    for (const { name, identity } of identities) {
      expect(identity, name).toEqual({
        kind: name.endsWith("Nested") ? "Run.Sequence" : "Run.Value",
        name,
        origin: { module: root.source },
      });
    }

    await kernel.teardown();
  });
});
