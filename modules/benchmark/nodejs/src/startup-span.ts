/**
 * The duration of the first `startup <application>` span in a JSON-lines log file, or undefined
 * when the file holds none. Lines after it are not read; a line that is not JSON is skipped,
 * since a sink may share the file with other output.
 */
export function startupSpanMs(text: string): number | undefined {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end === -1 ? text.length : end).trim();
    start = end === -1 ? text.length : end + 1;
    if (!line.startsWith("{")) continue;
    let record: { event_name?: unknown; msg?: unknown; attributes?: Record<string, unknown> };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.event_name !== "telo.span" || typeof record.msg !== "string" || !record.msg.startsWith("startup ")) {
      continue;
    }
    const duration = Number(record.attributes?.["telo.span.duration_ms"]);
    if (Number.isFinite(duration)) return duration;
  }
  return undefined;
}
