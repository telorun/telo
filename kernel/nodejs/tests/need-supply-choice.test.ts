import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A library need supplied behind a choice — at the entry's own import, and at
 * a library's import through the binding of its input — is supplied only where
 * the option taken writes the supply; where it is left out the need is read
 * from the environment, as an unsupplied one is.
 */
const AGREEMENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/check-run-agreement",
);

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.teardown();
});

async function address(fixture: string, env: Record<string, string>): Promise<unknown> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env });
  kernels.push(kernel);
  try {
    await kernel.load(path.join(AGREEMENT, fixture));
    await kernel.boot();
  } catch (error) {
    return error;
  }
  return (await kernel.invoke<unknown, { url: unknown }>({ kind: "Telo.Sequence", name: "read" }, {})).url;
}

describe.each([
  ["need-supply-choice/supply-off.yaml", "TELO_NEED_LIB__DB__URL"],
  ["inner-need-choice/choice-off.yaml", "TELO_NEED_OUTER__INNER__DB__URL"],
])("a need supplied behind a choice (%s)", (fixture, variable) => {
  it("hands the library the fulfilment where the option writing it is taken", async () => {
    expect(await address(fixture, { FLAG_1: "true" })).toBe("postgres://from-fulfilment");
  }, 60_000);

  it("refuses the load naming the variable where the option leaves it out", async () => {
    expect(await address(fixture, { FLAG_1: "false" })).toMatchObject({
      code: "ERR_NEED_UNMET",
      message: expect.stringContaining(`Set ${variable}`),
    });
  }, 60_000);

  it("reads it from the environment where the option leaves it out", async () => {
    expect(await address(fixture, { FLAG_1: "false", [variable]: "postgres://from-the-environment" })).toBe(
      "postgres://from-the-environment",
    );
  }, 60_000);
});
