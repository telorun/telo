import type { CheckDiagnostic, ResourceContext, Runnable } from "@telorun/sdk";

interface ExpectError {
  code?: string;
  message?: string;
  fix?: string;
}

interface ManifestAssertManifest {
  metadata: { name: string; module?: string };
  source: string;
  expect: {
    errors?: ExpectError[];
    warnings?: ExpectError[];
    loadError?: string;
    runFails?: string;
    runs?: boolean;
  };
}

/** How long a fixture may run before it is stopped and reported as a failure.
 *  A fixture is a few resources and no server; anything still going is either a
 *  regression into success or something holding a kernel hold. */
const RUN_TIMEOUT_MS = 30_000;

/**
 * Run the manifest to completion and report how it ended. Both streams are
 * drained — a stream left unread stalls the child once its channel fills — and
 * only stderr is kept, since that is where a load or init failure is written.
 *
 * BOUNDED AND ALWAYS CANCELLED. `exitCode` is raced against a timer and
 * `cancel()` runs in a `finally`, because a child nobody stops is a child that
 * runs forever: a fixture that regresses into succeeding, or one declaring
 * anything that takes a kernel hold (an `Http.Server`, a `Schedule.Interval`),
 * would otherwise hang the whole suite with no diagnosis — and a rejection
 * inside the `Promise.all` would leak the kernel. `cancel()` is on the runtime
 * seam from the start for exactly this reason: a supervisor needs termination
 * before anything else.
 */
async function runToExit(
  runtime: ResourceContext["runtime"],
  source: string,
): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
  const run = await runtime.run(source, { env: {} });
  const drain = async (stream: AsyncIterable<string>, keep: boolean): Promise<string> => {
    let text = "";
    for await (const chunk of stream) if (keep) text += chunk;
    return text;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), RUN_TIMEOUT_MS);
    });
    const settled = await Promise.race([
      Promise.all([drain(run.stdout, false), drain(run.stderr, true), run.exitCode]),
      timeout,
    ]);
    if (settled === "timeout") return { exitCode: -1, stderr: "", timedOut: true };
    const [, stderr, exitCode] = settled;
    return { exitCode, stderr, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
    await run.cancel("assert.manifest finished").catch(() => {});
  }
}

function matchesDiagnostic(diag: CheckDiagnostic, expected: ExpectError): boolean {
  if (expected.code && diag.code !== expected.code) return false;
  if (expected.message && !diag.message.includes(expected.message)) return false;
  // Substring against the replacement, exactly as `message` matches: a repair
  // is asserted for WHAT it produces, and pinning the whole corrected scalar
  // would make every test brittle to an unrelated edit elsewhere in the value.
  //
  // The presence check is separate from the substring one so that `fix: ""`
  // does not match a diagnostic carrying no repair — every string contains the
  // empty string, which would have made the documented "a diagnostic that
  // offers no repair never matches" false for exactly that expectation.
  if (expected.fix !== undefined) {
    if (diag.fix === undefined) return false;
    if (!diag.fix.replacement.includes(expected.fix)) return false;
  }
  return true;
}

/** How an expectation reads back in a failure line. */
function describeExpectation(expected: ExpectError): string {
  const parts: string[] = [];
  if (expected.message) parts.push(`containing "${expected.message}"`);
  if (expected.fix !== undefined) parts.push(`fixed by "${expected.fix}"`);
  return parts.length > 0 ? ` ${parts.join(" and ")}` : "";
}

