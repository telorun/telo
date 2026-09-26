import { afterEach, expect } from "vitest";
import { startedHosts } from "./harness.js";

afterEach(() => {
  const violations = startedHosts.splice(0).flatMap((host) => host.violations);
  expect(violations).toEqual([]);
});
