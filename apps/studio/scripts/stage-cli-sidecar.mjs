#!/usr/bin/env node
/**
 * Stage the `telo` sidecar this Studio build ships.
 *
 *   node scripts/stage-cli-sidecar.mjs [--triple <rust target triple>]
 *                                      [--if-missing]
 *
 * Studio runs applications through `telo runner`, and WHICH telo that is must
 * not be a property of the machine it lands on — so the editor carries one,
 * built from this same commit rather than downloaded from a release. This is
 * what puts it where Tauri's `externalBin` expects it:
 * `src-tauri/binaries/telo-<triple>`, copied beside the application binary at
 * bundle time and resolved from there at runtime.
 *
 * **The two platform vocabularies meet here and nowhere else.** Tauri names a
 * sidecar by the Rust target triple; the CLI's own build speaks Telo's tokens
 * (`darwin-arm64`, `linux-amd64-gnu`), which are also its release asset names.
 * Translating in one place keeps the CLI build from learning about triples.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(STUDIO_DIR, "..", "..");
const CLI_DIR = path.join(REPO_ROOT, "cli", "nodejs");
const BINARIES_DIR = path.join(STUDIO_DIR, "src-tauri", "binaries");

/** Rust target triple → the CLI build's own target token. Only the triples
 *  Studio is released for, plus their arm64 counterparts; anything else is
 *  refused by name rather than guessed at. */
const TRIPLE_TO_TELO_TARGET = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-amd64",
  "x86_64-unknown-linux-gnu": "linux-amd64-gnu",
  "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
  "x86_64-pc-windows-msvc": "windows-amd64",
  "aarch64-pc-windows-msvc": "windows-arm64",
};

function parseArgs(argv) {
  const args = { ifMissing: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--triple") args.triple = argv[++i];
    else if (argv[i] === "--if-missing") args.ifMissing = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/** The triple `rustc` itself reports, which is the one Tauri will look for. */
function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = out.match(/^host:\s*(\S+)$/m);
  if (!match) throw new Error("could not read the host target triple from `rustc -vV`");
  return match[1];
}

/** Sidecars already staged in this checkout, by file name. */
function staged() {
  if (!fs.existsSync(BINARIES_DIR)) return [];
  return fs.readdirSync(BINARIES_DIR).filter((name) => name.startsWith("telo-"));
}

/** A staged sidecar with the version it reports, so a stale one is visible
 *  rather than inferred. Only the host's binary can be asked; a cross-built one
 *  is described by when it was staged. */
function describeStaged(name) {
  const file = path.join(BINARIES_DIR, name);
  try {
    const version = execFileSync(file, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return `${name} (${version})`;
  } catch {
    return `${name} (staged ${fs.statSync(file).mtime.toISOString()})`;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const triple = args.triple ?? hostTriple();
  const teloTarget = TRIPLE_TO_TELO_TARGET[triple];
  if (!teloTarget) {
    throw new Error(
      `no telo build for target triple '${triple}'. Known: ${Object.keys(TRIPLE_TO_TELO_TARGET).join(", ")}`,
    );
  }

  const exe = triple.includes("windows") ? ".exe" : "";
  const destination = path.join(BINARIES_DIR, `telo-${triple}${exe}`);
  // `--if-missing` is the hook the dev and build commands run, and it asks
  // whether ANY sidecar is staged — not whether this host's is. A release build
  // stages the target's sidecar explicitly and then cross-builds, where asking
  // about the host's would build a second binary nothing ships.
  //
  // What it cannot do is tell whether the staged binary is the CURRENT one, so
  // it says what it found instead of implying it is fresh: a local `tauri
  // build` after a CLI change otherwise bundles the previous binary silently,
  // which is the opposite of the property the sidecar exists for.
  const already = staged();
  if (args.ifMissing && already.length > 0) {
    process.stderr.write(
      `telo sidecar already staged: ${already.map(describeStaged).join(", ")}\n` +
        `Run \`pnpm stage:cli\` to rebuild it from the current source.\n`,
    );
    return;
  }

  // The standalone build needs the CLI's compiled entry point; building it here
  // rather than assuming it keeps a fresh checkout from staging a stale binary
  // (or none at all, which Tauri reports as a missing sidecar).
  //
  // `pnpm` is a `.cmd` shim on Windows, and since the CVE-2024-27980 fix
  // (Node 20.12.2 / 18.20.2) a `.cmd` cannot be launched without a shell at
  // all: `spawnSync pnpm.cmd EINVAL`, which reads as a missing pnpm rather than
  // a refused one. `shell: true` is the documented way, and these arguments are
  // literals, so there is nothing for the shell to reinterpret.
  const windows = process.platform === "win32";
  execFileSync(windows ? "pnpm.cmd" : "pnpm", ["--filter", "@telorun/cli...", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: windows,
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sidecar-"));
  try {
    execFileSync(
      "node",
      [path.join("scripts", "build-standalone.mjs"), "--target", teloTarget, "--out", outDir],
      { cwd: CLI_DIR, stdio: "inherit" },
    );
    const built = path.join(outDir, `telo${exe}`);
    if (!fs.existsSync(built)) {
      throw new Error(`the standalone build produced no ${built}`);
    }
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
    fs.copyFileSync(built, destination);
    if (!exe) fs.chmodSync(destination, 0o755);
    process.stderr.write(`staged ${teloTarget} telo at ${destination}\n`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main();
