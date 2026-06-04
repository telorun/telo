import { describe, expect, it } from "vitest";

import type { LimitCeilings } from "./config.js";
import { clampLimits, parseCpuMillis, parseMemoryBytes } from "./limits.js";

const CEILINGS: LimitCeilings = {
  cpu: "50m",
  memory: "100Mi",
  ttlSeconds: 3600,
  ephemeralStorage: "512Mi",
};

describe("clampLimits — hard ceiling, clamp-down only", () => {
  it("uses the ceiling when no request is given", () => {
    expect(clampLimits(CEILINGS, undefined)).toEqual({
      cpu: "50m",
      memory: "100Mi",
      ttlSeconds: 3600,
      ephemeralStorage: "512Mi",
    });
  });

  it("clamps a request that exceeds the ceiling back to the ceiling", () => {
    const r = clampLimits(CEILINGS, { cpu: "2", memory: "4Gi", ttlSeconds: 99_999 });
    expect(r.cpu).toBe("50m");
    expect(r.memory).toBe("100Mi");
    expect(r.ttlSeconds).toBe(3600);
  });

  it("honors a request that asks for LESS than the ceiling", () => {
    const r = clampLimits(CEILINGS, { cpu: "20m", memory: "64Mi", ttlSeconds: 600 });
    expect(r.cpu).toBe("20m");
    expect(r.memory).toBe("64Mi");
    expect(r.ttlSeconds).toBe(600);
  });

  it("falls back to the ceiling on an unparseable request", () => {
    const r = clampLimits(CEILINGS, { cpu: "garbage", memory: "??" });
    expect(r.cpu).toBe("50m");
    expect(r.memory).toBe("100Mi");
  });
});

describe("quantity parsers", () => {
  it("parses cpu to millicores", () => {
    expect(parseCpuMillis("50m")).toBe(50);
    expect(parseCpuMillis("1")).toBe(1000);
    expect(parseCpuMillis("0.5")).toBe(500);
    expect(parseCpuMillis("nope")).toBeNull();
  });

  it("parses memory to bytes (binary + SI)", () => {
    expect(parseMemoryBytes("100Mi")).toBe(100 * 1024 * 1024);
    expect(parseMemoryBytes("1Gi")).toBe(1024 ** 3);
    expect(parseMemoryBytes("1000")).toBe(1000);
    expect(parseMemoryBytes("5M")).toBe(5_000_000);
    expect(parseMemoryBytes("bad")).toBeNull();
  });
});
