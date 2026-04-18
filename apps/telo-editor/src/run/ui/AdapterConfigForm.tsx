import type { JSONSchema7 } from "json-schema";
import { ResourceSchemaForm } from "../../components/resource-schema-form";
import type { ConfigIssue, RunAdapter } from "../types";

interface AdapterConfigFormProps<Config> {
  adapter: RunAdapter<Config>;
  value: Config;
  onChange: (next: Config) => void;
}

/** Renders the config form for a run adapter: either the adapter's custom
 *  form (if it set one) or a generic ResourceSchemaForm driven by the
 *  adapter's JSON Schema. Issues from `validateConfig` are shown as a
 *  summary banner above the form — inline per-field errors require a
 *  `fieldErrors` prop on ResourceSchemaForm which is a separate follow-up. */
export function AdapterConfigForm<Config>({ adapter, value, onChange }: AdapterConfigFormProps<Config>) {
  const issues = adapter.validateConfig(value);
  const CustomForm = adapter.customForm;

  return (
    <div className="flex flex-col gap-3">
      {issues.length > 0 && <IssueSummary issues={issues} schema={adapter.configSchema} />}
      {CustomForm ? (
        <CustomForm value={value} issues={issues} onChange={onChange} />
      ) : (
        <ResourceSchemaForm
          schema={adapter.configSchema as unknown as Record<string, unknown>}
          values={(value as unknown as Record<string, unknown>) ?? {}}
          onChange={(next) => onChange(next as unknown as Config)}
        />
      )}
    </div>
  );
}

function IssueSummary({ issues, schema }: { issues: ConfigIssue[]; schema: JSONSchema7 }) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950">
      <p className="font-medium text-red-700 dark:text-red-400">
        {issues.length === 1 ? "Configuration issue" : "Configuration issues"}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 text-red-700 dark:text-red-300">
        {issues.map((issue, i) => (
          <li key={`${issue.path}-${i}`}>
            <span className="font-medium">{resolveLabel(schema, issue.path)}:</span>{" "}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Walk a JSON pointer against the schema and return the most user-friendly
 *  label available: the field's `title`, or the last path segment, or the
 *  raw pointer if the pointer doesn't resolve. Handles the fragments we
 *  actually produce (`/image`, `/dockerHost`); not a full RFC 6901
 *  implementation — intentionally, so the summary row never surprises the
 *  user with strange characters. */
function resolveLabel(schema: JSONSchema7, pointer: string): string {
  if (!pointer.startsWith("/")) return pointer;
  const segments = pointer.slice(1).split("/").filter(Boolean);
  if (segments.length === 0) return pointer;

  let node: JSONSchema7 | undefined = schema;
  for (const seg of segments) {
    const properties = node?.properties;
    if (!properties || typeof properties !== "object") {
      return segments[segments.length - 1]!;
    }
    const next = (properties as Record<string, unknown>)[seg];
    if (!next || typeof next !== "object") {
      return segments[segments.length - 1]!;
    }
    node = next as JSONSchema7;
  }
  if (typeof node?.title === "string" && node.title.length > 0) return node.title;
  return segments[segments.length - 1]!;
}
