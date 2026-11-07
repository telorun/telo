// check-links: what it refuses and what it lets through, over a scratch tree.
// Run: node --test scripts/tests/*.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { refusalsFor } from "../check-links.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function check(tree) {
  const root = mkdtempSync(join(tmpdir(), "check-links-"));
  made.push(root);
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return refusalsFor({ root, files: Object.keys(tree) }).map(({ file, line, target, reason }) => [file, line, target, reason]);
}

const URL_REASON = "links into the repository by URL — write a relative path";

describe("check-links", () => {
  it("refuses an absolute link into the repository at any ref, and raw content", () => {
    const refused = check({
      "docs/a.md": [
        "[x](https://github.com/telorun/telo/blob/main/kernel/specs/tracing.md)",
        "[y](https://github.com/telorun/telo/tree/v0.85.0/analyzer)",
        "[z](https://raw.githubusercontent.com/telorun/telo/refs/heads/main/x.sh)",
        "[ok](https://github.com/telorun/telo/issues/1)",
      ].join("\n"),
    });
    assert.deepEqual(
      refused.map(([, line, , reason]) => [line, reason]),
      [[1, URL_REASON], [2, URL_REASON], [3, URL_REASON]],
    );
  });

  it("refuses a relative link to nothing tracked, ignoring anchors, code and changelogs", () => {
    const refused = check({
      "docs/guides/logging.md": [
        "[bad](../../kernel/specs/loging.md)",
        "[good](../../kernel/specs/logging.md#section)",
        "[dir](../../kernel/specs/)",
        "`[code](nope.md)`",
        "```",
        "[fenced](nope.md)",
        "```",
      ].join("\n"),
      "kernel/specs/logging.md": "x",
      "CHANGELOG.md": "[old](https://github.com/telorun/telo/blob/main/x)",
    });
    assert.deepEqual(refused, [["docs/guides/logging.md", 1, "../../kernel/specs/loging.md", "names no tracked file"]]);
  });

  it("holds a module's files to the module: no link out of it, no preview link", () => {
    const refused = check({
      "modules/sqlite/telo.yaml": "kind: Telo.Library",
      "modules/sql/telo.yaml": "kind: Telo.Library",
      "modules/sql/docs/declarative-schema.md": "x",
      "modules/sqlite/docs/own.md": "x",
      "modules/sqlite/docs/connection.md": [
        "[in](./own.md)",
        "[out](../../sql/docs/declarative-schema.md)",
        "[preview](https://telo.run/next/guides/logging)",
      ].join("\n"),
      "docs/guides/logging.md": "[fine](../../modules/sql/docs/declarative-schema.md)\n[next](https://telo.run/next/guides/logging)",
    });
    assert.deepEqual(refused, [
      [
        "modules/sqlite/docs/connection.md",
        2,
        "../../sql/docs/declarative-schema.md",
        "leaves the module — link to https://hub.telo.run/module/oci/ghcr.io/telorun/sql/",
      ],
      [
        "modules/sqlite/docs/connection.md",
        3,
        "https://telo.run/next/guides/logging",
        "names a preview — link to https://telo.run/guides/logging",
      ],
    ]);
  });
});
