import type { ResourceContext, Runnable, RuntimeDiagnostic } from "@telorun/sdk";

interface ExpectError {
  code?: string;
  message?: string;
}

interface ManifestAssertManifest {
  metadata: { name: string; module?: string };
  source: string;
  expect: {
    errors?: ExpectError[];
    warnings?: ExpectError[];
    loadError?: string;
  };
}

function matchesDiagnostic(diag: RuntimeDiagnostic, expected: ExpectError): boolean {
  if (expected.code && diag.code !== expected.code) return false;
  if (expected.message && !diag.message.includes(expected.message)) return false;
  return true;
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

      const resolvedUrl = new URL(manifest.source, ctx.moduleContext.source).toString();
      let diagnostics: RuntimeDiagnostic[];
      try {
        // A throwaway kernel, so the analysis registers nothing on the host and
        // resolves sources exactly the way a real run of this manifest would.
        diagnostics = await ctx.createKernel().analyze(resolvedUrl);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
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
            matched.push(
              `${expected.code ?? "*"}${expected.message ? ` (${expected.message})` : ""}`,
            );
          } else {
            failures.push(
              `expected error ${expected.code ?? "*"}${expected.message ? ` containing "${expected.message}"` : ""} — not found`,
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
            matched.push(
              `warning ${expected.code ?? "*"}${expected.message ? ` (${expected.message})` : ""}`,
            );
          } else {
            failures.push(
              `expected warning ${expected.code ?? "*"}${expected.message ? ` containing "${expected.message}"` : ""} — not found`,
            );
          }
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
