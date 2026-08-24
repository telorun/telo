import { describe, expect, it } from "vitest";
import { pointerTarget } from "./DetailPanel";

const fields = {
  targets: [{ invoke: "x" }, { invoke: "y", inputs: { to: 3 } }],
  port: 8080,
};

describe("pointerTarget", () => {
  it("returns the object a pointer names", () => {
    expect(pointerTarget(fields, "/targets/1/inputs")).toEqual({ to: 3 });
  });

  it("returns an empty object for a target that does not exist yet", () => {
    // A step's `inputs:` does not exist until something is put in it. Refusing
    // here is refusing to author it at all — which is what silently fell the
    // boot list's inputs form back to the whole module root's.
    expect(pointerTarget(fields, "/targets/0/inputs")).toEqual({});
  });

  it("refuses a target that exists and is not an object", () => {
    // A form over it would misrepresent it, and a commit would write over
    // something it never read.
    expect(pointerTarget(fields, "/port")).toBeNull();
  });
});
