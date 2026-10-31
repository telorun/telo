/**
 * What a root Application asks of whoever runs it: its `variables:`, `secrets:`
 * and `ports:`, each entry with the channels that deliver it and the
 * configurations requiring it, and the dimensions those are keyed by. A reader
 * for surfaces that describe an application before running it — a registry
 * listing, a launcher form — so they learn the inputs from the manifest and
 * never from a second declaration.
 *
 * Requiredness is a verdict over the analysed graph, so the contract is built
 * from the declaration AND the application's requirements (`inputRequirements`
 * with `requirementDimensions`): an entry is `required` when some configuration
 * requires it, and carries `requiredWhen` when not every one does.
 *
 * A secret's value never leaves this reader: no `default`, `examples`, `const`
 * or `enum` of a secret is reported, only whether one is required and its type.
 *
 * Browser-safe. Command-line bindings are read through `readApplicationArguments`,
 * so a malformed binding is reported here as none, exactly as the runtime reads it.
 */

import { readApplicationArguments, type ArgBinding } from "./application-arguments.js";
import type { Assignment } from "./configuration-dimensions.js";
import {
  reportedDimensions,
  type InputRequirement,
  type ReportedDimension,
  type RequirementDimension,
} from "./input-requirements.js";

export type ApplicationContractArg =
  | { form: "flag"; flag: string; short: string }
  | { form: "position"; position: number };

interface ApplicationContractInput {
  name: string;
  /** `''` when the entry declares none. */
  description: string;
  /** True when some configuration of the application requires the entry. */
  required: boolean;
  /** The configurations requiring it, as partial assignments keyed by
   *  dimension (`[{ "secrets.openaiApiKey": "absent" }]`); present only when it
   *  is required and not in every configuration. */
  requiredWhen?: Assignment[];
  /** The environment variable bound by `env:`; `''` when unbound. */
  env: string;
}

export interface ApplicationContractVariable extends ApplicationContractInput {
  /** The declared `default:` — present exactly when the entry declares one. */
  default?: unknown;
  arg: ApplicationContractArg | null;
  /** Every keyword the entry declares other than `description`, `default`,
   *  `env` and `arg`. */
  schema: Record<string, unknown>;
}

export interface ApplicationContractSecret extends ApplicationContractInput {
  /** `type` and `x-telo-type` only. */
  schema: { type?: unknown; "x-telo-type"?: unknown };
}

export interface ApplicationContractPort extends ApplicationContractInput {
  /** The declared `default:` — present exactly when the entry declares one. */
  default?: unknown;
  arg: ApplicationContractArg | null;
  protocol: "tcp" | "udp";
}

export interface ApplicationContract {
  /** Each list in declaration order. */
  variables: ApplicationContractVariable[];
  secrets: ApplicationContractSecret[];
  ports: ApplicationContractPort[];
  /** The dimensions a `requiredWhen` is keyed by, each with its values and the
   *  environment variables its value is read from. */
  dimensions: ReportedDimension[];
}

/** What the contract's requiredness is read from: the application's
 *  requirements and the dimensions they are decided over. */
export interface ContractRequirements {
  readonly inputs: readonly InputRequirement[];
  readonly dimensions: readonly RequirementDimension[];
}

const BINDING_KEYS: ReadonlySet<string> = new Set(["description", "default", "env", "arg"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entriesOf(moduleDoc: Record<string, unknown>, block: string): Array<[string, Record<string, unknown>]> {
  const entries = moduleDoc[block];
  if (!isRecord(entries)) return [];
  return Object.entries(entries).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

function inputOf(
  block: "variables" | "secrets" | "ports",
  name: string,
  entry: Record<string, unknown>,
  requirements: ContractRequirements,
): ApplicationContractInput {
  const requirement = requirements.inputs.find((input) => input.block === block && input.name === name);
  return {
    name,
    description: typeof entry.description === "string" ? entry.description : "",
    required: requirement?.required ?? false,
    ...(requirement?.requiredWhen ? { requiredWhen: [...requirement.requiredWhen] } : {}),
    env: typeof entry.env === "string" ? entry.env : "",
  };
}

function declaredDefault(entry: Record<string, unknown>): { default?: unknown } {
  return Object.hasOwn(entry, "default") ? { default: entry.default } : {};
}

function argOf(binding: ArgBinding | undefined): ApplicationContractArg | null {
  if (!binding) return null;
  return binding.form === "flag"
    ? { form: "flag", flag: binding.flag, short: binding.short ?? "" }
    : { form: "position", position: binding.position };
}

/** The declared inputs of a root `Telo.Application` with the configurations
 *  requiring each, or `null` for any other document. */
export function readApplicationContract(
  moduleDoc: unknown,
  requirements: ContractRequirements,
): ApplicationContract | null {
  if (!isRecord(moduleDoc) || moduleDoc.kind !== "Telo.Application") return null;
  const { bindings } = readApplicationArguments(moduleDoc);
  const bindingOf = (block: "variables" | "ports", name: string) =>
    bindings.find((binding) => binding.block === block && binding.name === name);

  return {
    variables: entriesOf(moduleDoc, "variables").map(([name, entry]) => ({
      ...inputOf("variables", name, entry, requirements),
      ...declaredDefault(entry),
      arg: argOf(bindingOf("variables", name)),
      schema: Object.fromEntries(Object.entries(entry).filter(([key]) => !BINDING_KEYS.has(key))),
    })),
    secrets: entriesOf(moduleDoc, "secrets").map(([name, entry]) => ({
      ...inputOf("secrets", name, entry, requirements),
      schema: {
        ...(entry.type !== undefined ? { type: entry.type } : {}),
        ...(entry["x-telo-type"] !== undefined ? { "x-telo-type": entry["x-telo-type"] } : {}),
      },
    })),
    ports: entriesOf(moduleDoc, "ports").map(([name, entry]) => ({
      ...inputOf("ports", name, entry, requirements),
      ...declaredDefault(entry),
      arg: argOf(bindingOf("ports", name)),
      protocol: entry.protocol === "udp" ? "udp" : "tcp",
    })),
    dimensions: reportedDimensions(requirements.dimensions),
  };
}
