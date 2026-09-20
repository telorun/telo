import * as fs from "node:fs";
import * as path from "node:path";
import type { Argv } from "yargs";
import { parsePlatformTarget } from "../bundle/warm-layers.js";
import { CARRIER_NODE_ABI } from "../carrier-runtime.js";
import { cliVersion } from "../distribution-versions.js";
import { createLogger } from "../logger.js";
import { outDocument, outEmit, outErrLine, outLine } from "../output.js";
import { buildAppPayload } from "../package/build-app-payload.js";
import { payloadDigest, readEmbeddedPayload } from "../package/app-trailer.js";
import { readPayloadIndex } from "../package/app-payload.js";
import {
  carrierExtension,
  carrierTarget,
  fetchCarrier,
  planCarrier,
  writeAppExecutable,
} from "../package/carrier.js";

/**
 * `telo package` — one file that runs an application on a machine with no
 * Node.js, no network and no telo installed.
 *
 * The platform is spelled the way `telo install` spells it (`os/arch[/libc]`),
 * not the way the release asset is named (`linux-amd64-gnu`): that is a filename
 * in the download namespace, and two spellings of one concept on one CLI would
 * make a user translate between them to answer one question.
 */

interface PackageArgv {
  manifest?: string;
  out?: string;
  platform?: string;
}

async function packageApp(argv: PackageArgv): Promise<void> {
  const log = createLogger(false);
  // Demanded here rather than by yargs: `package inspect <file>` is a
  // subcommand of this one, and a required positional or option on the parent
  // is demanded of the subcommand too — which asked for a manifest and an
  // output path to read a file.
  if (!argv.manifest) throw new Error("telo package needs a manifest: telo package <manifest> --out <file>");
  if (!argv.out) throw new Error("telo package needs --out: telo package <manifest> --out <file>");
  const version = cliVersion();
  if (!version) {
    throw new Error(
      "this telo cannot state its own version, so it cannot name the carrier to package with.",
    );
  }

  // The abi is the carrier's, never asked for: every carrier of one telo version
  // embeds one pinned Node runtime, so the layers are warmed for the runtime
  // that will actually open them.
  const named = parsePlatformTarget(argv.platform, `node-${CARRIER_NODE_ABI}`);
  // Stated rather than silent: a musl app on a glibc image is a binary that will
  // not start. Built as a new object — the target is read-only by declaration.
  if (named.os === "linux" && !named.libc) {
    outErrLine(`  ${log.err.dim("libc not given; packaging for gnu")}`);
  }
  const platform =
    named.os === "linux" && !named.libc ? { ...named, libc: "gnu" } : named;
  // Which carrier this will use, decided before anything is built: every reason
  // packaging cannot proceed at all — no such platform, a working copy that may
  // not download one — is answerable from the CLI and the platform alone.
  const plan = planCarrier(platform, version);

  const out = outputPath(argv.out, platform);
  outLine(`Packaging ${log.dim(argv.manifest)} for ${log.dim(carrierTarget(platform))}`);

  const { payload, index } = await buildAppPayload({
    manifestPath: argv.manifest,
    platform,
    report: (message) => outErrLine(`  ${log.err.dim(message)}`),
  });

  const carrier = await fetchCarrier(plan, version, (message) =>
    outErrLine(`  ${log.err.dim(message)}`),
  );
  await writeAppExecutable({ carrier: carrier.file, payload, out, platform });

  const size = fs.statSync(out).size;
  outLine(
    `${log.ok("✓")}  ${out}\n` +
      `   ${index.app.name}${index.app.version ? ` ${index.app.version}` : ""} · telo ${index.telo} · ` +
      `${carrierTarget(platform)}${platform.abi ? ` · abi ${platform.abi}` : ""}\n` +
      `   payload ${mb(payload.length)}, executable ${mb(size)}`,
  );
  outEmit({
    ok: true,
    out,
    app: index.app,
    platform: index.platform,
    telo: index.telo,
    payload: { bytes: payload.length, digest: `sha256:${payloadDigest(payload)}` },
    bytes: size,
  });
}

