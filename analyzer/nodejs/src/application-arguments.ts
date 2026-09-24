/**
 * The command line as a host channel for a root Application's inputs — the
 * single reader of the `arg:` key on `variables:` / `ports:` entries.
 *
 * An input's identity is its declared NAME; `env:` and `arg:` are two bindings
 * that deliver a value to it. So the command line adds no namespace: `arg:` sits
 * beside `env:` on the entry, and `variables.<name>` / `ports.<name>` read the
 * same value whichever channel supplied it. Normative grammar and precedence:
 * `kernel/specs/application-arguments.md`.
 *
 * Browser-safe, and read by both halves — the analyzer's strict pass reports
 * every issue as a diagnostic, and the kernel parses argv against the bindings
 * (refusing the same issues, since a stamped analysis may have skipped them).
 */

export type ArgValueType = "string" | "integer" | "number" | "boolean";

export type ArgBindingBlock = "variables" | "ports";

interface ArgBindingBase {
  readonly block: ArgBindingBlock;
  /** The declared entry name — what `variables.<name>` / `ports.<name>` reads. */
  readonly name: string;
  /** The type of one token's value. */
  readonly valueType: ArgValueType;
  /** Array-typed: every occurrence (a flag) or every remaining token (the last
   *  position) is collected. */
  readonly repeated: boolean;
}

export interface FlagArgBinding extends ArgBindingBase {
  readonly form: "flag";
  readonly flag: string;
  readonly short?: string;
}

export interface PositionalArgBinding extends ArgBindingBase {
  readonly form: "position";
  readonly position: number;
}

export type ArgBinding = FlagArgBinding | PositionalArgBinding;

export type ArgBindingIssueCode = "ARG_BINDING_INVALID" | "ARG_BINDING_ON_SECRET";

export interface ArgBindingIssue {
  readonly code: ArgBindingIssueCode;
  /** Dotted path to the offending node, from the module doc. */
  readonly path: string;
  readonly message: string;
}

export interface ApplicationArguments {
  /** Flags in declaration order, then positions in ascending order. */
  readonly bindings: readonly ArgBinding[];
  readonly issues: readonly ArgBindingIssue[];
}

/** The flag the runtime answers with the application's usage. */
export const HELP_ARG_FLAG = "help";

/** Flags the runtime answers itself. */
export const RESERVED_ARG_FLAGS: ReadonlySet<string> = new Set([HELP_ARG_FLAG]);

/** `--no-<flag>` negates a boolean flag, so a flag spelled `no-…` would be
 *  ambiguous with the negation of another. */
export const ARG_NEGATION_PREFIX = "no-";

/** The shapes `arg:` may take — its SPELLING is the built-in schema's to check
 *  (`builtins.ts`), so a malformed one is reported once, as a schema violation,
 *  and read here as no binding. */
const FLAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SHORT_PATTERN = /^[A-Za-z]$/;
const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The binding the entries of a root Application declare, and every way they
 *  disagree with the grammar. A malformed binding is left out of `bindings`;
 *  one the schema refuses reports no issue here, since the schema already did. */
