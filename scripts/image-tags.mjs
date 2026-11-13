#!/usr/bin/env node
// The tags an app image publishes under, from its `docker` row among the units the
// release commit moved (`release-units.mjs`): `<destination>:<version><suffix>` and
// `<destination>:sha-<commit><suffix>`, plus `<destination>:latest<suffix>` for a
// final version no released one of the unit exceeds — forward only, judged against
// the unit's own `<unit key>@<version>` tags, so re-running an old publish moves
// nothing. A candidate (`<final>-rc.<k>`) moves no pointer. A unit the release did
// not move gets no tags, and its image is not built.
//
// Usage: node scripts/image-tags.mjs --key <unit key> --sha <short sha> [--suffix <s>]
//        env MOVED_UNITS; writes `version` and `tags` as step outputs

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { ROOT, compareVersions } from "./version-line.mjs";

/** `{ version, tags }` of the unit `key`'s image; `tags` empty when it did not move. */
export function imageTags({ units, key, sha, suffix = "", releasedVersions }) {
  const row = units.find((unit) => unit.key === key && unit.ecosystem === "docker");
  if (!row) return { version: "", tags: [] };
  const tags = [`${row.name}:${row.version}${suffix}`, `${row.name}:sha-${sha}${suffix}`];
  const final = !/-/.test(row.version);
  if (final && !releasedVersions.some((other) => !/-/.test(other) && compareVersions(other, row.version) > 0)) {
    tags.unshift(`${row.name}:latest${suffix}`);
  }
  return { version: row.version, tags };
}

/** Every version of `key` its `<key>@<version>` tags name. */
function unitTagVersions(key) {
  return execFileSync("git", ["tag", "--list", `${key}@*`], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((tag) => tag.slice(key.length + 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const key = flag("--key");
    const sha = flag("--sha");
    if (!key || !sha) throw new Error("usage: image-tags.mjs --key <unit key> --sha <short sha> [--suffix <s>]");
    const units = JSON.parse(process.env.MOVED_UNITS || "[]");
    const { version, tags } = imageTags({ units, key, sha, suffix: flag("--suffix") ?? "", releasedVersions: unitTagVersions(key) });
    setOutput("version", version);
    setOutput("tags", tags.join(","));
    console.log(version ? `image-tags: ${key} ${version} → ${tags.join(", ")}` : `image-tags: the release did not move ${key}.`);
  } catch (error) {
    console.error(`::error::image-tags: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
