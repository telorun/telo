/** Bounded JSON text of what a failure carries; never throws on cycles, bigints or bytes. */
export function boundedSample(value: unknown, maxLength: number): string {
  if (value === undefined) return "";
  const seen = new WeakSet<object>();
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch (error) {
    text = `<unserializable: ${error instanceof Error ? error.message : String(error)}>`;
  }
  return truncate(text ?? "", maxLength);
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
