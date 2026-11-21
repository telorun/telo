import { readBinding, type Binding } from "./bindings.js";

/** A query's body as the page document carries it: a binding, or a map or list of templates. */
export type BodyTemplate = Binding | { map: Record<string, BodyTemplate> } | { list: BodyTemplate[] };

/** What a template resolves to: a value, or nothing to send. */
export type Resolved = { present: true; value: unknown } | { present: false };

/**
 * The body a template resolves to over the roots in scope. A chain holding
 * nothing — missing or `null` — leaves its member or list item out; a literal
 * is sent as written, `null` included; a map is sent even when every member was
 * left out. A whole body that is a chain holding nothing is nothing to send.
 * Held to `conformance/template-bindings.json`.
 */
export function resolveBody(template: BodyTemplate, roots: Readonly<Record<string, unknown>>): Resolved {
  if ("map" in template) {
    const value: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(template.map)) {
      const resolved = resolveBody(member, roots);
      if (resolved.present) value[name] = resolved.value;
    }
    return { present: true, value };
  }
  if ("list" in template) {
    const value: unknown[] = [];
    for (const item of template.list) {
      const resolved = resolveBody(item, roots);
      if (resolved.present) value.push(resolved.value);
    }
    return { present: true, value };
  }
  if ("value" in template) return { present: true, value: template.value };
  const read = readBinding(template, roots);
  return read.present && read.value !== null ? read : { present: false };
}
