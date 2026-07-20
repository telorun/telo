/**
 * Console color decision — `kernel/specs/logging.md` §11.2.
 *
 * The precedence order is normative and must be implemented exactly. Steps 2–7
 * apply only under `color: auto`; `always` / `never` short-circuit at step 1.
 *
 * These environment inputs are **not** a second configuration channel and do not
 * contradict D6. `NO_COLOR`, `FORCE_COLOR`, `TERM`, and `isatty()` describe the
 * terminal's capability and the operator's preference, not the application's
 * desired state: `auto` means "detect the environment", and the manifest remains
 * the sole authority over *what* is logged — these affect only how it is
 * painted.
 */

export type ColorSetting = "auto" | "always" | "never";

export interface ColorDecisionInput {
  /** The manifest's `color:` setting. */
  setting: ColorSetting;
  /** The environment to consult. Always the real host environment, never the
   *  guardrail proxy — these are host capability signals, not bindings. */
  env: Record<string, string | undefined>;
  /** Whether the **sink's actual output descriptor** is a TTY. A console sink on
   *  `stdout` and another on `stderr` can decide differently, and that is
   *  correct — this is never the process's descriptor by proxy. */
  isTTY: boolean;
}

export function decideColor(input: ColorDecisionInput): boolean {
  const { setting, env, isTTY } = input;

  // 1. An explicit manifest setting wins outright.
  if (setting === "always") return true;
  if (setting === "never") return false;

  // 2. NO_COLOR: presence and non-emptiness matter, the value does not. Testing
  //    mere presence is a widespread bug — `NO_COLOR=""` must NOT disable color.
  if (isNonEmpty(env["NO_COLOR"])) return false;

  // 3. FORCE_COLOR: "0" disables, any other non-empty value enables.
  const forceColor = env["FORCE_COLOR"];
  if (isNonEmpty(forceColor)) return forceColor !== "0";

  // 4. CLICOLOR_FORCE present and not "0" enables.
  const clicolorForce = env["CLICOLOR_FORCE"];
  if (clicolorForce !== undefined && clicolorForce !== "0") return true;

  // 5. CLICOLOR=0 disables.
  if (env["CLICOLOR"] === "0") return false;

  // 6. A dumb terminal cannot render color.
  if (env["TERM"] === "dumb") return false;

  // 7. Otherwise follow the descriptor. Note there is deliberately no CI-variable
  //    branch: forcing color on merely because a CI variable is present is a
  //    widespread bug in existing libraries, not a convention to copy.
  return isTTY;
}

function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
