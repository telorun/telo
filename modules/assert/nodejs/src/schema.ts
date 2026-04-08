import { ResourceContext } from "@telorun/sdk";
import { Static, Type } from "@sinclair/typebox";

export const schema = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
  }),
  schema: Type.Object({
    type: Type.String(),
  }),
});

type AssertManifest = Static<typeof schema>;

export async function create(manifest: AssertManifest, ctx: ResourceContext) {
  const useColor = (ctx.stderr as any).isTTY ?? false;
  const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (t: string) => c("1", t);
  const red = (t: string) => c("31", t);
  const green = (t: string) => c("32", t);
  const dim = (t: string) => c("2", t);

  const validator = ctx.createSchemaValidator(manifest.schema);
  const name = manifest.metadata.name;
  return {
    invoke: (data: any) => {
      try {
        validator.validate(data);
        ctx.stdout.write(bold(green(`Assert.Schema.${name}: assertion passed`)) + "\n" + `  ${green("✓")} ${dim(JSON.stringify(data))}\n`);
        return true;
      } catch (err: any) {
        ctx.stderr.write(bold(red(`Assert.Schema.${name}: assertion failed`)) + "\n" + `  ${red("✗")} ${err?.message ?? String(err)}\n`);
        throw err;
      }
    },
  };
}
