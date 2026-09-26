import { describe, expect, it } from "vitest";
import { describeAutoMark, describeTeloStatus, describeVersionMark } from "../src/describe-status.js";
import type { TeloStatus } from "../src/language-router.js";

const host = { product: "studio", setting: "this workspace's telo version setting" };
const running = (status: Partial<TeloStatus>): TeloStatus => ({ pinned: false, starting: false, version: "0.103.0", ...status });

describe("the status every host shows", () => {
  it.each<[string, TeloStatus, { label: string; detail: string }]>([
    [
      "the bundled version",
      running({ version: "0.102.0", reason: { kind: "bundled" } }),
      { label: "Telo 0.102.0", detail: "Telo 0.102.0: the version bundled with studio — nothing in this module's imports asks for another." },
    ],
    [
      "a pin",
      running({ pinned: true, reason: { kind: "pinned" } }),
      { label: "Telo 0.103.0 (pinned)", detail: "Telo 0.103.0: pinned by this workspace's telo version setting." },
    ],
    [
      "the owner's range",
      running({ reason: { kind: "owner-range", range: ">=0.103.0" } }),
      {
        label: "Telo 0.103.0",
        detail: "Telo 0.103.0: the lowest version accepted by this module's requires: telo: >=0.103.0 and its imports' ranges.",
      },
    ],
    [
      "the imports' ranges",
      running({ reason: { kind: "closure-range", ranges: [">=0.103.0", "<0.200.0"] } }),
      {
        label: "Telo 0.103.0",
        detail: "Telo 0.103.0: the lowest version accepted by the imports' requires: telo: ranges (>=0.103.0; <0.200.0).",
      },
    ],
    [
      "an engine still starting",
      running({ starting: true, reason: { kind: "bundled" } }),
      { label: "Telo 0.103.0 (starting)", detail: "Telo 0.103.0 is starting." },
    ],
    [
      "an unreleased build",
      running({ version: "0.102.0+unreleased", reason: { kind: "bundled" } }),
      {
        label: "Telo 0.102.0 (unreleased build)",
        detail:
          "Telo 0.102.0 (unreleased build): the version bundled with studio — nothing in this module's imports asks for another.",
      },
    ],
    ...(
      [
        ["offline-uncached", { kind: "offline-uncached", version: "0.103.0", message: "telo 0.103.0 is not cached and the engine registry is unreachable." }],
        ["engine-refused", { kind: "engine-refused", version: "0.103.0", message: "the downloaded telo 0.103.0 engine does not match its published integrity." }],
        ["engine-failed", { kind: "engine-failed", message: "the bundled telo engine failed: SyntaxError: Unexpected token." }],
        ["pin-unoffered", { kind: "pin-unoffered", pin: "0.99.0", reason: "unpublished", message: "telo.version is 0.99.0, which this editor does not offer." }],
      ] as const
    ).map(([kind, error]): [string, TeloStatus, { label: string; detail: string }] => [
      `the ${kind} error`,
      { pinned: false, starting: false, error: { ...error } as TeloStatus["error"] },
      { label: "Telo", detail: error.message },
    ]),
    [
      "the nothing-satisfies error, on the bundled engine",
      running({
        version: "0.102.0",
        reason: { kind: "unsatisfiable", ranges: [">=0.200.0"] },
        error: { kind: "nothing-satisfies", ranges: [">=0.200.0"], message: "no available telo satisfies >=0.200.0." },
      }),
      { label: "Telo 0.102.0", detail: "no available telo satisfies >=0.200.0." },
    ],
  ])("describes %s", (what, status, text) => {
    expect(describeTeloStatus(status, host)).toEqual(text);
  });

  it("marks a picker row", () => {
    expect(describeVersionMark({ version: "0.102.0+unreleased", bundled: true, cached: true, accepted: false })).toEqual({
      label: "0.102.0 (unreleased build)",
      detail: "bundled · cached · refused by this module's requires: telo:",
    });
    expect(describeVersionMark({ version: "0.103.0", bundled: false, cached: false })).toEqual({
      label: "0.103.0",
      detail: "not cached",
    });
  });

  it("words the Auto row as the others", () => {
    expect(describeAutoMark({ auto: "0.102.0+unreleased", versions: [] })).toEqual({
      label: "Auto",
      detail: "resolves to 0.102.0 (unreleased build)",
    });
    expect(describeAutoMark({ versions: [] })).toEqual({ label: "Auto", detail: "" });
  });
});
