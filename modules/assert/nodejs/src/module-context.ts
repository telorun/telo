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
  imports: Type.Optional(Type.Record(Type.String(), ImportEntry)),
});

type ModuleContextManifest = Static<typeof schema>;

const useColor = process.stderr.isTTY;
const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => c("1", t);
const red = (t: string) => c("31", t);
const green = (t: string) => c("32", t);
const yellow = (t: string) => c("33", t);
const dim = (t: string) => c("2", t);

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
      const declaringModule = manifest.metadata.module ?? "default";
      const importsToCheck = manifest.imports ?? {};
      const failures: string[] = [];
      const passed: string[] = [];

      for (const [alias, expected] of Object.entries(importsToCheck)) {
        const realModule = (ctx as any).resolveModuleAlias(declaringModule, alias) as
          | string
          | undefined;
        if (!realModule) {
          failures.push(`Import alias '${alias}' not found in module '${declaringModule}'`);
          continue;
        }

        const moduleCtx = ctx.moduleContext;
        const importSnap = (moduleCtx.resources[alias] as any) ?? {};
        const expectedVariables = expected.variables ?? {};
        const expectedSecrets = expected.secrets ?? {};

        for (const [key, expectedValue] of Object.entries(expectedVariables)) {
          const actualValue = importSnap?.variables?.[key];
          if (!deepEqual(actualValue, expectedValue)) {
            failures.push(
              `imports.${alias}.variables.${key}: expected ${yellow(JSON.stringify(expectedValue))}, got ${red(JSON.stringify(actualValue))}`,
            );
          } else {
            passed.push(`imports.${alias}.variables.${key}`);
          }
        }

        for (const [key] of Object.entries(expectedSecrets)) {
          const actualSecret = importSnap?.secrets?.[key];
          if (!deepEqual(actualSecret, expectedSecrets[key])) {
            failures.push(`imports.${alias}.secrets.${key}: ${dim("value mismatch")}`);
          } else {
            passed.push(`imports.${alias}.secrets.${key}`);
          }
        }
      }

      const name = manifest.metadata.name;
      if (failures.length > 0) {
        let report = bold(red(`Assert.ModuleContext.${name}: assertion failed`)) + "\n";
        for (const p of passed) {
          report += `  ${green("✓")} ${dim(p)}\n`;
        }
        for (const f of failures) {
          report += `  ${red("✗")} ${f}\n`;
        }
        process.stderr.write(report);
        ctx.requestExit(1);
      } else {
        let report = bold(green(`Assert.ModuleContext.${name}: assertion passed`)) + "\n";
        for (const p of passed) {
          report += `  ${green("✓")} ${dim(p)}\n`;
        }
        process.stdout.write(report);
      }
    },
  };
}
