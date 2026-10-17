// Re-export the shared manifest fragments so consumers reaching them through the
// kernel's surface keep working. The canonical home is `@telorun/analyzer`: they
// describe manifest STRUCTURE, and the editor validates in a browser through the
// analyzer, which must not depend on this package — a fragment here would exist
// only at runtime, invisible to `telo check` and to the editor.
export {
  InvokeStepSchema,
  isSchemaFragment,
  JsonSchema7Schema,
  KindSchemaSchema,
  MANIFEST_SCHEMA_URI,
  ManifestRootSchema,
  manifestFragmentRef,
  ResourceRefSchema,
  RetryPolicySchema,
  StepSchema,
  withSchemaFragments,
} from "@telorun/analyzer";

/** Re-exported from the analyzer so a schema failure is phrased identically
 *  under `telo check` and at runtime — the kernel's own copy rendered the same
 *  failure as a raw `instancePath + message` join and handled no union. */
export { formatAjvErrors } from "@telorun/analyzer";
