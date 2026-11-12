// The vocabulary renderer is run by `@telorun/analyzer`'s own `prepare` while `changeset publish`
// compiles `@telorun/kernel` against the analyzer's source in the same job, so a reader must
// never find a generated file missing or half-written.
// Run: node --test scripts/tests/render-builtin-vocabulary.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts", "render-builtin-vocabulary.mjs");
const ENTRIES = join(REPO, "analyzer", "nodejs", "src", "builtin-entries");
const INDEX = join(ENTRIES, "index.ts");

function render() {
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
}

const identity = (path) => {
  const stat = statSync(path);
  return `${stat.ino}:${stat.mtimeMs}`;
};

describe("render-builtin-vocabulary", () => {
  it("leaves an up-to-date generated file untouched and removes what no longer belongs", () => {
    render();
    const before = identity(INDEX);
    const expected = readFileSync(INDEX, "utf8");
    writeFileSync(join(ENTRIES, "stale.ts"), "export {};\n");

    render();

    assert.equal(identity(INDEX), before);
    assert.equal(readFileSync(INDEX, "utf8"), expected);
    assert.deepEqual(readdirSync(ENTRIES), ["index.ts"]);
  });

  it("never lets a concurrent reader see the generated entries missing", async () => {
    render();
    let missing = 0;
    let polls = 0;
    const poll = setInterval(() => {
      polls++;
      if (!existsSync(INDEX)) missing++;
    }, 1);
    for (let run = 0; run < 4; run++) {
      await new Promise((done, fail) => {
        const child = spawn(process.execPath, [SCRIPT], { cwd: REPO, stdio: "ignore" });
        child.on("error", fail);
        child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`render exited ${code}`))));
      });
    }
    clearInterval(poll);
    assert.ok(polls > 20, `the reader polled ${polls} times`);
    assert.equal(missing, 0);
  });
});
