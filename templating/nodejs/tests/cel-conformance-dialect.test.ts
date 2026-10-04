import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";
import { CONFORMANCE_HANDLERS, runDialectRow, type DialectRow } from "./cel-conformance-dialect.js";
import { conformanceValueCodec } from "./cel-conformance-value.js";

const env = buildCelEnvironment(CONFORMANCE_HANDLERS);
const codec = conformanceValueCodec();
const row = (source: string): DialectRow => ({
  id: "scratch/json/unwritable",
  tag: "cel",
  source,
  expect: { check: { diagnostics: [], calls: [], regions: [] } },
});

describe("a dialect row handing a conformance handler a value the typed frame cannot write", () => {
  it("fails as malformed instead of answering with the writer's refusal", async () => {
    await expect(runDialectRow(env, codec, row("json(optional.of(1))"))).rejects.toThrow(
      "The row 'scratch/json/unwritable' is malformed: the handler 'json' was handed a value the typed frame cannot write",
    );
  });

  it("fails as malformed when an operator absorbs the refusal", async () => {
    await expect(runDialectRow(env, codec, row("json(optional.of(1)) == 'x' || true"))).rejects.toThrow(
      "The row 'scratch/json/unwritable' is malformed",
    );
  });

  it("keeps the record to the evaluation it happened in", async () => {
    const [malformed, sound] = await Promise.allSettled([
      runDialectRow(env, codec, row("json(optional.of(1))")),
      runDialectRow(env, codec, row("json('x')")),
    ]);
    expect(malformed.status).toBe("rejected");
    expect(sound).toMatchObject({ status: "fulfilled", value: { value: 'json("x")' } });
  });
});