export function readApplicationArguments(moduleDoc: unknown): ApplicationArguments {
  const bindings: ArgBinding[] = [];
  const issues: ArgBindingIssue[] = [];
  if (!isRecord(moduleDoc)) return { bindings, issues };

  const secrets = moduleDoc.secrets;
  if (isRecord(secrets)) {
    for (const [name, entry] of Object.entries(secrets)) {
      if (isRecord(entry) && "arg" in entry) {
        issues.push({
          code: "ARG_BINDING_ON_SECRET",
          path: `secrets.${name}.arg`,
          message:
            `secrets.${name}: a secret cannot be bound to the command line — a command line ` +
            `is readable in the process table and in shell history. Bind it with 'env:'.`,
        });
      }
    }
  }

  for (const block of ["variables", "ports"] as const) {
    const entries = moduleDoc[block];
    if (!isRecord(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (!isRecord(entry) || !("arg" in entry)) continue;
      const binding = readBinding(block, name, entry, issues);
      if (binding) bindings.push(binding);
    }
  }

  checkUniqueness(bindings, issues);
  const positions = checkPositions(bindings, issues);
  const flags = bindings.filter((b): b is FlagArgBinding => b.form === "flag");
  return { bindings: [...flags, ...positions], issues };
}

function readBinding(
  block: ArgBindingBlock,
  name: string,
  entry: Record<string, unknown>,
  issues: ArgBindingIssue[],
): ArgBinding | undefined {
  const path = `${block}.${name}.arg`;
  const invalid = (message: string): undefined => {
    issues.push({ code: "ARG_BINDING_INVALID", path, message: `${block}.${name}: ${message}` });
    return undefined;
  };

  const type = readValueType(block, entry);
  if (typeof type === "string") return invalid(type);

  // Runner sessions and the studio supply an application's inputs through the
  // environment, never through argv, so an input only the command line can set
  // must still have a value when started there.
  if (block === "variables" && typeof entry.env !== "string" && entry.default === undefined) {
    invalid(
      "an entry bound only to the command line needs a 'default:' — a runner session and " +
        "the studio supply inputs through the environment, so bind 'env:' too or give it a default.",
    );
  }

  const arg = entry.arg;
  if (typeof arg === "string") return flagBinding(block, name, type, arg, undefined, invalid);
  if (!isRecord(arg)) return undefined;
  if ("position" in arg) {
    const position = arg.position;
    if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return undefined;
    if (type.valueType === "boolean") {
      return invalid("a boolean cannot be positional — bind it to a flag, which '--no-<flag>' negates.");
    }
    return { block, name, form: "position", position, ...type };
  }
  if (typeof arg.flag !== "string") return undefined;
  if (arg.short !== undefined && (typeof arg.short !== "string" || !SHORT_PATTERN.test(arg.short))) {
    return undefined;
  }
  return flagBinding(block, name, type, arg.flag, arg.short as string | undefined, invalid);
}

function flagBinding(
  block: ArgBindingBlock,
  name: string,
  type: { valueType: ArgValueType; repeated: boolean },
  flag: string,
  short: string | undefined,
  invalid: (message: string) => undefined,
): ArgBinding | undefined {
  if (!FLAG_PATTERN.test(flag)) return undefined;
  if (flag.startsWith(ARG_NEGATION_PREFIX)) {
    return invalid(`flag '${flag}' collides with the '--no-<flag>' negation of a boolean flag.`);
  }
  if (RESERVED_ARG_FLAGS.has(flag)) {
    return invalid(`flag '--${flag}' is reserved: the runtime answers it with the application's usage.`);
  }
  if (type.repeated && type.valueType === "boolean") {
    return invalid("an array of booleans cannot be bound to a flag.");
  }
  return { block, name, form: "flag", flag, ...(short !== undefined ? { short } : {}), ...type };
}

/** One token's type, or the message saying why the entry's type cannot take a
 *  command-line value. A port is implicitly an integer. */
function readValueType(
  block: ArgBindingBlock,
  entry: Record<string, unknown>,
): { valueType: ArgValueType; repeated: boolean } | string {
  if (block === "ports") return { valueType: "integer", repeated: false };
  const type = entry.type;
  if (typeof type === "string" && SCALAR_TYPES.has(type)) {
    return { valueType: type as ArgValueType, repeated: false };
  }
  if (type === "array") {
    const items = isRecord(entry.items) ? entry.items.type : undefined;
    if (typeof items === "string" && SCALAR_TYPES.has(items)) {
      return { valueType: items as ArgValueType, repeated: true };
    }
    return "an array bound to the command line must declare scalar 'items.type' (string, integer, number or boolean).";
  }
  return `a ${JSON.stringify(type)} value cannot be bound to the command line — only scalars and arrays of scalars can.`;
}

function checkUniqueness(bindings: ArgBinding[], issues: ArgBindingIssue[]): void {
  const flags = new Map<string, ArgBinding>();
  const shorts = new Map<string, ArgBinding>();
  const positions = new Map<number, ArgBinding>();
  const duplicate = (binding: ArgBinding, what: string, first: ArgBinding) =>
    issues.push({
      code: "ARG_BINDING_INVALID",
      path: `${binding.block}.${binding.name}.arg`,
      message: `${binding.block}.${binding.name}: ${what} is already bound by ${first.block}.${first.name}.`,
    });
  for (const binding of [...bindings]) {
    if (binding.form === "flag") {
      const firstFlag = flags.get(binding.flag);
      if (firstFlag) duplicate(binding, `flag '--${binding.flag}'`, firstFlag);
      else flags.set(binding.flag, binding);
      if (binding.short !== undefined) {
        const firstShort = shorts.get(binding.short);
        if (firstShort) duplicate(binding, `short flag '-${binding.short}'`, firstShort);
        else shorts.set(binding.short, binding);
      }
    } else {
      const firstPosition = positions.get(binding.position);
      if (firstPosition) duplicate(binding, `position ${binding.position}`, firstPosition);
      else positions.set(binding.position, binding);
    }
  }
}

/** Positions must run 0, 1, 2, … with no gap, and only the last may collect the
 *  remaining tokens. Returns the positional bindings in order. */
function checkPositions(bindings: ArgBinding[], issues: ArgBindingIssue[]): PositionalArgBinding[] {
  const byPosition = new Map<number, PositionalArgBinding>();
  for (const binding of bindings) {
    if (binding.form === "position" && !byPosition.has(binding.position)) {
      byPosition.set(binding.position, binding);
    }
  }
  const ordered = [...byPosition.values()].sort((a, b) => a.position - b.position);
  ordered.forEach((binding, index) => {
    const path = `${binding.block}.${binding.name}.arg`;
    if (binding.position !== index) {
      issues.push({
        code: "ARG_BINDING_INVALID",
        path,
        message:
          `${binding.block}.${binding.name}: position ${binding.position} leaves position ${index} ` +
          `unbound — positions run from 0 with no gap.`,
      });
    }
    if (binding.repeated && index !== ordered.length - 1) {
      issues.push({
        code: "ARG_BINDING_INVALID",
        path,
        message:
          `${binding.block}.${binding.name}: only the last position may be an array — it collects ` +
          `every remaining token, so nothing could reach a position after it.`,
      });
    }
  });
  return ordered;
}

/** How a binding is spelled on a command line — `--include`, `<filter>`. */
export function describeArgBinding(binding: ArgBinding): string {
  if (binding.form === "flag") return `--${binding.flag}`;
  return binding.repeated ? `<${binding.name}...>` : `<${binding.name}>`;
}

/** The facts of an entry a usage reads beside its binding. */
interface UsageFacts {
  default?: unknown;
  env?: unknown;
  title?: unknown;
  description?: unknown;
}

function factsOf(moduleDoc: unknown, binding: ArgBinding): UsageFacts {
  const block = isRecord(moduleDoc) ? moduleDoc[binding.block] : undefined;
  const entry = isRecord(block) ? block[binding.name] : undefined;
  return isRecord(entry) ? (entry as UsageFacts) : {};
}

/** An argument may be left out when its entry has another source — a default,
 *  or an environment variable. */
function isOptional(facts: UsageFacts): boolean {
  return facts.default !== undefined || typeof facts.env === "string";
}

/** One binding in the synopsis notation: `<name>` / `[<name>]`,
 *  `--flag|-f <type>` / `[--flag|-f <type>]`, a trailing `...` when it repeats,
 *  and `[--[no-]flag]` for a boolean. */
function synopsisItem(binding: ArgBinding, facts: UsageFacts): string {
  const optional = isOptional(facts);
  let item: string;
  if (binding.form === "position") {
    item = `<${binding.name}>`;
  } else if (binding.valueType === "boolean") {
    item = `--[no-]${binding.flag}`;
  } else {
    const short = binding.short !== undefined ? `|-${binding.short}` : "";
    item = `--${binding.flag}${short} <${binding.valueType}>`;
  }
  const bracketed = optional ? `[${item}]` : item;
  return binding.repeated ? `${bracketed}...` : bracketed;
}

/** Every command-line argument a root Application accepts, as one line:
 *  `[--also|-a <string>]... [--[no-]shout] [<name>]`. Empty when it declares none. */
export function renderArgumentSynopsis(moduleDoc: unknown): string {
  return readApplicationArguments(moduleDoc)
    .bindings.map((binding) => synopsisItem(binding, factsOf(moduleDoc, binding)))
    .join(" ");
}

/**
 * The answer to `--help`: the synopsis, then every binding with its type,
 * default, environment variable and description, as the application declares
 * them. Normative: `kernel/specs/application-arguments.md` §5.
 */
export function renderApplicationUsage(moduleDoc: unknown): string {
  const metadata = isRecord(moduleDoc) && isRecord(moduleDoc.metadata) ? moduleDoc.metadata : {};
  const appName = typeof metadata.name === "string" ? metadata.name : "application";
  const { bindings } = readApplicationArguments(moduleDoc);
  const synopsis = renderArgumentSynopsis(moduleDoc);
  const lines = [`Usage: ${appName}${synopsis ? ` ${synopsis}` : ""}`];

  const section = (title: string, rows: Array<[string, string]>) => {
    if (rows.length === 0) return;
    const width = Math.max(...rows.map(([left]) => left.length));
    lines.push("", `${title}:`);
    for (const [left, right] of rows) lines.push(`  ${left.padEnd(width)}  ${right}`.trimEnd());
  };
  const describe = (binding: ArgBinding) => describeFacts(binding, factsOf(moduleDoc, binding));

  section(
    "Arguments",
    bindings
      .filter((binding): binding is PositionalArgBinding => binding.form === "position")
      .map((binding) => [`<${binding.name}>${binding.repeated ? "..." : ""}`, describe(binding)]),
  );
  section(
    "Options",
    bindings
      .filter((binding): binding is FlagArgBinding => binding.form === "flag")
      .map((binding) => {
        const short = binding.short !== undefined ? `-${binding.short}, ` : "    ";
        const spelled =
          binding.valueType === "boolean"
            ? `--[no-]${binding.flag}`
            : `--${binding.flag} <${binding.valueType}>${binding.repeated ? "..." : ""}`;
        return [`${short}${spelled}`, describe(binding)];
      }),
  );
  return lines.join("\n") + "\n";
}

function describeFacts(binding: ArgBinding, facts: UsageFacts): string {
  const text = [facts.title, facts.description].find((t) => typeof t === "string") as
    | string
    | undefined;
  const notes: string[] = [];
  if (binding.form === "position") notes.push(binding.valueType);
  if (facts.default !== undefined) notes.push(`default: ${JSON.stringify(facts.default)}`);
  if (typeof facts.env === "string") notes.push(`env: ${facts.env}`);
  const suffix = notes.length > 0 ? `[${notes.join("; ")}]` : "";
  return [text, suffix].filter(Boolean).join(" ");
}
