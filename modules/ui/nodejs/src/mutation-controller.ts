import { RuntimeError, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import type { AddressSpec } from "./address-expansion.js";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import { modelSchema, type JsonSchema } from "./model-schema.js";
import { queryId } from "./query-controller.js";

type RequestMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/** One write as a renderer receives it, every member but `answer` present. */
export interface MutationSpec {
  /** The declaration's identity: every call of it shares one `concurrency` queue. */
  id: string;
  schema: JsonSchema;
  /** What a success's body is held to, present when declared. */
  answer?: JsonSchema;
  method: RequestMethod;
  url: AddressSpec;
  /** The input properties the url reads whole, which the body leaves out. */
  consumed: string[];
  invalidates: AddressSpec[];
  concurrency: "parallel" | "serial";
}

export interface MutationInstance {
  provide(): Promise<MutationSpec>;
  /** The same spec, known once the mutation is created. */
  spec(): MutationSpec;
}

export function isMutation(candidate: unknown): candidate is MutationInstance {
  return typeof (candidate as Partial<MutationInstance> | null)?.spec === "function";
}

type MutationResource = RuntimeResource & {
  inputModel: unknown;
  outputModel?: unknown;
  method?: RequestMethod | null;
  url: AddressConfig;
  invalidates?: AddressConfig[] | null;
  concurrency?: "parallel" | "serial" | null;
};

/** The input properties a target's parameters read whole (`input.<property>`),
 *  in the input model's order. */
export function consumedProperties(target: AddressSpec, properties: string[]): string[] {
  const reads = new Set<string>();
  for (const binding of [...Object.values(target.pathParams), ...Object.values(target.queryParams)]) {
    const chain = binding as { root?: unknown; path?: unknown };
    if (chain.root === "input" && Array.isArray(chain.path) && chain.path.length === 1) reads.add(String(chain.path[0]));
  }
  return properties.filter((property) => reads.has(property));
}

/** A write declared once and run by any number of calls. */
class Mutation implements ResourceInstance, MutationInstance {
  private readonly writing: MutationSpec;

  constructor(resource: MutationResource, ctx: ResourceContext) {
    const owner = `Ui.Mutation '${resource.metadata.name}'`;
    const schema = modelSchema(resource.inputModel, ctx, owner, "inputModel");
    const method = resource.method ?? "POST";
    const url = addressSpec(resource.url, ctx, `${owner} url`);
    const consumed = consumedProperties(url, Object.keys((schema.properties ?? {}) as Record<string, unknown>));
    if (method === "DELETE") {
      const unsent = Object.keys((schema.properties ?? {}) as Record<string, unknown>).filter((property) => !consumed.includes(property));
      if (unsent.length > 0) {
        throw new RuntimeError(
          "ERR_UI_MUTATION_INPUT_UNSENT",
          `${owner}: a 'DELETE' sends no body, yet its url does not read ${unsent.map((property) => `'${property}'`).join(", ")} of 'inputModel'. Read each in a 'pathParams' or 'queryParams' entry as exactly 'input.<property>', or remove it from 'inputModel'.`,
        );
      }
    }
    const answer = resource.outputModel == null ? undefined : modelSchema(resource.outputModel, ctx, owner, "outputModel");
    this.writing = {
      id: queryId(resource.metadata as Parameters<typeof queryId>[0]),
      schema,
      ...(answer ? { answer } : {}),
      method,
      url,
      consumed,
      invalidates: (resource.invalidates ?? []).map((target, index) => addressSpec(target, ctx, `${owner} invalidates[${index}]`)),
      concurrency: resource.concurrency ?? "parallel",
    };
  }

  spec(): MutationSpec {
    return this.writing;
  }

  async provide(): Promise<MutationSpec> {
    return this.writing;
  }
}

export async function create(resource: MutationResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Mutation(resource, ctx);
}
