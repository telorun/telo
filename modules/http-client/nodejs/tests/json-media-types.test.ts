import { describe, expect, it } from "vitest";
import { readBody } from "../src/http-request-controller.js";

const read = (contentType: string, body: string) =>
  readBody(new Response(body), "json", { "content-type": contentType }, () => {});

describe("json response bodies", () => {
  it("parses application/json and every +json suffix, and leaves other types as text", async () => {
    const body = '{"code":"X"}';
    expect(await read("application/json; charset=utf-8", body)).toEqual({ code: "X" });
    expect(await read("application/problem+json", body)).toEqual({ code: "X" });
    expect(await read("Application/Vnd.Api+JSON", body)).toEqual({ code: "X" });
    expect(await read("application/json-seq", body)).toBe(body);
    expect(await read("text/plain", body)).toBe(body);
    expect(await read("application/problem+json", "")).toBeNull();
  });
});