/** Read any carrier — packaged or not — and report what it carries. It reads
 *  the trailer or the segment and nothing else, so it costs nothing, works on a
 *  file built by someone else's CLI, and is what makes a packaged binary
 *  auditable. */
async function inspect(argv: { file: string }): Promise<void> {
  const payload = await readEmbeddedPayload(path.resolve(argv.file));
  if (!payload) {
    outErrLine(`${argv.file} carries no telo application.`);
    process.exitCode = 1;
    return;
  }
  const index = await readPayloadIndex(payload.bytes);
  const document = {
    ...index,
    payload: {
      bytes: payload.bytes.length,
      digest: `sha256:${payloadDigest(payload.bytes)}`,
      placement: payload.placement,
    },
  };
  // A bare document, the way `TELO_APP_INFO=1` writes the same index: an
  // envelope under `-o json` and machine JSON on the prose channel under text
  // are two encodings of one surface the guide says are the same.
  outDocument(document);
}

function outputPath(out: string, platform: { os?: string }): string {
  const resolved = path.resolve(process.cwd(), out);
  const exe = carrierExtension(platform as Parameters<typeof carrierExtension>[0]);
  return exe && !resolved.toLowerCase().endsWith(exe) ? `${resolved}${exe}` : resolved;
}

/**
 * A refusal is a message, not a stack. Every reason this command declines —
 * a closure that cannot travel, a platform with no carrier, an incomplete warm,
 * a darwin build off a Mac — is a sentence the reader acts on, and a trace
 * through the bundler's own line numbers buries it.
 */
async function refuseCleanly(work: () => Promise<void>, verbose: boolean): Promise<void> {
  try {
    await work();
  } catch (err) {
    const chain = causeChain(err);
    for (const [depth, message] of chain.entries()) {
      outErrLine(depth === 0 ? message : `  caused by: ${message}`);
    }
    // A refusal is a sentence; a BUG is a stack, and the difference is not
    // knowable here — so the stack is kept behind `--verbose` rather than
    // discarded, which is what left a nested fetch or esbuild failure with
    // nothing to debug from.
    if (verbose && err instanceof Error && err.stack) outErrLine(err.stack);
    outEmit({ ok: false, error: chain[0], ...(chain.length > 1 ? { causes: chain.slice(1) } : {}) });
    process.exitCode = 1;
  }
}

/** Every message in an error's `cause` chain, outermost first. */
function causeChain(err: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? (current.cause as unknown) : undefined;
  }
  return messages;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function packageCommand(yargs: Argv): Argv {
  return yargs.command(
    "package [manifest]",
    "Build a standalone executable that runs one Telo application",
    (y) =>
      y
        .positional("manifest", {
          describe: "Path to the application's manifest, or a directory holding telo.yaml",
          type: "string",
        })
        .option("out", {
          type: "string",
          describe: "Where to write the executable",
        })
        .option("platform", {
          type: "string",
          describe:
            "Platform to package for, as os/arch[/libc] (e.g. linux/amd64, linux/arm64/musl). " +
            "Defaults to the host. Packaging a darwin platform requires a macOS host.",
        })
        .command(
          "inspect <file>",
          "Print what a packaged executable carries",
          (inner) =>
            inner.positional("file", {
              describe: "A packaged executable",
              type: "string",
              demandOption: true,
            }),
          async (inner) => {
            const parsed = inner as unknown as { file: string; verbose?: boolean };
            await refuseCleanly(() => inspect(parsed), parsed.verbose === true);
          },
        ),
    async (parsed) => {
      const argv = parsed as unknown as PackageArgv & { verbose?: boolean };
      await refuseCleanly(() => packageApp(argv), argv.verbose === true);
    },
  );
}
