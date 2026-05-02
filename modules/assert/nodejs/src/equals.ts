import { InvokeError, ResourceContext } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";
import { createColors } from "./colors.js";
import { deepEquals } from "./deep-equals.js";

export const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
  }),
});

type AssertManifest = Static<typeof schema>;

interface EqualsInput {
  actual: unknown;
  expected: unknown;
}

export async function create(manifest: AssertManifest, ctx: ResourceContext) {
  const { bold, red, green, dim } = createColors(ctx);
  const name = manifest.metadata.name;

  return {
    invoke: (input: EqualsInput) => {
      const { actual, expected } = input ?? ({} as EqualsInput);
      if (deepEquals(actual, expected)) {
        ctx.stdout.write(
          bold(green(`Assert.Equals.${name}: assertion passed`)) +
            "\n" +
            `  ${green("✓")} ${dim(JSON.stringify(actual))}\n`,
        );
        return true;
      }
      const message = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
      ctx.stderr.write(
        bold(red(`Assert.Equals.${name}: assertion failed`)) +
          "\n" +
          `  ${red("✗")} ${message}\n`,
      );
      throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Equals "${name}": ${message}`);
    },
  };
}
