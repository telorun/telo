/**
 * End-to-end test for the `files:` module-bundle round-trip, run against the
 * live registry through the docker-compose Caddy proxy (same stack as
 * `test-suite-e2e.yaml`). Unlike the manifest-based Test.Suite, this drives the
 * real `telo publish` CLI: an outbound binary tar.gz body has no manifest-native
 * sender (`HttpClient.Request` bodies are text/JSON only), and `telo publish` is
 * the actual producer of the `module.tar.gz` artifact, so exercising it is the
 * faithful test.
 *
 * Flow:
 *   1. Write a fixture Library with `files: [public/**]` + a built asset.
 *   2. `telo publish` it → PUT `…/module.tar.gz` (CLI packs the bundle).
 *   3. GET `…/telo.yaml`        → registry-extracted manifest.
 *   4. GET `…/module.tar.gz`    → unpack → asset bytes survive round-trip.
 *
 * Requires `TELO_REGISTRY_TOKEN` matching the registry's publish token.
 * Run: `pnpm run test:e2e:bundle`.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readTarGz } from "../../../cli/nodejs/src/bundle/tar.js";

const REGISTRY = process.env.TELO_REGISTRY_URL ?? "http://registry.telo.localhost:8060";
const NS = "std";
const NAME = "e2e-bundle-fixture";
const VERSION = "1.0.0";
const ASSET_MARKER = `bundle-asset-${VERSION}`;
const MANIFEST_MARKER = "e2e test fixture for the files: bundle round-trip";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../../../cli/nodejs/bin/telo.ts");

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
  if (!process.env.TELO_REGISTRY_TOKEN) {
    fail("TELO_REGISTRY_TOKEN is not set — required to publish the fixture.");
  }

  // 1. Fixture: a bare Library that ships one asset via `files:`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-e2e-bundle-"));
  fs.writeFileSync(
    path.join(dir, "telo.yaml"),
    [
      "kind: Telo.Library",
      "metadata:",
      `  name: ${NAME}`,
      `  namespace: ${NS}`,
      `  version: ${VERSION}`,
      `  description: ${MANIFEST_MARKER}`,
      "files:",
      "  - public/**",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "index.html"), `<!doctype html><h1>${ASSET_MARKER}</h1>\n`);
  // A file the default-ignore / future excludes should not affect, plus a map
  // we leave in to prove a plain `public/**` ships everything under it.
  fs.writeFileSync(path.join(dir, "public", "app.js"), `console.log("${ASSET_MARKER}");\n`);

  // 2. Publish (CLI packs telo.yaml + public/** into module.tar.gz and PUTs it).
  const res = spawnSync(
    "bun",
    [cliEntry, "publish", path.join(dir, "telo.yaml"), `--registry=${REGISTRY}`],
    { stdio: "inherit", env: process.env },
  );
  if (res.status !== 0) fail(`telo publish exited with code ${res.status}`);
  ok("published fixture bundle");

  const base = `${REGISTRY.replace(/\/+$/, "")}/${NS}/${NAME}/${VERSION}`;

  // 3. GET telo.yaml — registry extracts it from the tarball server-side.
  const yamlRes = await fetch(`${base}/telo.yaml`);
  if (!yamlRes.ok) fail(`GET telo.yaml → HTTP ${yamlRes.status}`);
  const yamlText = await yamlRes.text();
  if (!yamlText.includes(MANIFEST_MARKER)) fail("GET telo.yaml did not return the published manifest");
  ok("GET telo.yaml returns the extracted manifest");

  // 4. GET module.tar.gz — unpack and confirm the asset survived the round-trip.
  const tarRes = await fetch(`${base}/module.tar.gz`);
  if (!tarRes.ok) fail(`GET module.tar.gz → HTTP ${tarRes.status}`);
  const buf = Buffer.from(await tarRes.arrayBuffer());
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) fail("module.tar.gz is not gzip-framed");

  const entries = await readTarGz(buf);
  const byName = new Map(entries.map((e) => [e.name, (e.content as Buffer).toString("utf-8")]));
  if (!byName.has("telo.yaml")) fail("module.tar.gz is missing telo.yaml");
  const html = byName.get("public/index.html");
  if (!html?.includes(ASSET_MARKER)) fail("module.tar.gz is missing public/index.html with the asset marker");
  if (!byName.has("public/app.js")) fail("module.tar.gz is missing public/app.js");
  ok("GET module.tar.gz unpacks to telo.yaml + public/index.html + public/app.js");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n✓ files: bundle round-trip passed");
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
