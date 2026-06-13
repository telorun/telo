// Strip ANSI escape sequences for plain-text display. The raw line (escapes
// intact) is preserved on the wire; richer in-place rendering can layer on later.
// Built from string source so the ESC/CSI control bytes stay unambiguous.
const ANSI = new RegExp(
  "[\\u001b\\u009b][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]",
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
