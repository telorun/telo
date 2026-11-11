import { beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_PREFIXES } from "../storage-keys";
import { forgetAlwaysOpen, isAlwaysOpen, setAlwaysOpen } from "./open-app-preference";

describe("the always-open answer", () => {
  beforeEach(() => localStorage.clear());

  it("holds per workspace and app, and is forgotten on request", () => {
    setAlwaysOpen("/w1", "api");
    expect(isAlwaysOpen("/w1", "api")).toBe(true);
    expect(isAlwaysOpen("/w1", "web")).toBe(false);
    expect(isAlwaysOpen("/w2", "api")).toBe(false);

    forgetAlwaysOpen("/w1", "api");
    expect(isAlwaysOpen("/w1", "api")).toBe(false);
  });

  it("ignores a corrupt stored value, reporting it and leaving it as it is", () => {
    const key = `${LOCAL_PREFIXES.openApp}${encodeURIComponent("/w1")}:api`;
    localStorage.setItem(key, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(isAlwaysOpen("/w1", "api")).toBe(false);

    expect(warn).toHaveBeenCalledOnce();
    expect(localStorage.getItem(key)).toBe("{not json");
    warn.mockRestore();
  });
});
