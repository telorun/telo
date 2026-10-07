import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  convertFastifyValidationError,
  requestValidation,
} from "../src/request-validation-envelope.js";

/**
 * A request the route's schema refuses answers with one detail per finding of
 * the validator: the validated part, the path from that part's root — property
 * names joined by `.`, a list position in brackets — and the validator's own
 * sentence. Driven through real Fastify with the server's validator options,
 * since the findings are Fastify's to produce. A body is validated as the JSON
 * it is; a query or path value is text, read into its declared type.
 */
describe("request validation details", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, ...requestValidation });
    app.setErrorHandler(async (error, request, reply) => {
      const envelope = convertFastifyValidationError(error);
      if (!envelope) throw error;
      return reply.code(400).send(envelope);
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

  async function refusal(url: string, body: unknown) {
    const response = await app.inject({ method: "POST", url, payload: body as object });
    return response.json();
  }

  const envelope = (detail: { location: string; path: string; message: string }) => ({
    error: "ValidationError",
    message: "Request validation failed",
    status: 400,
    details: [detail],
  });

  it.each([
    [
      "a value too long",
      "/tasks/1",
      { text: "a", note: "too long" },
      { location: "body", path: "note", message: "must NOT have more than 5 characters" },
    ],
    [
      "a bad format",
      "/tasks/1",
      { text: "a", dueOn: "tomorrow" },
      { location: "body", path: "dueOn", message: 'must match format "date"' },
    ],
    [
      "a wrong type",
      "/tasks/1",
      { text: "a", isDone: "perhaps" },
      { location: "body", path: "isDone", message: "must be boolean" },
    ],
    [
      "a null at a string property of a body",
      "/tasks/1",
      { text: null, n: null },
      { location: "body", path: "text", message: "must be string" },
    ],
    [
      "a null at an integer property of a body",
      "/tasks/1",
      { text: "a", n: null },
      { location: "body", path: "n", message: "must be integer" },
    ],
    [
      "text at an integer property of a body",
      "/tasks/1",
      { text: "a", n: "5" },
      { location: "body", path: "n", message: "must be integer" },
    ],
    [
      "a missing required property",
      "/tasks/1",
      { note: "a" },
      { location: "body", path: "text", message: "is a required property" },
    ],
    [
      "a nested property",
      "/tasks/1",
      { text: "a", address: { street: "Long Lane", city: "x" } },
      { location: "body", path: "address.street", message: "must NOT have more than 3 characters" },
    ],
    [
      "a missing nested property",
      "/tasks/1",
      { text: "a", address: {} },
      { location: "body", path: "address.city", message: "is a required property" },
    ],
    [
      "an unknown property",
      "/tasks/1",
      { text: "a", nope: 1 },
      { location: "body", path: "nope", message: "must NOT have additional properties" },
    ],
    [
      "an unknown property inside a list item",
      "/tasks/1",
      { text: "a", items: [{ name: "a", nope: 1 }] },
      { location: "body", path: "items[0].nope", message: "must NOT have additional properties" },
    ],
    [
      "a property inside a list item",
      "/tasks/1",
      { text: "a", items: [{ name: "too long" }] },
      { location: "body", path: "items[0].name", message: "must NOT have more than 3 characters" },
    ],
    [
      "a missing required property inside a list item",
      "/tasks/1",
      { text: "a", items: [{}] },
      { location: "body", path: "items[0].name", message: "is a required property" },
    ],
    [
      "a property inside an item of a list body",
      "/batch",
      [{ name: "too long" }],
      { location: "body", path: "[0].name", message: "must NOT have more than 3 characters" },
    ],
    [
      "a query parameter",
      "/tasks/1?limit=abc",
      { text: "a" },
      { location: "query", path: "limit", message: "must be integer" },
    ],
    [
      "a path parameter",
      "/tasks/abc",
      { text: "a" },
      { location: "params", path: "id", message: "must be integer" },
    ],
  ])("names %s", async (_name, url, body, detail) => {
    expect(await refusal(url, body)).toEqual(envelope(detail));
  });

  it("reads a query and a path value into the integers their schemas declare", async () => {
    expect(await refusal("/tasks/7?limit=5", { text: "a" })).toEqual({
      params: { id: 7 },
      query: { limit: 5 },
    });
  });
});
