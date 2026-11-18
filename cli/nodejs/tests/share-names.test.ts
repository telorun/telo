import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHARE_NAMES_FILE, shareNameFor } from "../src/share/share-names.js";
import { userAppDirectory } from "../src/desktop/desktop-app-directory.js";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "share-names-"));
  env = { HOME: home, XDG_DATA_HOME: home, LOCALAPPDATA: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("share names under concurrent starts", () => {
  it("keeps every manifest's entry, and gives one path one name", async () => {
    const keys = Array.from({ length: 12 }, (_, index) => `/apps/${index}/telo.yaml`);
    const minted = await Promise.all([...keys, keys[0]!, keys[0]!].map((key) => shareNameFor(key, env)));

    const stored = JSON.parse(fs.readFileSync(path.join(userAppDirectory("telo", { env })!, SHARE_NAMES_FILE), "utf8")) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual([...keys].sort());
    expect(new Set(Object.values(stored)).size).toBe(keys.length);
    expect(minted[12]).toBe(stored[keys[0]!]);
    expect(minted[13]).toBe(stored[keys[0]!]);
  });

  it("takes over a stale lock and releases its own", async () => {
    const directory = userAppDirectory("telo", { env })!;
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, `${SHARE_NAMES_FILE}.lock`);
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);

    await shareNameFor("/a/telo.yaml", env);

    expect(fs.existsSync(lock)).toBe(false);
  });

  it("removes a crashed writer's temporary file beside the store", async () => {
    const directory = userAppDirectory("telo", { env })!;
    fs.mkdirSync(directory, { recursive: true });
    const leftover = path.join(directory, `${SHARE_NAMES_FILE}.4242.dead.tmp`);
    fs.writeFileSync(leftover, "{");

    await shareNameFor("/a/telo.yaml", env);

    expect(fs.existsSync(leftover)).toBe(false);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(directory, SHARE_NAMES_FILE), "utf8")))).toEqual(["/a/telo.yaml"]);
  });
});
