/**
 * What a root Application asks of whoever runs it: its `variables:`, `secrets:`
 * and `ports:`, each entry with the channels that deliver it. A reader for
 * surfaces that describe an application before running it — a registry listing,
 * a launcher form — so they learn the inputs from the manifest and never from a
 * second declaration.
 *
 * A secret's value never leaves this reader: no `default`, `examples`, `const`
 * or `enum` of a secret is reported, only whether one is required and its type.
 *
 * Browser-safe. Command-line bindings are read through `readApplicationArguments`,
 * so a malformed binding is reported here as none, exactly as the runtime reads it.
 */

import { readApplicationArguments, type ArgBinding } from "./application-arguments.js";

export type ApplicationContractArg =
  | { form: "flag"; flag: string; short: string }
  | { form: "position"; position: number };

interface ApplicationContractInput {
  name: string;
  /** `''` when the entry declares none. */
  description: string;
  /** True when the entry declares no `default:`. */
  required: boolean;
  /** The environment variable bound by `env:`; `''` when unbound. */
  env: string;
}

export interface ApplicationContractVariable extends ApplicationContractInput {
  /** `null` when required. */
  default: unknown;
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
  /** `null` when required. */
  default: unknown;
  arg: ApplicationContractArg | null;
  protocol: "tcp" | "udp";
}

export interface ApplicationContract {
  /** Each list in declaration order. */
  variables: ApplicationContractVariable[];
  secrets: ApplicationContractSecret[];
  ports: ApplicationContractPort[];
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

function inputOf(name: string, entry: Record<string, unknown>): ApplicationContractInput {
  return {
    name,
    description: typeof entry.description === "string" ? entry.description : "",
    required: entry.default === undefined,
    env: typeof entry.env === "string" ? entry.env : "",
  };
}

function argOf(binding: ArgBinding | undefined): ApplicationContractArg | null {
  if (!binding) return null;
  return binding.form === "flag"
    ? { form: "flag", flag: binding.flag, short: binding.short ?? "" }
    : { form: "position", position: binding.position };
}

/** The declared inputs of a root `Telo.Application`, or `null` for any other
 *  document. */
export function readApplicationContract(moduleDoc: unknown): ApplicationContract | null {
  if (!isRecord(moduleDoc) || moduleDoc.kind !== "Telo.Application") return null;
  const { bindings } = readApplicationArguments(moduleDoc);
  const bindingOf = (block: "variables" | "ports", name: string) =>
    bindings.find((binding) => binding.block === block && binding.name === name);

  return {
    variables: entriesOf(moduleDoc, "variables").map(([name, entry]) => ({
      ...inputOf(name, entry),
      default: entry.default ?? null,
      arg: argOf(bindingOf("variables", name)),
      schema: Object.fromEntries(Object.entries(entry).filter(([key]) => !BINDING_KEYS.has(key))),
    })),
    secrets: entriesOf(moduleDoc, "secrets").map(([name, entry]) => ({
      ...inputOf(name, entry),
      schema: {
        ...(entry.type !== undefined ? { type: entry.type } : {}),
        ...(entry["x-telo-type"] !== undefined ? { "x-telo-type": entry["x-telo-type"] } : {}),
      },
    })),
    ports: entriesOf(moduleDoc, "ports").map(([name, entry]) => ({
      ...inputOf(name, entry),
      default: entry.default ?? null,
      arg: argOf(bindingOf("ports", name)),
      protocol: entry.protocol === "udp" ? "udp" : "tcp",
    })),
  };
}
