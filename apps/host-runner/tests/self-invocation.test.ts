import { describe, expect, it } from "vitest";
import { selfInvocation } from "../src/runner/self-invocation.js";

/** How the runner re-invokes itself: as `telo-host-runner telo <arguments>`,
 *  whose leading `telo` the entry hands to the bundled CLI. */
describe("re-invoking this telo", () => {
  it("runs a single-file executable as itself with a leading `telo`", async () => {
    expect(
      await selfInvocation({ singleFileExecutable: true, execPath: "/opt/telo-host-runner", script: undefined }),
    ).toEqual({ command: "/opt/telo-host-runner", prefix: ["telo"] });
  });

  it("re-enters an npm install through its script under the Node runtime", async () => {
    expect(
      await selfInvocation({
        singleFileExecutable: false,
        execPath: process.execPath,
        script: "/bin/telo-host-runner.mjs",
      }),
    ).toEqual({ command: process.execPath, prefix: ["/bin/telo-host-runner.mjs", "telo"] });
  });

  it("refuses rather than guesses when there is no script to re-enter", async () => {
    await expect(
      selfInvocation({ singleFileExecutable: false, execPath: process.execPath, script: undefined }),
    ).rejects.toThrow(/no script path/);
  });
});
