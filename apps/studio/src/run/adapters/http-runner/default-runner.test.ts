import { describe, expect, it } from "vitest";
import { defaultRunnerOf } from "./default-runner";

describe("the seeded default runner", () => {
  it("is the hosted Telo Cloud runner with no build override", () => {
    expect(defaultRunnerOf(undefined)).toEqual({
      baseUrl: "https://runner.telo.run",
      name: "Telo Cloud",
    });
    expect(defaultRunnerOf("  ").name).toBe("Telo Cloud");
  });

  it("is the build's runner, named for what it is, when the build names one", () => {
    expect(defaultRunnerOf("http://runner.telo.localhost:8060")).toEqual({
      baseUrl: "http://runner.telo.localhost:8060",
      name: "Development runner",
    });
  });
});
