import { InvokeError, ResourceContext } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";
import { createColors } from "./colors.js";
import { deepEquals } from "./deep-equals.js";
import { differenceLines, differencesBetween, pointerTo, renderValue } from "./value-differences.js";

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

export async function create(manifest: AssertManifest, ctx: ResourceContext) {
  const { bold, red, green, dim } = createColors(ctx);
  const name = manifest.metadata.name;
  const verbose = Boolean(ctx.env.TELO_TEST_VERBOSE);

  return {
    invoke: (input: EqualsInput) => {
      const { actual, expected } = input ?? ({} as EqualsInput);
      if (deepEquals(actual, expected)) {
        ctx.stdout.write(
          bold(green(`Assert.Equals.${name}: assertion passed`)) +
            "\n" +
            `  ${green("✓")} ${dim(renderValue(actual, verbose ? Infinity : undefined))}\n`,
        );
        return true;
      }
      const differences = differencesBetween(actual, expected);
      const lines = differenceLines(differences);
      const full = verbose
        ? `  expected: ${renderValue(expected, Infinity)}\n  actual:   ${renderValue(actual, Infinity)}\n`
        : "";
      ctx.stderr.write(
        bold(red(`Assert.Equals.${name}: assertion failed`)) +
          "\n" +
          lines.map((line) => `  ${red("✗")} ${line}\n`).join("") +
          full,
      );
      const summary =
        differences.length === 1
          ? lines[0]
          : `${differences.length} differences:\n${lines.map((line) => `  ${line}`).join("\n")}`;
      throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Equals "${name}": ${summary}`, undefined, {
        inputPointer: pointerTo("/expected", differences[0].anchor),
      });
    },
  };
}
