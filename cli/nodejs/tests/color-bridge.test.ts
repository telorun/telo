import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bridge is a module side effect, so each case has to re-import it against a
 * fresh module registry. It fails SILENTLY by design — colour reverts to the
 * current behaviour rather than throwing — which is the safe direction and
 * exactly why it needs a test at all.
 */
async function bridgeWith(env: Record<string, string | undefined>): Promise<string | undefined> {
  const saved = { ...process.env };
  for (const key of ["CLICOLOR_FORCE", "FORCE_COLOR"]) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  await import("../src/color-bridge.js");
  const result = process.env.FORCE_COLOR;
  process.env = saved;
  return result;
}

describe("CLICOLOR_FORCE → FORCE_COLOR", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });

  it("fills an absent FORCE_COLOR from CLICOLOR_FORCE", async () => {
    // Node's colour libraries read FORCE_COLOR and ignore CLICOLOR_FORCE, so
    // without this a runner setting the one variable with the widest native
    // reach gets no colour out of a Node workload.
    expect(await bridgeWith({ CLICOLOR_FORCE: "1" })).toBe("1");
  });

  it("never overwrites an existing FORCE_COLOR", async () => {
    // FORCE_COLOR outranks CLICOLOR_FORCE precisely so this pair can mean "off
    // for Node, forced for everything else". Overwriting erases that.
    expect(await bridgeWith({ CLICOLOR_FORCE: "1", FORCE_COLOR: "0" })).toBe("0");
  });

  it("carries a CLICOLOR_FORCE of 0 across as an explicit off", async () => {
    expect(await bridgeWith({ CLICOLOR_FORCE: "0" })).toBe("0");
  });

  it("reads an EMPTY CLICOLOR_FORCE as present and forcing", async () => {
    // The precedence order disables only on the literal "0". This is also why no
    // image bakes the variable: the usual way to override an image default sets
    // it empty, which would then be undisableable.
    expect(await bridgeWith({ CLICOLOR_FORCE: "" })).toBe("1");
  });

  it("does nothing when CLICOLOR_FORCE is absent", async () => {
    expect(await bridgeWith({})).toBeUndefined();
  });
});
