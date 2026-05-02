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

interface ContainsInput {
  actual: unknown;
  value: unknown;
}

export async function create(manifest: AssertManifest, ctx: ResourceContext) {
  const { bold, red, green, dim } = createColors(ctx);
  const name = manifest.metadata.name;

  return {
    invoke: (input: ContainsInput) => {
      const { actual, value } = input ?? ({} as ContainsInput);

      let ok = false;
      let kind = "";
      if (typeof actual === "string") {
        if (typeof value !== "string") {
          const message = `actual is a string but value is ${typeof value}; expected substring`;
          ctx.stderr.write(
            bold(red(`Assert.Contains.${name}: assertion failed`)) +
              "\n" +
              `  ${red("✗")} ${message}\n`,
          );
          throw new InvokeError(
            "ERR_ASSERTION_FAILED",
            `Assert.Contains "${name}": ${message}`,
          );
        }
        kind = "substring";
        ok = actual.includes(value);
      } else if (Array.isArray(actual)) {
        kind = "element";
        ok = actual.some((item) => deepEquals(item, value));
      } else {
        const message = `actual must be string or array; got ${typeof actual}`;
        ctx.stderr.write(
          bold(red(`Assert.Contains.${name}: assertion failed`)) +
            "\n" +
            `  ${red("✗")} ${message}\n`,
        );
        throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Contains "${name}": ${message}`);
      }

      if (ok) {
        ctx.stdout.write(
          bold(green(`Assert.Contains.${name}: assertion passed`)) +
            "\n" +
            `  ${green("✓")} ${dim(JSON.stringify(actual))} ${dim("⊇")} ${dim(JSON.stringify(value))}\n`,
        );
        return true;
      }
      const message = `${JSON.stringify(actual)} does not contain ${kind} ${JSON.stringify(value)}`;
      ctx.stderr.write(
        bold(red(`Assert.Contains.${name}: assertion failed`)) +
          "\n" +
          `  ${red("✗")} ${message}\n`,
      );
      throw new InvokeError("ERR_ASSERTION_FAILED", `Assert.Contains "${name}": ${message}`);
    },
  };
}
