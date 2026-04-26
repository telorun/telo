import { Static, Type } from "@sinclair/typebox";
import { ResourceContext, Runnable } from "@telorun/sdk";

const ImportEntry = Type.Object({
  variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
  secrets: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
    module: Type.Optional(Type.String()),
  }),
  resources: Type.Optional(Type.Record(Type.String(), ImportEntry)),
  variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
  secrets: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

type ModuleContextManifest = Static<typeof schema>;

function createColors(stream: NodeJS.WritableStream) {
  const useColor = (stream as any).isTTY ?? false;
  const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: (t: string) => c("1", t),
    red: (t: string) => c("31", t),
    green: (t: string) => c("32", t),
    yellow: (t: string) => c("33", t),
    dim: (t: string) => c("2", t),
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!deepEqual((a as any)[key], (b as any)[key])) return false;
  }
  return true;
}

export async function create(
  manifest: ModuleContextManifest,
  ctx: ResourceContext,
): Promise<Runnable> {
  return {
    run: async () => {
      const { bold, red, green, yellow, dim } = createColors(ctx.stderr);
      const resourcesToCheck = manifest.resources ?? {};
      const failures: string[] = [];
      const passed: string[] = [];
      const { resources } = ctx.moduleContext;
      for (const [alias, expected] of Object.entries(resourcesToCheck)) {
        if (!ctx.moduleContext.hasImport(alias)) {
          failures.push(`Import alias '${alias}' not found in declaring module`);
          continue;
        }

        const snap = (resources[alias] as any) ?? {};
        const path = `resources.${alias}`;

        for (const [key, expectedValue] of Object.entries(expected.variables ?? {})) {
          const actual = snap?.variables?.[key];
          if (deepEqual(actual, expectedValue)) {
            passed.push(`${path}.variables.${key}`);
          } else {
            failures.push(`${path}.variables.${key}: expected ${yellow(JSON.stringify(expectedValue))}, got ${red(JSON.stringify(actual))}`);
          }
        }

        for (const [key, expectedValue] of Object.entries(expected.secrets ?? {})) {
          const actual = snap?.secrets?.[key];
          if (deepEqual(actual, expectedValue)) {
            passed.push(`${path}.secrets.${key}`);
          } else {
            failures.push(`${path}.secrets.${key}: ${dim("value mismatch")}`);
          }
        }
      }

      const name = manifest.metadata.name;
      const passedLines = passed.map((p) => `  ${green("✓")} ${dim(p)}\n`).join("");
      if (failures.length > 0) {
        const failedLines = failures.map((f) => `  ${red("✗")} ${f}\n`).join("");
        ctx.stderr.write(bold(red(`Assert.ModuleContext.${name}: assertion failed`)) + "\n" + passedLines + failedLines);
        ctx.requestExit(1);
      } else {
        ctx.stdout.write(bold(green(`Assert.ModuleContext.${name}: assertion passed`)) + "\n" + passedLines);
      }
    },
  };
}
