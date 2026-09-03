/**
 * Concrete field path → JSON Pointer.
 *
 * The projection speaks concrete paths (`steps[0].then[1]`) because that is what
 * a manifest walk and a position index are keyed by; the editor's AST operations
 * take pointers (`/steps/0/then/1`). One conversion, at the boundary between
 * them — a second spelling of this rule is how a canvas edit lands on the wrong
 * node, silently, since both forms are plausible strings.
 */
export function jsonPointer(path: string): string {
  const segments: string[] = [];
  for (const part of path.split(".")) {
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    // A segment the grammar does not cover is passed through whole rather than
    // dropped: losing it would silently retarget the write one level up.
    if (!match) {
      segments.push(part);
      continue;
    }
    const [, head, indices] = match;
    if (head) segments.push(head);
    for (const index of indices?.match(/\d+/g) ?? []) segments.push(index);
  }
  return `/${segments.map(escapePointerSegment).join("/")}`;
}

/** RFC 6901 escaping: `~` and `/` inside a map key would otherwise re-read as
 *  pointer syntax. A map-valued slot's key is author text, so this is reachable. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
