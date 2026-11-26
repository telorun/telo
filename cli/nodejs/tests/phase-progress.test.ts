import { EventEmitter } from "node:events";
import type { ManifestSource } from "@telorun/analyzer";
import type { Kernel } from "@telorun/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachControllerProgress } from "../src/controller-progress.js";
import { printableSourceUrl, withFetchProgress } from "../src/fetch-progress-source.js";
import { createLogger } from "../src/logger.js";
import { Output, installOutput } from "../src/output.js";
import { reportPhase } from "../src/phase-progress.js";

let stdout: string[];
let stderr: string[];
let restore: () => void;

beforeEach(() => {
  stdout = [];
  stderr = [];
  restore = installOutput(
    new Output({
      format: "text",
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      env: { NO_COLOR: "1" },
    }),
  );
});
afterEach(() => restore());

const REF = "oci://ghcr.io/telorun/console@0.19.6";

describe("reportPhase", () => {
  it("writes a start line and a closing line to stderr only", async () => {
    await expect(reportPhase(REF, { doing: "fetching", done: "fetched" }, async () => 7)).resolves.toBe(7);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(2);
    expect(stderr[0]).toBe(`  ⬇ ${REF} fetching…\n`);
    expect(stderr[1]).toMatch(new RegExp(`^  ✓ ${REF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(fetched, \\d+ms\\)\\n$`));
  });

  it("closes a failed phase with a cross and rethrows the error unchanged", async () => {
    const failure = new Error("offline");
    await expect(
      reportPhase(REF, { doing: "fetching", done: "fetched" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(stderr[1]).toMatch(/^  ✗ .* \(failed after \d+ms\)\n$/);
  });
});

describe("withFetchProgress", () => {
  it("reports a read and leaves the rest of the source as it was", async () => {
    const inner: ManifestSource = {
      supports: (url) => url.startsWith("oci://"),
      read: async (url) => ({ text: "kind: Telo.Library", source: url }),
      resolveRelative: (base, relative) => `${base}/${relative}`,
    };
    const source = withFetchProgress(inner);
    expect(source.supports(REF)).toBe(true);
    expect(source.resolveRelative("a", "b")).toBe("a/b");
    await expect(source.read(REF)).resolves.toEqual({ text: "kind: Telo.Library", source: REF });
    expect(stderr[0]).toBe(`  ⬇ ${REF} fetching…\n`);
    expect(stderr[1]).toContain("(fetched,");
  });
});

describe("printableSourceUrl", () => {
  it("drops userinfo, query and fragment and keeps the rest", () => {
    expect(printableSourceUrl("https://user:secret@example.com/a/telo.yaml?token=x#frag")).toBe(
      "https://example.com/a/telo.yaml",
    );
    expect(printableSourceUrl("oci://ghcr.io/telorun/console@0.9.0")).toBe(
      "oci://ghcr.io/telorun/console@0.9.0",
    );
    expect(printableSourceUrl("./local/telo.yaml")).toBe("./local/telo.yaml");
  });
});

describe("attachControllerProgress on piped output", () => {
  const purl = "pkg:telo/local/js?path=./x.mjs#WritelineController";

  function attach(): EventEmitter {
    const kernel = new EventEmitter();
    const on = kernel.on.bind(kernel);
    // The kernel's wildcard `*.Event` subscription is a plain event name here.
    (kernel as any).on = (name: string, handler: (event: unknown) => void) => on(name, handler);
    attachControllerProgress(kernel as unknown as Kernel, createLogger(false));
    return kernel;
  }

  it("reports a wait on stderr and nothing on stdout", () => {
    const kernel = attach();
    const event = (name: string, payload: object) => ({ name: `Writeline.${name}`, payload: { purl, ...payload } });
    kernel.emit("*.ControllerWorkStarted", event("ControllerWorkStarted", { work: "bundle" }));
    kernel.emit("*.ControllerLoaded", event("ControllerLoaded", { source: "bundle", durationMs: 605 }));
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "  ⬇ telo:local/js#WritelineController bundle…\n",
      "  ✓ telo:local/js#WritelineController (bundle, 605ms)\n",
    ]);
  });

  it("stays silent for a load that did no work", () => {
    const kernel = attach();
    kernel.emit("*.ControllerLoaded", { name: "Writeline.ControllerLoaded", payload: { purl, source: "cache", durationMs: 1 } });
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([]);
  });
});
