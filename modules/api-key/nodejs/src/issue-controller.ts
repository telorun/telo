import type { CelTimestamp, InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { mintKey } from "./key-format.js";
import { BoundKeyOperation, issuedRecord, optionalTimestamp, type OperationResource } from "./key-operation.js";
import { storeInconsistent } from "./store-failure.js";
import type { KeyOwner } from "./store-contract.js";

interface IssueInputs {
  owner: KeyOwner;
  scopes: string[];
  label?: string | null;
  expiresAt?: CelTimestamp | null;
}

/** ApiKey.Issue — mint a key for an owner and store its digest; the key is returned once. */
class Issue implements ResourceInstance<IssueInputs, Record<string, unknown>> {
  constructor(private readonly bound: BoundKeyOperation) {}

  async invoke(inputs: IssueInputs, invokeCtx?: InvokeContext): Promise<Record<string, unknown>> {
    const store = this.bound.store;
    const settings = store.settings();
    const expiresAt = optionalTimestamp(inputs.expiresAt, this.bound.describe, "expiresAt");
    this.bound.checkScopes(inputs.scopes, settings);
    this.bound.checkLifetime(expiresAt, settings, Date.now());

    const minted = mintKey(settings.prefix);
    const outcome = await this.bound.call(() =>
      store.issue(
        {
          id: minted.uuid,
          digest: minted.digest,
          owner: { type: inputs.owner.type, id: inputs.owner.id },
          scopes: [...inputs.scopes],
          label: inputs.label ?? null,
          expiresAt,
        },
        invokeCtx,
      ),
    );
    if (outcome.outcome !== "issued") {
      throw storeInconsistent(this.bound.describe, `${JSON.stringify(outcome)} for an issue`);
    }
    return { key: minted.key, ...issuedRecord(outcome.key) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Issue> {
  return new Issue(new BoundKeyOperation("ApiKey.Issue", resource, ctx));
}

export function register(): void {}
