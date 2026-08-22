import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { resolveInstallRoot } from "../src/controller-loaders/npm-install-root.js";

/**
 * The install root is keyed by the realm package's path RELATIVE to the tree,
 * because that is the string npm writes into `package.json`, into the lockfile,
 * and as the target of the link it materializes. Two runners may share a root
 * exactly when that string means the same thing on both sides.
 *
 * These cases are the four ways it can differ, plus the one way it must not:
 * a workspace copied to another directory at the same depth is the
 * `WORKDIR /build` … `COPY --from=build /build /srv` shape, and separating it
 * would make an image miss the tree `telo install` warmed for it.
 */
describe("npm install root key", () => {
  const cli = (root: string) => async () => root;
  const HOST_CLI = "/home/me/.nvm/versions/node/v24.11.1/lib/node_modules/@telorun/cli";
  const CONTAINER_CLI = "/opt/telo";

  const rootFor = (workspace: string, cliPath: string) =>
    resolveInstallRoot(path.join(workspace, ".telo", "npm"), cli(cliPath));

  it("separates two CLI installations over one workspace", async () => {
    // The reported failure: a host process and a container over one bind mount.
    expect(await rootFor("/app", HOST_CLI)).not.toBe(await rootFor("/app", CONTAINER_CLI));
  });

  it("separates one CLI seeing the workspace at different depths", async () => {
    // The recorded dependency does not change, but the number of `..` segments
    // npm writes does, so the tree is unusable from the other view.
    expect(await rootFor("/w", CONTAINER_CLI)).not.toBe(
      await rootFor("/deep/a/b/c/w", CONTAINER_CLI),
    );
  });

  it("keeps one root when a workspace is copied to another directory at the same depth", async () => {
    const built = await rootFor("/build", CONTAINER_CLI);
    const shipped = await rootFor("/srv", CONTAINER_CLI);
    expect(path.basename(built)).toBe(path.basename(shipped));
  });

  it("keeps one root for every manifest in a workspace", async () => {
    // The key names the runner, never the app: one repo, one cache.
    const base = path.join("/app", ".telo", "npm");
    expect(await resolveInstallRoot(base, cli(CONTAINER_CLI))).toBe(
      await resolveInstallRoot(base, cli(CONTAINER_CLI)),
    );
  });

  it("separates a runner that cannot resolve the realm package", async () => {
    // The installer omits such a dependency, so that runner's tree really is a
    // different tree — sharing one would hand it a root it did not write.
    const resolved = await rootFor("/app", CONTAINER_CLI);
    const unresolved = await resolveInstallRoot(path.join("/app", ".telo", "npm"), async () => null);
    expect(resolved).not.toBe(unresolved);
  });

  it("puts the root under the base it was given", async () => {
    const base = path.join(os.tmpdir(), "ws", ".telo", "npm");
    const root = await resolveInstallRoot(base, cli(CONTAINER_CLI));
    expect(path.dirname(root)).toBe(base);
    expect(path.basename(root)).toMatch(/^[0-9a-f]{32}$/);
  });
});