export async function create(
  manifest: ManifestAssertManifest,
  ctx: ResourceContext,
): Promise<Runnable> {
  return {
    run: async () => {
      const useColor = (ctx.stderr as any).isTTY ?? false;
      const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
      const bold = (t: string) => c("1", t);
      const red = (t: string) => c("31", t);
      const green = (t: string) => c("32", t);
      const dim = (t: string) => c("2", t);

      const name = manifest.metadata.name;

      // `resolveModuleFile` knows where the declaring module's files actually
      // live — for a published module that is its artifact directory, not the
      // manifest URL — and materializes its asset layer on first access, so a
      // bundled fixture manifest is on disk before it is loaded.
      const resolvedUrl = await ctx.resolveModuleFile(manifest.source);
      // The host's own analysis pass, reached through the SDK rather than by
      // importing the analyzer — so what this asserts about is the analyzer the
      // kernel running it actually uses, not a copy frozen into this module's
      // bundle. `desugarImports` mirrors how the kernel loads: inline `imports:`
      // maps expand into synthetic Telo.Import manifests before analysis, so a
      // manifest using inline imports analyzes (alias resolution, `!ref`) the
      // same way it runs.
      const checked = await ctx.runtime.check(resolvedUrl, { desugarImports: true });

      if (checked.loadError !== undefined) {
        const errMsg = checked.loadError;
        if (manifest.expect.loadError) {
          if (errMsg.includes(manifest.expect.loadError)) {
            ctx.stdout.write(
              bold(green(`Assert.Manifest.${name}: assertion passed`)) +
                "\n  " + green("✓") + " " + dim(`load error: ${errMsg}`) + "\n",
            );
          } else {
            ctx.stderr.write(
              bold(red(`Assert.Manifest.${name}: assertion failed`)) +
                "\n  " + red("✗") + ` expected load error containing "${manifest.expect.loadError}"` +
                "\n  " + dim(`actual: ${errMsg}`) + "\n",
            );
            ctx.requestExit(1);
          }
          return;
        }
        ctx.stderr.write(
          bold(red(`Assert.Manifest.${name}: failed to load "${manifest.source}"`)) +
            "\n  " + errMsg + "\n",
        );
        ctx.requestExit(1);
        return;
      }

      if (manifest.expect.loadError) {
        ctx.stderr.write(
          bold(red(`Assert.Manifest.${name}: assertion failed`)) +
            "\n  " + red("✗") + ` expected load error containing "${manifest.expect.loadError}" but manifest loaded successfully\n`,
        );
        ctx.requestExit(1);
        return;
      }

      const { diagnostics } = checked;
      const errors = diagnostics.filter((d) => d.severity === "error");
      const warnings = diagnostics.filter((d) => d.severity === "warning");
      const expectedErrors = manifest.expect.errors ?? [];
      const expectedWarnings = manifest.expect.warnings ?? [];
      const failures: string[] = [];
      const matched: string[] = [];

      if (expectedErrors.length === 0) {
        // Expect zero errors — any error is a failure
        if (errors.length > 0) {
          for (const d of errors) {
            failures.push(`unexpected error: [${d.code}] ${d.message}`);
          }
        } else {
          matched.push("no errors");
        }
      } else {
        for (const expected of expectedErrors) {
          const match = errors.find((d) => matchesDiagnostic(d, expected));
          if (match) {
            matched.push(`${expected.code ?? "*"}${describeExpectation(expected)}`);
          } else {
            failures.push(
              `expected error ${expected.code ?? "*"}${describeExpectation(expected)} — not found`,
            );
          }
        }
      }

      // Warnings are checked only when the caller declares expect.warnings. Unexpected
      // warnings are not failures (unlike errors) — warnings are advisory and may exist
      // on manifests that are otherwise valid. When expect.warnings is present, every
      // listed warning must be found; extras are ignored.
      if (expectedWarnings.length > 0) {
        for (const expected of expectedWarnings) {
          const match = warnings.find((d) => matchesDiagnostic(d, expected));
          if (match) {
            matched.push(`warning ${expected.code ?? "*"}${describeExpectation(expected)}`);
          } else {
            failures.push(
              `expected warning ${expected.code ?? "*"}${describeExpectation(expected)} — not found`,
            );
          }
        }
      }

      // The static verdict pinned to the runtime one, in BOTH directions: a
      // fixture `telo check` refuses is one the kernel refuses (`runFails`), and
      // a fixture that checks clean is one the kernel STARTS (`runs`). Only the
      // second catches a repair that is really a refusal — without it a suite
      // whose every fixture is rejected passes, which is the property this
      // suite's own header claims it cannot have. `expect: {}` alone asserts
      // nothing about running, so a fixture meant to prove a fix works says
      // `runs: true`.
      if (manifest.expect.runFails !== undefined) {
        const { exitCode, stderr, timedOut } = await runToExit(ctx.runtime, resolvedUrl);
        if (timedOut) {
          failures.push(
            `expected the run to fail with "${manifest.expect.runFails}" — it was still ` +
              `running after ${RUN_TIMEOUT_MS / 1000}s and was cancelled`,
          );
        } else if (exitCode === 0) {
          failures.push(
            `expected the run to fail with "${manifest.expect.runFails}" — it exited 0`,
          );
        } else if (!stderr.includes(manifest.expect.runFails)) {
          failures.push(
            `expected the run to fail with "${manifest.expect.runFails}" — it failed with:\n` +
              stderr.trim().split("\n").map((l) => `      ${l}`).join("\n"),
          );
        } else {
          matched.push(`run fails: ${manifest.expect.runFails}`);
        }
      }

      if (manifest.expect.runs) {
        const { exitCode, stderr, timedOut } = await runToExit(ctx.runtime, resolvedUrl);
        if (timedOut) {
          failures.push(
            `expected the run to succeed — it was still running after ` +
              `${RUN_TIMEOUT_MS / 1000}s and was cancelled`,
          );
        } else if (exitCode !== 0) {
          failures.push(
            `expected the run to succeed — it exited ${exitCode}:\n` +
              stderr.trim().split("\n").map((l) => `      ${l}`).join("\n"),
          );
        } else {
          matched.push("runs");
        }
      }

      const passedLines = matched.map((m) => `  ${green("✓")} ${dim(m)}\n`).join("");
      if (failures.length > 0) {
        const failedLines = failures.map((f) => `  ${red("✗")} ${f}\n`).join("");
        const actualLines =
          errors.length > 0 || warnings.length > 0
            ? `  ${dim("actual diagnostics:")}\n` +
              [...errors, ...warnings]
                .map((d) => `    ${dim(`[${d.code}] ${d.message}`)}\n`)
                .join("")
            : `  ${dim("no diagnostics produced")}\n`;
        ctx.stderr.write(
          bold(red(`Assert.Manifest.${name}: assertion failed`)) + "\n" +
            passedLines + failedLines + actualLines,
        );
        ctx.requestExit(1);
      } else {
        ctx.stdout.write(
          bold(green(`Assert.Manifest.${name}: assertion passed`)) + "\n" + passedLines,
        );
      }
    },
  };
}
