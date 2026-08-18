import { describe, expect, it } from "vitest";
import { unreleasedEdge } from "../src/release/verify-requires.js";

/**
 * The third state a declared edge can be in.
 *
 * A module adopting new syntax declares the range of the release that will carry
 * it, so on the commit that does so the edge names a version that does not exist
 * yet. Running `npx @telorun/cli@<unpublished>` there has one possible outcome,
 * and npm's ETARGET arrives wrapped in install noise that reads exactly like
 * being offline — which is why the registry is asked first and the two are kept
 * apart.
 */
describe("unreleasedEdge", () => {
  const published = ["0.76.0", "0.77.0", "0.78.0"];

  it("reports the latest published version for an edge newer than all of them", () => {
    expect(unreleasedEdge("0.79.0", published)).toBe("0.78.0");
    // A typo'd bound lands here too, and is meant to: printed beside the latest
    // it reads visibly wrong, which is the only signal available against a
    // number nobody can distinguish from a real forward declaration.
    expect(unreleasedEdge("0.790.0", published)).toBe("0.78.0");
  });

  it("says nothing about an edge that exists", () => {
    expect(unreleasedEdge("0.77.0", published)).toBeUndefined();
    expect(unreleasedEdge("v0.77.0".slice(1), published)).toBeUndefined();
    // A registry that renders a leading `v` names the same version.
    expect(unreleasedEdge("0.77.0", ["v0.77.0"])).toBeUndefined();
  });

  it("leaves a version BELOW the latest to the run", () => {
    // Absent but not forward-declared — a yanked or never-published patch. The
    // run's own "could not run" is honest about it, and inventing a second rule
    // here would be guessing at why it is missing.
    expect(unreleasedEdge("0.77.5", published)).toBeUndefined();
  });

  it("classifies nothing when the registry could not be asked", () => {
    // A guess about what exists is worse than the run's own verdict, and this is
    // also what keeps an offline publish from failing on a bound that is fine.
    expect(unreleasedEdge("0.79.0", null)).toBeUndefined();
    expect(unreleasedEdge("0.79.0", [])).toBeUndefined();
  });
});
