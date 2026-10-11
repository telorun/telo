/** The text an editor entry point puts into the composer. Each names what the
 *  user pointed at; the user edits it and sends it themselves. */

export function fixDiagnosticPrompt(diagnostic: {
  code?: string | number;
  file: string;
  /** 1-based. */
  line: number;
  message: string;
}): string {
  const code = diagnostic.code === undefined || diagnostic.code === "" ? "" : `${diagnostic.code} `;
  return `Fix this diagnostic: ${code}at \`${diagnostic.file}\` line ${diagnostic.line}\n\n${diagnostic.message}`;
}

export function askAboutResourcePrompt(resource: { kind: string; name: string; file: string }): string {
  return `About the resource \`${resource.name}\` (${resource.kind}) in \`${resource.file}\`: `;
}

export function explainRunFailurePrompt(run: {
  application: string;
  file: string;
  failure: string[];
  /** The last lines of the run's output, when the dock holds any. */
  output: string | null;
}): string {
  const head = `Explain this failure of the application \`${run.application}\` (\`${run.file}\`):\n\n${run.failure.join("\n")}`;
  return run.output ? `${head}\n\nLast lines of its output:\n\n${fenced(run.output)}` : head;
}

export function selectionPrompt(selection: {
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}): string {
  const lines =
    selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}-${selection.endLine}`;
  return `From \`${selection.file}\`, ${lines}:\n\n${fenced(selection.text, languageOf(selection.file))}`;
}

function languageOf(file: string): string {
  return /\.ya?ml$/i.test(file) ? "yaml" : "";
}

/** A fence longer than any run of backticks inside the text it holds. */
function fenced(text: string, language = ""): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n+$/, "")}\n${fence}`;
}
