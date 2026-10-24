import { describe, expect, it } from "vitest";
import { ResourceContextImpl } from "../src/resource-context.js";

/** `ctx.readPlainEncoded` builds a transport's inbound `Telo.Url` as a contract does:
 *  built, joining no redaction set, or refused as `ERR_INPUT_INVALID` carrying the
 *  type's entry. */
const schema = {
  type: "object",
  properties: {
    url: { "x-telo-type": { name: "Telo.Url", scheme: { enum: ["postgres", "postgresql"] } } },
  },
};

function context(redacted: string[]): ResourceContextImpl {
  const moduleContext = { addRedactedValues: (texts: Iterable<string>) => redacted.push(...texts) };
  return new ResourceContextImpl(
    { getAnalysisRegistry: () => ({ schemaForId: () => undefined }) } as never,
    moduleContext as never,
    { name: "route" },
  );
}

describe("ctx.readPlainEncoded at a Telo.Url slot", () => {
  it("builds the URL from its text, adding nothing to the module's redaction set across 1,000 values", () => {
    const redacted: string[] = [];
    const ctx = context(redacted);
    for (let i = 0; i < 1000; i++) {
      const read = ctx.readPlainEncoded({ url: `postgres://app:pw-${i}@db-${i}.internal/orders` }, schema) as {
        url: { host: string };
      };
      expect(read.url.host).toBe(`db-${i}.internal`);
    }
    expect(redacted).toEqual([]);
  });

  it("refuses text the slot refuses as ERR_INPUT_INVALID carrying the type's entry, never the value", () => {
    let refusal: { code?: string; message: string; data?: unknown } | undefined;
    try {
      context([]).readPlainEncoded({ url: "mysql://app:pw-7@db.internal/orders" }, schema);
    } catch (error) {
      refusal = error as typeof refusal;
    }
    expect(refusal?.code).toBe("ERR_INPUT_INVALID");
    expect(refusal?.data).toEqual({
      issues: [
        { pointer: "/url", keyword: "format", params: { format: "Telo.Url" }, code: "ERR_URL_INVALID" },
      ],
    });
    expect(refusal?.message).toBe(
      "/url: ERR_URL_INVALID: not a Telo.Url — its scheme must be one of postgres, postgresql",
    );
    expect(`${refusal?.message}${JSON.stringify(refusal?.data)}`).not.toContain("pw-7");
  });
});
