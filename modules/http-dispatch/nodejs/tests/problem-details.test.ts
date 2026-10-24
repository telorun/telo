import { describe, expect, it } from "vitest";
import { problemDetails } from "../src/problem-details.js";

describe("problemDetails", () => {
  it("renders an uncoded failure as type, title and status alone", () => {
    expect(problemDetails(500)).toEqual({ type: "about:blank", title: "Internal Server Error", status: 500 });
  });

  it("omits the title of an unregistered status, and detail and data a failure lacks", () => {
    expect(problemDetails(499, { code: "CLIENT_GONE" })).toEqual({
      type: "about:blank",
      status: 499,
      code: "CLIENT_GONE",
    });
  });
});
