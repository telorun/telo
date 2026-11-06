import type { InvokeContext, KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isSessions, type Sessions } from "./sessions-controller.js";

export interface OperationResource {
  metadata: { name: string };
  sessions?: Sessions | KindRef<Sessions>;
}

/** An operation resource: its label for messages and the sessions its `sessions`
 *  slot names, resolved per call so creation orders against nothing. */
export class BoundSessionOperation {
  readonly describe: string;

  constructor(
    kind: string,
    private readonly resource: OperationResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `${kind} "${resource.metadata.name}"`;
  }

  get sessions(): Sessions {
    return this.ctx.resolveRef(this.resource.sessions, isSessions, () => `${this.describe}: 'sessions'`, "Session.Sessions");
  }
}

export type { InvokeContext, ResourceInstance };
