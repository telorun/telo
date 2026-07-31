import { InvokeError, ResourceContext } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";
import { createColors } from "./colors.js";
import { deepEquals } from "./deep-equals.js";

const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
  }),
});

type AssertManifest = Static<typeof schema>;

interface EqualsInput {
  actual: unknown;
  expected: unknown;
}

/** Render a value for output without throwing. CEL evaluates an integer to a
 *  BigInt, which `JSON.stringify` refuses — so reporting a result that contained
 *  one replaced the assertion's own message (pass or fail) with a TypeError. */
function render(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}` : v)) ?? String(value);
  } catch {
    return String(value);
  }
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
            `  ${green("✓")} ${dim(render(actual))}\n`,
        );
        return true;
      }
      const message = `expected ${render(expected)}, got ${render(actual)}`;
      ctx.stderr.write(
        bold(red(`Assert.Equals.${name}: assertion failed`)) +
          "\n" +
          `  ${red("✗")} ${message}\n`,
      );
      throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Equals "${name}": ${message}`);
    },
  };
}
