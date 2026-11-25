import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { requestValidation } from "../src/request-validation-problem.js";

/**
 * A route's schema pattern is RE2, read through the SDK's schema pattern seam as
 * every Telo validator reads it: a pattern RE2 refuses stops the server at start,
 * and a pattern it reads matches as RE2 matches.
 */
describe("request validation patterns", () => {
  it("refuses a route whose schema holds a pattern RE2 cannot read", async () => {
    const app = Fastify({ logger: false, ...requestValidation });
    app.get("/codes", { schema: { querystring: { type: "object", properties: { code: { type: "string", pattern: "^(?!osd$)[a-z]+$" } } } } }, async () => ({}));
    await expect(app.ready()).rejects.toThrow('invalid RE2 pattern "^(?!osd$)[a-z]+$": invalid or unsupported Perl syntax');
    await app.close();
  });

  it("matches a request value as RE2 does", async () => {
    const app = Fastify({ logger: false, ...requestValidation });
    app.post(
      "/codes",
      { schema: { body: { type: "object", properties: { code: { type: "string", pattern: "^\\x{41}.$" }, pattern: { type: "string", format: "regex" } } } } },
      async () => ({ ok: true }),
    );
    const answer = async (body: unknown) => (await app.inject({ method: "POST", url: "/codes", payload: body as object })).statusCode;
    expect(await answer({ code: "A\r" })).toBe(200);
    expect(await answer({ code: "A\n" })).toBe(400);
    expect(await answer({ pattern: "\\x{41}" })).toBe(200);
    expect(await answer({ pattern: "(?=x)" })).toBe(400);
    await app.close();
  });
});
