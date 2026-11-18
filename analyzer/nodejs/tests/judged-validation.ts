import { expect } from "vitest";
import { createAjv } from "../src/schema-compat.js";
import { judgeSchemaFindings } from "../src/schema-findings-judge.js";
import type { AjvErrorLike } from "../src/schema-error-report.js";
import { registeredDocument, SchemaNodeValidator } from "../src/schema-node-validator.js";
import type { StandIns } from "../src/stand-in-findings.js";

/** The findings the judge stands by for `value` refused by `schema`, as the
 *  analyzer's registry asks it: the host's plain errors, and a verbose twin to
 *  decide each union with. `shapes` are registered on the host alone, so the
 *  twin reaches them as it reaches a registry's. */
export function judgedFindings(
  schema: Record<string, any>,
  value: unknown,
  options: { standIns?: StandIns; shapes?: Record<string, Record<string, any>> } = {},
): AjvErrorLike[] {
  const host = createAjv();
  for (const [id, shape] of Object.entries(options.shapes ?? {})) host.addSchema(shape, id);
  const validate = host.compile(schema);
  expect(validate(value)).toBe(false);
  const twin = new SchemaNodeValidator(createAjv({ verbose: true }), {
    resolveReference: (id) => registeredDocument(host, id),
  });
  return judgeSchemaFindings(validate.errors, {
    value,
    schema,
    ...(options.standIns ? { standIns: options.standIns } : {}),
    validate: twin.findingsFor(schema),
    reference: (node, ref) => twin.reference(node, ref),
  });
}
