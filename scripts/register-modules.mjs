#!/usr/bin/env node
// Registers every importable module of this workspace with a Telo hub.
//
// The refs come from the release model (`telo release order`), the same answer
// `publish-modules.mjs` pushes to, so a module is registered under exactly the ref
// it is published at. Only `modules/` and `blueprints/` are importable libraries;
// `apps/` are applications, which the hub refuses.
//
// A module the hub already knows (`/register/status` says anything but
// `unknown`) is skipped. Every other failure is reported and makes the run exit
// non-zero; a rate-limit refusal stops the run, since every later request would
// be refused too.
//
// Usage: node scripts/register-modules.mjs [--dry-run]
// Env:   TELO_HUB (default http://localhost:8040)

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB = (process.env.TELO_HUB ?? "http://localhost:8040").replace(/\/+$/, "");
const DRY_RUN = process.argv.includes("--dry-run");
const IMPORTABLE = ["modules/", "blueprints/"];

const ordered = JSON.parse(
  execFileSync("telo", ["release", "order", "-o", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
).order;

const candidates = ordered.filter((entry) => IMPORTABLE.some((p) => entry.key.startsWith(p)));
const unaddressed = candidates.filter((entry) => !entry.destination);
const refs = candidates.filter((entry) => entry.destination);

async function readJson(res) {
  return res.json().catch(() => ({}));
}

async function registrationStatus(ref) {
  const res = await fetch(`${HUB}/register/status?ref=${encodeURIComponent(ref)}`);
  const body = await readJson(res);
  // An unregistered ref is a 404 that still carries `status: "unknown"`.
  if (res.status === 404 && body.status === "unknown") return "unknown";
  if (!res.ok || typeof body.status !== "string") {
    throw new Error(`GET /register/status answered ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.status;
}

async function register(ref) {
  const res = await fetch(`${HUB}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  return { status: res.status, body: await readJson(res) };
}

const registered = [];
const skipped = [];
const failed = unaddressed.map((entry) => `${entry.key}: the release model gives it no destination`);
let rateLimited = null;

console.log(`hub: ${HUB}${DRY_RUN ? " (dry run)" : ""}`);
for (const [index, entry] of refs.entries()) {
  const ref = entry.destination;
  let status;
  try {
    status = await registrationStatus(ref);
  } catch (err) {
    failed.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (status !== "unknown") {
    skipped.push(ref);
    console.log(`  skip      ${ref} (${status})`);
    continue;
  }
  if (DRY_RUN) {
    registered.push(ref);
    console.log(`  would add ${ref}`);
    continue;
  }
  const result = await register(ref);
  if (result.status === 202 || result.status === 200) {
    registered.push(ref);
    console.log(`  added     ${ref}`);
  } else if (result.status === 429) {
    rateLimited = refs.slice(index).map((e) => e.destination);
    break;
  } else {
    const reason = result.body.error ?? result.body.message ?? JSON.stringify(result.body);
    failed.push(`${ref}: ${result.status} ${reason}`);
    console.log(`  FAILED    ${ref}: ${result.status} ${reason}`);
  }
}

console.log(
  `\n${registered.length} ${DRY_RUN ? "to register" : "registered"}, ${skipped.length} already known, ` +
    `${failed.length} failed${rateLimited ? `, ${rateLimited.length} not attempted` : ""}.`,
);
if (rateLimited) {
  console.error(
    `\nThe hub rate-limited /register (429). Not attempted:\n  ${rateLimited.join("\n  ")}\n` +
      `Re-run once the window passes; registered modules are skipped.`,
  );
}
if (failed.length > 0) console.error(`\nFailed:\n  ${failed.join("\n  ")}`);
process.exit(failed.length > 0 || rateLimited ? 1 : 0);
