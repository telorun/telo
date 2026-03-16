import { JSONPath } from "jsonpath-plus";

/** Evaluate a JSON Path (RFC 9535) expression against a resource config and return the
 *  string values found. These are the referenced resource names at that call site.
 *  Returns [] when the path matches nothing or yields non-string values. Never throws. */
export function resolveScope(config: Record<string, any>, scope: string): string[] {
  try {
    const results: unknown[] = JSONPath({ path: scope, json: config, resultType: "value" });
    return results.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}
