import {
  appendEnvFileLines,
  readApplicationContract,
  requirementSentence,
  sensitiveEnvironmentInputs,
  spellEnvFileValue,
  type Assignment,
  type ContractRequirements,
  type NeedEnvironmentEntry,
} from "@telorun/analyzer";
import type { NeedsReport } from "./needs-report.js";

/**
 * The environment template of an application: one line per environment
 * variable it reads — its `variables:` / `secrets:` / `ports:` entries bound by
 * `env:`, and every need field the need table reads — grouped by where it comes
 * from and split between the two kinds of file a run collects: every SENSITIVE
 * input (a secret, a need field the table marks sensitive — the analyzer's
 * `sensitiveEnvironmentInputs`) goes to the workspace's sensitive file, the rest
 * to the one that may be committed. Which files those are is `env.files`'s
 * answer (`envFileDestination`), `.env.local` and `.env` by default.
 *
 * **Every line is written commented out.** An empty assignment is a value — the
 * kernel reads `NAME=` as the empty string, which satisfies a required string —
 * and an uncommented default would freeze today's default against a later edit
 * of the manifest, since a variable that is set wins over `default:`. So the
 * template changes nothing about a run until a line is uncommented, and a value
 * shown is the default the application uses while the variable is unset. A
 * secret's default is never written.
 *
 * A line carries only what it does not already show, as a trailing comment the
 * `.env` reader drops once the line is uncommented: `required` or `required
 * when <sentence>` — the configurations of the application that require it, the
 * sentence `--help` prints — the entry's description, and a need field's path,
 * the one name a variable does not spell.
 */

const GROUPS = ["variables", "ports", "secrets", "needs"] as const;
type EnvTemplateGroup = (typeof GROUPS)[number];

export interface EnvTemplateEntry {
  name: string;
  /** It belongs in a sensitive file. */
  sensitive: boolean;
  group: EnvTemplateGroup;
  /** The text after `=`, already spelled for an env file; `''` for none. */
  value: string;
  /** The trailing comment; `''` for none. */
  note: string;
}

export function envTemplateEntries(
  root: unknown,
  report: NeedsReport,
  needEnvironment: readonly NeedEnvironmentEntry[],
  requirements: ContractRequirements,
): EnvTemplateEntry[] {
  const contract = readApplicationContract(root, requirements);
  if (!contract) return [];
  const requirement = (input: { required: boolean; requiredWhen?: Assignment[] }) =>
    !input.required
      ? ""
      : input.requiredWhen
        ? `required when ${requirementSentence(input.requiredWhen, requirements.dimensions)}`
        : "required";
  const sensitive = new Set(sensitiveEnvironmentInputs(root, needEnvironment).map((input) => input.env));
  const entries: EnvTemplateEntry[] = [];
  const note = (...parts: string[]) =>
    parts
      .map((part) => part.trim().replace(/\s*\n\s*/g, " "))
      .filter(Boolean)
      .join(" — ");

  for (const [group, inputs] of [
    ["variables", contract.variables],
    ["ports", contract.ports],
  ] as const) {
    for (const input of inputs) {
      if (!input.env) continue;
      const spelled = "default" in input ? spellEnvFileValue(defaultText(input.default)) : { spelling: "" };
      entries.push({
        name: input.env,
        sensitive: sensitive.has(input.env),
        group,
        value: "spelling" in spelled ? spelled.spelling : "",
        note: note(
          requirement(input),
          "refused" in spelled ? "default not representable in a .env file" : "",
          input.description,
        ),
      });
    }
  }
  for (const secret of contract.secrets) {
    if (!secret.env) continue;
    entries.push({
      name: secret.env,
      sensitive: sensitive.has(secret.env),
      group: "secrets",
      value: "",
      note: note(requirement(secret), secret.description),
    });
  }
  for (const need of report.needs) {
    for (const [field, info] of Object.entries(need.fields)) {
      entries.push({
        name: info.env,
        sensitive: sensitive.has(info.env),
        group: "needs",
        value: "",
        note: note(!need.optional && info.required ? requirement(need) : "", `${need.path}.${field}`),
      });
    }
  }
  return entries;
}

function defaultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The commented lines of `entries`, trailing comments aligned among them. */
function renderLines(entries: readonly EnvTemplateEntry[]): string[] {
  const assignments = entries.map((entry) => `# ${entry.name}=${entry.value}`);
  const width = Math.max(
    0,
    ...entries.flatMap((entry, index) => (entry.note ? [assignments[index].length] : [])),
  );
  return assignments.map((line, index) =>
    entries[index].note ? `${line.padEnd(width)}  # ${entries[index].note}` : line,
  );
}

/** The file for the sensitive entries, or for the rest. */
export function renderEnvFile(appName: string, sensitive: boolean, entries: readonly EnvTemplateEntry[]): string {
  const header = sensitive
    ? `# ${appName} secrets — written by \`telo env template\`; keep this file out of version control.`
    : `# ${appName} — written by \`telo env template\`. Uncomment a line to set it; a value shown is the default.`;
  const own = entries.filter((entry) => entry.sensitive === sensitive);
  const sections = GROUPS.map((group) => own.filter((entry) => entry.group === group))
    .filter((members) => members.length > 0)
    .map((members) => [`# ${members[0].group}`, ...renderLines(members)].join("\n"));
  return `${[header, ...sections].join("\n\n")}\n`;
}

/** The entries `existing` does not mention — neither set nor commented out. */
export function entriesMissingFrom(existing: string, entries: readonly EnvTemplateEntry[]): EnvTemplateEntry[] {
  const mentioned = new Set<string>();
  for (const line of existing.split(/\r?\n/)) {
    const match = /^\s*(?:#\s*)?(?:export\s+)?([\w.-]+)\s*=/.exec(line);
    if (match) mentioned.add(match[1]);
  }
  return entries.filter((entry) => !mentioned.has(entry.name));
}

/** `existing` with `missing` appended as one block of commented lines, set off
 *  by a blank line. */
export function appendEntries(existing: string, missing: readonly EnvTemplateEntry[]): string {
  return appendEnvFileLines(existing, ["", ...renderLines(missing)]);
}
