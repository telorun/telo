export interface TerminalStreams {
  /** `false` is `--no-input`. */
  input?: boolean;
  stdin: { isTTY?: boolean };
  stderr: { isTTY?: boolean };
}

/** Whether a person is at the terminal: stdin and stderr are TTYs and `--no-input` was not given. */
export function personIsAtTerminal(streams: TerminalStreams): boolean {
  return streams.input !== false && streams.stdin.isTTY === true && streams.stderr.isTTY === true;
}
