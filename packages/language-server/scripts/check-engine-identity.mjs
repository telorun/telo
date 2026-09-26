#!/usr/bin/env node
// The publish guard (`prepack`): a published `@telorun/language-server@X` must
// be an engine whose handshake names it `X`. Editors download an engine by
// version and refuse one that reports anything else, and a build made while a
// release of the line is still pending reports `X+unreleased` — so this refuses
// a tarball when a line changeset is pending, or when `dist/` holds an engine
// built from another tree than the one being published.
//
// It regenerates the identity from the tree and then asks the built bundle
// itself: the source of truth is what the shipped file answers.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE, "../..");

function refuse(message) {
  console.error(`language-server: refusing to pack — ${message}`);
  process.exit(1);
}

/** What the engine at `file` answers to `initialize`, over an in-process port. */
async function handshake(file) {
  const { serve } = await import(pathToFileURL(file).href);
  const listeners = [];
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error("the bundle did not answer initialize within 30 s")), 30_000);
    serve({
      postMessage: (message) => {
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolveResult(message.result);
      },
      addEventListener: (type, listener) => listeners.push(listener),
    });
    const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } };
    setTimeout(() => listeners.forEach((listener) => listener({ data: request })), 0);
  });
}

const { version } = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "generate-telo-version.mjs")], { stdio: "inherit" });
} catch {
  refuse("the engine identity could not be generated from this tree (scripts/generate-telo-version.mjs said why above).");
}
const generated = /TELO_ENGINE_VERSION = "([^"]+)"/.exec(
  readFileSync(join(PACKAGE, "src", "engine-version.ts"), "utf8"),
)?.[1];
if (generated !== version) {
  refuse(
    `this tree builds engine ${generated}, not ${version}: a changeset of the telo version line is still ` +
      `pending. Publish after the Version PR has moved the line to the release.`,
  );
}

let result;
try {
  result = await handshake(join(PACKAGE, "dist", "language-server.mjs"));
} catch (error) {
  refuse(`dist/language-server.mjs could not be asked its identity: ${error instanceof Error ? error.message : String(error)}`);
}
const reported = result?.serverInfo?.version;
if (reported !== version) {
  refuse(
    `dist/language-server.mjs reports itself as ${JSON.stringify(reported)}, not ${version} — rebuild it ` +
      `(pnpm --filter "@telorun/language-server..." build) from the tree being published.`,
  );
}
process.exit(0);
