import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fastifyValidationIssues, requestValidation } from "../src/request-validation-problem.js";

/**
 * A request the route's schema refuses answers with one finding per finding of
 * the validator: a JSON Pointer into the request as CEL reads it — the part, then
 * the path inside it, naming the property for one that is missing or undeclared —
 * and the keyword and params in the issue vocabulary, with no validator prose.
 * Driven through real Fastify with the server's validator options, since the
 * findings are Fastify's to produce. A body is validated as the JSON it is; a
 * query or path value is text, read into its declared type.
 */
describe("request validation findings", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, ...requestValidation });
    app.setErrorHandler(async (error, request, reply) => {
      const issues = fastifyValidationIssues(error);
      if (!issues) throw error;
      return reply.code(400).send({ issues });
    });
    app.post(
      "/batch",
      {
        schema: {
          body: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string", maxLength: 3 } } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    app.post(
      "/tasks/:id",
      {
        schema: {
          params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
          querystring: { type: "object", properties: { limit: { type: "integer", maximum: 100 } } },
          headers: { type: "object", properties: { "x-api-key": { type: "string", minLength: 4 } } },
          body: {
            type: "object",
            required: ["text"],
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              n: { type: "integer" },
              note: { type: "string", maxLength: 5 },
              dueOn: { type: "string", format: "date" },
              isDone: { type: "boolean" },
              size: { enum: ["s", "m"] },
              "a/b": { type: "string" },
              address: {
                type: "object",
                required: ["city"],
                properties: { street: { type: "string", maxLength: 3 }, city: { type: "string" } },
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name"],
                  additionalProperties: false,
                  properties: { name: { type: "string", maxLength: 3 } },
                },
              },
              either: { not: { type: "boolean" } },
            },
          },
        },
      },
      async (request) => ({ params: request.params, query: request.query }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function refusal(url: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await app.inject({ method: "POST", url, payload: body as object, headers });
    return response.json();
  }

  it.each([
    ["a value too long", "/tasks/1", { text: "a", note: "too long" }, { pointer: "/body/note", keyword: "maxLength", params: { limit: 5 } }],
    ["a bad format", "/tasks/1", { text: "a", dueOn: "tomorrow" }, { pointer: "/body/dueOn", keyword: "format", params: { format: "date" } }],
    ["a wrong type", "/tasks/1", { text: "a", isDone: "perhaps" }, { pointer: "/body/isDone", keyword: "type", params: { type: "boolean" } }],
    ["a null at a string property of a body", "/tasks/1", { text: null, n: null }, { pointer: "/body/text", keyword: "type", params: { type: "string" } }],
    ["text at an integer property of a body", "/tasks/1", { text: "a", n: "5" }, { pointer: "/body/n", keyword: "type", params: { type: "integer" } }],
    ["a value outside an enum", "/tasks/1", { text: "a", size: "xl" }, { pointer: "/body/size", keyword: "enum", params: { allowedValues: ["s", "m"] } }],
    ["a missing required property", "/tasks/1", { note: "a" }, { pointer: "/body/text", keyword: "required", params: { missingProperty: "text" } }],
    ["a property whose name needs escaping", "/tasks/1", { text: "a", "a/b": 1 }, { pointer: "/body/a~1b", keyword: "type", params: { type: "string" } }],
    ["a nested property", "/tasks/1", { text: "a", address: { street: "Long Lane", city: "x" } }, { pointer: "/body/address/street", keyword: "maxLength", params: { limit: 3 } }],
    ["a missing nested property", "/tasks/1", { text: "a", address: {} }, { pointer: "/body/address/city", keyword: "required", params: { missingProperty: "city" } }],
    ["an unknown property", "/tasks/1", { text: "a", nope: 1 }, { pointer: "/body/nope", keyword: "additionalProperties", params: { additionalProperty: "nope" } }],
    ["an unknown property inside a list item", "/tasks/1", { text: "a", items: [{ name: "a", nope: 1 }] }, { pointer: "/body/items/0/nope", keyword: "additionalProperties", params: { additionalProperty: "nope" } }],
    ["a missing required property inside a list item", "/tasks/1", { text: "a", items: [{}] }, { pointer: "/body/items/0/name", keyword: "required", params: { missingProperty: "name" } }],
    ["a property inside an item of a list body", "/batch", [{ name: "too long" }], { pointer: "/body/0/name", keyword: "maxLength", params: { limit: 3 } }],
    ["a keyword outside the vocabulary", "/tasks/1", { text: "a", either: true }, { pointer: "/body/either", keyword: "invalid", params: {} }],
    ["a query parameter", "/tasks/1?limit=abc", { text: "a" }, { pointer: "/query/limit", keyword: "type", params: { type: "integer" } }],
    ["a path parameter", "/tasks/abc", { text: "a" }, { pointer: "/params/id", keyword: "type", params: { type: "integer" } }],
  ])("names %s", async (_name, url, body, issue) => {
    expect(await refusal(url, body)).toEqual({ issues: [issue] });
  });

  it("names a header by its lowercased name", async () => {
    expect(await refusal("/tasks/1", { text: "a" }, { "X-Api-Key": "abc" })).toEqual({
      issues: [{ pointer: "/headers/x-api-key", keyword: "minLength", params: { limit: 4 } }],
    });
  });

  it("reads a query and a path value into the integers their schemas declare", async () => {
    expect(await refusal("/tasks/7?limit=5", { text: "a" })).toEqual({
      params: { id: 7 },
      query: { limit: 5 },
    });
  });
});
