import { InvokeError, ResourceContext } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";
import { createColors } from "./colors.js";

export const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
  }),
});

type AssertManifest = Static<typeof schema>;

interface MatchesInput {
  actual: unknown;
  pattern: string;
  flags?: string;
}

export async function create(manifest: AssertManifest, ctx: ResourceContext) {
  const { bold, red, green, dim } = createColors(ctx);
  const name = manifest.metadata.name;

  return {
    invoke: (input: MatchesInput) => {
      const { actual, pattern, flags } = input ?? ({} as MatchesInput);

      if (typeof pattern !== "string") {
        throw new InvokeError(
          "ERR_INVALID_CONFIG",
          `Assert.Matches "${name}": 'pattern' must be a string`,
        );
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags ?? "");
      } catch (err) {
        throw new InvokeError(
          "ERR_INVALID_CONFIG",
          `Assert.Matches "${name}": invalid pattern — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (typeof actual !== "string") {
        const message = `actual must be a string; got ${typeof actual}`;
        ctx.stderr.write(
          bold(red(`Assert.Matches.${name}: assertion failed`)) +
            "\n" +
            `  ${red("✗")} ${message}\n`,
        );
        throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Matches "${name}": ${message}`);
      }
      if (regex.test(actual)) {
        ctx.stdout.write(
          bold(green(`Assert.Matches.${name}: assertion passed`)) +
            "\n" +
            `  ${green("✓")} ${dim(JSON.stringify(actual))} ${dim("~")} ${dim(regex.toString())}\n`,
        );
        return true;
      }
      const message = `${JSON.stringify(actual)} does not match ${regex.toString()}`;
      ctx.stderr.write(
        bold(red(`Assert.Matches.${name}: assertion failed`)) +
          "\n" +
          `  ${red("✗")} ${message}\n`,
      );
      throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Matches "${name}": ${message}`);
    },
  };
}
