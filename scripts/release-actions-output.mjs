// The two ways a release script talks to the workflow that runs it: a step output
// and a refusal. Outside Actions the output is printed, so a script is readable
// from a terminal.

import { appendFileSync } from "node:fs";

export function setOutput(name, value) {
  const line = `${name}=${value}`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  else console.log(line);
}

/** Print a refusal as an Actions error annotation and fail the step. */
export function refuse(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}
