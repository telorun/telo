import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { giveToSessionUser } from "./session-directory-owner.js";
import { NO_FILE_OWNERSHIP, testProcessUser } from "./test-process-user.test-support.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("giveToSessionUser", () => {
  // Root may give a file to anyone, and Windows gives none away, so only there is it refused.
  it.skipIf(NO_FILE_OWNERSHIP || process.getuid!() === 0)("fails naming the entry it could not give away", async () => {
    root = mkdtempSync(join(tmpdir(), "docker-runner-owner-"));
    mkdirSync(join(root, "s1", "workspace"), { recursive: true });
    const own = testProcessUser();
    const user = { uid: own.uid + 1, gid: own.gid };

    await expect(giveToSessionUser(join(root, "s1"), user)).rejects.toThrow(
      `could not give ${join(root, "s1")} to the session user ${user.uid}:${user.gid}: EPERM`,
    );
  });
});
