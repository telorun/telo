import { describe, expect, it } from "vitest";
import {
  AMBIENT_CONTRACT_ERROR_CODES,
  builtinErrorCodes,
  InvokeError,
  StepEngine,
  toSequenceError,
  type Step,
  type StepEngineContext,
  type TextRecord,
} from "../src/index.js";

const deep = new Error("deep");

/** A host whose `expandValue` is identity — a literal display message arrives
 *  already its record, as the kernel settles it — except that a step holding
 *  `explode` fails with the plain `deep` error. */
const context = {
  expandValue: (value: unknown) => {
    if (value && typeof value === "object" && "explode" in value) throw deep;
    return value;
  },
} as unknown as StepEngineContext;

async function failureOf(steps: unknown[]): Promise<unknown> {
  try {
    await new StepEngine(context, { kind: "Sequence", resourceName: "body" }).executeSteps(
      steps as Step[],
      {},
      undefined,
      {},
    );
  } catch (err) {
    return err;
  }
  throw new Error("expected the steps to throw");
}

const record: TextRecord = { text: "Item {$id} is missing.", context: null, lang: "en", computed: false };

describe("a throw: step", () => {
  it("refuses a display message that is no text record", async () => {
    const err = await failureOf([{ name: "fail", throw: { code: "NOT_FOUND", displayMessage: "Item is missing." } }]);
    expect(err).toMatchObject({ code: "ERR_TEXT_ARGUMENT_COMPUTED" });
  });

  it("records the failure its catch: branch caught as its cause", async () => {
    const coded = await failureOf([
      {
        name: "attempt",
        try: [{ name: "first", throw: { code: "FIRST" } }],
        catch: [{ name: "second", throw: { code: "SECOND" } }],
      },
    ]);
    expect(coded).toMatchObject({ code: "SECOND" });
    expect((coded as InvokeError).cause).toMatchObject({ code: "FIRST" });

    const plain = await failureOf([
      {
        name: "attempt",
        try: [{ name: "first", throw: { explode: true } }],
        catch: [{ name: "second", throw: { code: "SECOND" } }],
      },
    ]);
    expect((plain as InvokeError).cause).toBe(deep);
  });
});

describe("a rethrow: step", () => {
  it("re-raises the caught failure itself", async () => {
    const err = await failureOf([
      {
        name: "attempt",
        try: [{ name: "first", throw: { explode: true } }],
        catch: [{ name: "again", rethrow: {} }],
      },
    ]);
    expect(err).toBe(deep);
  });

  it("is refused in finally: and outside every catch:", async () => {
    for (const steps of [
      [{ name: "attempt", try: [], finally: [{ name: "again", rethrow: {} }] }],
      [{ name: "again", rethrow: {} }],
    ]) {
      expect(await failureOf(steps)).toMatchObject({ code: "ERR_RETHROW_WITHOUT_CAUGHT_ERROR" });
    }
  });
});

describe("a caught error", () => {
  it("carries its display message as `error.displayMessage`, null when it has none", () => {
    expect(
      toSequenceError(new InvokeError("X", "x", undefined, { displayMessage: record }), "s").displayMessage,
    ).toEqual(record);
    expect(toSequenceError(new InvokeError("X", "x"), "s").displayMessage).toBeNull();
    expect(toSequenceError(new Error("plain"), "s").displayMessage).toBeNull();
  });
});

describe("the built-in error codes", () => {
  it("give every ambient code an English display message", () => {
    const entries = builtinErrorCodes();
    expect(entries.map((entry) => entry.code).sort()).toEqual([...AMBIENT_CONTRACT_ERROR_CODES].sort());
    for (const entry of entries) expect(entry.record).toMatchObject({ lang: "en", computed: false });
  });
});
