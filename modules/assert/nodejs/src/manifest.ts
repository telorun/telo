import { DEFAULT_MANIFEST_FILENAME, Loader, StaticAnalyzer, type AnalysisDiagnostic, type ManifestAdapter } from "@telorun/analyzer";
import type { ResourceContext, Runnable } from "@telorun/sdk";
import * as fs from "fs/promises";
import * as path from "path";

interface ExpectError {
  code?: string;
  message?: string;
}

interface ManifestAssertManifest {
  metadata: { name: string; module?: string };
  source: string;
  expect: {
    errors?: ExpectError[];
    loadError?: string;
  };
}

class LocalFileAdapter implements ManifestAdapter {
  supports(p: string): boolean {
    return (
      p.startsWith("file://") ||
      p.startsWith("/") ||
      p.startsWith("./") ||
      p.startsWith("../") ||
      (!p.includes("://") && !p.includes("@"))
    );
  }

  async read(p: string): Promise<{ text: string; source: string }> {
    const norm = p.startsWith("file://") ? new URL(p).pathname : p;
    const resolved = path.resolve(norm);
    const stat = await fs.stat(resolved);
    const filePath = stat.isDirectory() ? path.join(resolved, DEFAULT_MANIFEST_FILENAME) : resolved;
    const text = await fs.readFile(filePath, "utf-8");
    return { text, source: `file://${filePath}` };
  }

  async readAll(p: string): Promise<string[]> {
    const norm = p.startsWith("file://") ? new URL(p).pathname : p;
    const resolved = path.resolve(norm);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolved);
      return entries
        .filter((e) => e.endsWith(".yaml") || e.endsWith(".yml"))
        .map((e) => `file://${path.join(resolved, e)}`);
    }
    return [`file://${resolved}`];
  }

  resolveRelative(base: string, relative: string): string {
    const basePath = base.startsWith("file://") ? new URL(base).pathname : base;
    const baseDir = basePath.endsWith("/") ? basePath : path.dirname(basePath);
    return `file://${path.resolve(baseDir, relative)}`;
  }
}

function matchesDiagnostic(diag: AnalysisDiagnostic, expected: ExpectError): boolean {
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
      const loader = new Loader([new LocalFileAdapter()]);
      const analyzer = new StaticAnalyzer();

      const resolvedUrl = new URL(manifest.source, ctx.moduleContext.source).toString();
      let manifests;
      try {
        manifests = await loader.loadManifests(resolvedUrl);
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

      const diagnostics = analyzer.analyze(manifests);
      const errors = diagnostics.filter((d) => d.severity === 1); // DiagnosticSeverity.Error = 1
      const expectedErrors = manifest.expect.errors ?? [];
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
              `expected ${expected.code ?? "*"}${expected.message ? ` containing "${expected.message}"` : ""} — not found`,
            );
          }
        }
      }

      const passedLines = matched.map((m) => `  ${green("✓")} ${dim(m)}\n`).join("");
      if (failures.length > 0) {
        const failedLines = failures.map((f) => `  ${red("✗")} ${f}\n`).join("");
        const actualLines = errors.length > 0
          ? `  ${dim("actual errors:")}\n` +
            errors.map((d) => `    ${dim(`[${d.code}] ${d.message}`)}\n`).join("")
          : `  ${dim("no errors produced")}\n`;
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
