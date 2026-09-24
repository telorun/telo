/**
 * Where `telo run`'s own arguments end and the application's begin: at the
 * manifest path. `telo run [options] <path> [application arguments]`, the rule
 * every interpreter follows (`node [options] app.js [args]`) — and what a
 * packaged application already does, where every token is the application's.
 *
 * Position decides, so an application may declare any flag it likes
 * (`--verbose`, `--watch`) without the CLI taking it, and a flag the CLI gains
 * later cannot start taking one away from an existing application. The split
 * runs BEFORE yargs sees the command line, because yargs cannot stop at a
 * positional once commands are registered.
 *
 * Finding the path still means knowing which of the CLI's own options consume
 * the next token, so that is read off the SAME option tables yargs registers —
 * a valued option added to either is recognized here with no second list.
 */
import type { Options } from "yargs";

const RUN_COMMAND = "run";

/** The CLI's option declarations, as registered with yargs, plus the shape a
 *  value must have for each option whose value is optional. */
export interface CliOptions {
  options: Readonly<Record<string, Options>>;
  /** Keyed by option name. Before the path an optional value may be the path
   *  itself, so it is read only when the next token has this shape; anything
   *  else is written `--<name>=<value>`. */
  optionalValueShapes: Readonly<Record<string, RegExp>>;
}

/** How a spelled option (`--output`, `-o`) treats the token after it:
 *  `always` consumes it, a RegExp consumes it only when it matches. */
type ValueRule = "always" | { name: string; shape: RegExp };

/**
 * Every spelling of every option that takes a value. An option taking a string
 * or number with `requiresArg` or `choices` always consumes the next token; one
 * taking a string without either has an OPTIONAL value, which must be given a
 * shape — throws otherwise, since guessing would split the command line wrong.
 */
export function valuedOptionSpellings(cli: CliOptions): Map<string, ValueRule> {
  const rules = new Map<string, ValueRule>();
  for (const [name, option] of Object.entries(cli.options)) {
    if (option.type !== "string" && option.type !== "number") continue;
    let rule: ValueRule;
    if (option.requiresArg || option.choices !== undefined) {
      rule = "always";
    } else {
      const shape = cli.optionalValueShapes[name];
      if (!shape) {
        throw new Error(
          `CLI option --${name} takes an optional value but declares no shape for it; ` +
            `add one to optionalValueShapes, or declare it requiresArg.`,
        );
      }
      rule = { name, shape };
    }
    const aliases = option.alias === undefined ? [] : [option.alias].flat();
    for (const spelling of [name, ...aliases]) {
      rules.set(spelling.length === 1 ? `-${spelling}` : `--${spelling}`, rule);
    }
  }
  return rules;
}

export interface RunInvocation {
  /** What yargs parses: everything up to and including the manifest path. */
  cliTokens: string[];
  /** Every token after the manifest path, for the application — or `undefined`
   *  when the invocation is not a run. */
  applicationArgs: readonly string[] | undefined;
}

/**
 * Split a command line at the manifest path of a `telo run <path>` (or the
 * default command's `telo <path>`). Any other command is returned unchanged:
 * `commands` names every top-level command, so a first positional that is one
 * of them is that command rather than a manifest.
 */
export function splitRunInvocation(
  tokens: readonly string[],
  commands: ReadonlySet<string>,
  cli: CliOptions,
): RunInvocation {
  const valued = valuedOptionSpellings(cli);
  const cliTokens: string[] = [];
  let sawRun = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") break;
    if (token.startsWith("-") && token !== "-") {
      const rule = token.includes("=") ? undefined : valued.get(token);
      const next = tokens[i + 1];
      if (rule === "always") {
        cliTokens.push(token);
        if (next !== undefined) cliTokens.push(tokens[++i]!);
      } else if (rule) {
        // Rewritten to the `=` form, so yargs cannot take the path as the value.
        const value = next !== undefined && rule.shape.test(next) ? tokens[++i]! : "";
        cliTokens.push(`--${rule.name}=${value}`);
      } else {
        cliTokens.push(token);
      }
      continue;
    }
    if (!sawRun && token === RUN_COMMAND) {
      sawRun = true;
      cliTokens.push(token);
      continue;
    }
    if (!sawRun && commands.has(token)) break;
    cliTokens.push(token);
    return { cliTokens, applicationArgs: tokens.slice(i + 1) };
  }
  return { cliTokens: [...tokens], applicationArgs: undefined };
}
