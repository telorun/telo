import { RE2JS } from "re2js";

const compiled = new Map<string, RE2JS>();

/** Compiles an RE2 pattern that holds at least one group; throws with RE2's own message otherwise. */
export function compilePattern(pattern: string): RE2JS {
  let held = compiled.get(pattern);
  if (held === undefined) {
    held = RE2JS.compile(pattern);
    if (held.groupCount() < 1) throw new Error(`pattern ${JSON.stringify(pattern)} has no group to capture`);
    if (compiled.size >= 128) compiled.clear();
    compiled.set(pattern, held);
  }
  return held;
}

/** The first group of every match, in order. */
export function allFirstGroups(pattern: string, text: string): string[] {
  const matcher = compilePattern(pattern).matcher(text);
  const out: string[] = [];
  while (matcher.find()) {
    const group = matcher.group(1);
    if (group !== null && group !== undefined) out.push(group);
  }
  return out;
}

/** The first group of the first match; `undefined` when nothing matches. */
export function firstGroup(pattern: string, text: string): string | undefined {
  return allFirstGroups(pattern, text)[0];
}
