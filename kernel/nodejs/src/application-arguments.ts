import {
  ARG_NEGATION_PREFIX,
  describeArgBinding,
  HELP_ARG_FLAG,
  type ArgBinding,
  type FlagArgBinding,
  type PositionalArgBinding,
} from "@telorun/analyzer";

/** The text each bound input received, keyed by block and then by entry name —
 *  one token, or every token for an array-typed binding. */
export interface ParsedArguments {
  variables: Record<string, string | boolean | string[]>;
  ports: Record<string, string>;
}

export interface ArgumentParse {
  values: ParsedArguments;
  /** `--help` was given: the caller answers with the usage and runs nothing. */
  help: boolean;
  errors: string[];
}

const END_OF_OPTIONS = "--";

/**
 * Read a root Application's command line against the `arg:` bindings it
 * declares. Normative grammar: `kernel/specs/application-arguments.md`.
 *
 * Deliberately strict — an argument nothing declares is an error naming what is
 * declared, never skipped: a typo'd flag silently ignored is a value the author
 * believes they passed.
 */
export function parseApplicationArguments(
  bindings: readonly ArgBinding[],
  argv: readonly string[],
): ArgumentParse {
  const values: ParsedArguments = { variables: {}, ports: {} };
  const errors: string[] = [];
  const flags = new Map<string, FlagArgBinding>();
  const shorts = new Map<string, FlagArgBinding>();
  const positions: PositionalArgBinding[] = [];
  for (const binding of bindings) {
    if (binding.form === "flag") {
      flags.set(binding.flag, binding);
      if (binding.short !== undefined) shorts.set(binding.short, binding);
    } else {
      positions.push(binding);
    }
  }
  const declared = bindings.map(describeArgBinding);
  const declaredHint =
    declared.length > 0 ? ` (it declares: ${declared.join(", ")})` : " (it declares no arguments)";

  const store = (binding: ArgBinding, value: string | boolean): void => {
    const block = values[binding.block] as Record<string, string | boolean | string[]>;
    if (binding.repeated) {
      const list = (block[binding.name] as string[] | undefined) ?? [];
      list.push(value as string);
      block[binding.name] = list;
      return;
    }
    if (Object.hasOwn(block, binding.name)) {
      errors.push(`${describeArgBinding(binding)} was given more than once`);
      return;
    }
    block[binding.name] = value;
  };

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === END_OF_OPTIONS) {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
      // Read as an option, never as a flag's value or after `--`.
      if (name === HELP_ARG_FLAG && inline === undefined) return { values, help: true, errors: [] };
      const binding = flags.get(name);
      if (binding) {
        if (binding.valueType === "boolean") {
          if (inline !== undefined) {
            errors.push(`--${name} is a boolean flag and takes no value — write --${name} or --no-${name}`);
          } else {
            store(binding, true);
          }
          continue;
        }
        const value = inline ?? argv[i + 1];
        if (value === undefined) {
          errors.push(`--${name} expects a value`);
          continue;
        }
        if (inline === undefined) i++;
        store(binding, value);
        continue;
      }
      const negated = name.startsWith(ARG_NEGATION_PREFIX)
        ? flags.get(name.slice(ARG_NEGATION_PREFIX.length))
        : undefined;
      if (negated && negated.valueType === "boolean" && inline === undefined) {
        store(negated, false);
        continue;
      }
      errors.push(`unknown option --${name}${declaredHint}`);
      continue;
    }
    if (/^-[A-Za-z]$/.test(token)) {
      const binding = shorts.get(token.slice(1));
      if (!binding) {
        errors.push(`unknown option ${token}${declaredHint}`);
        continue;
      }
      if (binding.valueType === "boolean") {
        store(binding, true);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined) {
        errors.push(`${token} expects a value`);
        continue;
      }
      i++;
      store(binding, value);
      continue;
    }
    if (/^-[A-Za-z]/.test(token)) {
      const attached = shorts.get(token[1]!);
      errors.push(
        attached && attached.valueType !== "boolean"
          ? `${token}: a short option takes its value as the next argument — write -${token[1]} ${token.slice(token[2] === "=" ? 3 : 2)}`
          : `unknown option ${token}${declaredHint}`,
      );
      continue;
    }
    positionals.push(token);
  }

  positionals.forEach((token, index) => {
    const last = positions[positions.length - 1];
    const binding = positions[index] ?? (last?.repeated ? last : undefined);
    if (!binding) {
      errors.push(`unexpected argument '${token}'${declaredHint}`);
      return;
    }
    store(binding, token);
  });

  return { values, help: false, errors };
}
