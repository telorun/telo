/** Renders a padded plain-text table; `bold` styles the header cells, `rule` adds a line under them. */
export function renderTextTable(
  header: string[],
  rows: string[][],
  bold: (text: string) => string,
  rule = true,
): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const lines = [header.map((h, i) => bold(h.padEnd(widths[i]))).join("  ")];
  if (rule) lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) lines.push(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
  return lines.join("\n") + "\n";
}
