import type { KindRef, ResourceContext } from "@telorun/sdk";
import { isCodeSet, isLinkSet, isTokenSet, type CodeSet, type LinkSet, type TokenSet } from "./token-set.js";

export interface OperationResource {
  metadata: { name: string };
  tokens?: unknown | KindRef<unknown>;
}

/** An operation resource and the token set its `tokens` slot names, resolved per call so creation orders against nothing. */
export class BoundOperation {
  readonly describe: string;

  constructor(
    kind: string,
    private readonly resource: OperationResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `${kind} "${resource.metadata.name}"`;
  }

  get tokens(): TokenSet {
    return this.ctx.resolveRef(this.resource.tokens, isTokenSet, () => `${this.describe}: 'tokens'`, "OneTime.Tokens");
  }

  get links(): LinkSet {
    return this.ctx.resolveRef(this.resource.tokens, isLinkSet, () => `${this.describe}: 'tokens'`, "OneTime.Links");
  }

  get codes(): CodeSet {
    return this.ctx.resolveRef(this.resource.tokens, isCodeSet, () => `${this.describe}: 'tokens'`, "OneTime.Codes");
  }
}
