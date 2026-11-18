import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { ShareRouting } from "../backend.js";
import type { CreateShareRequest, Share, ShareList } from "../contract.js";
import type { CallerResolver } from "../session/session-credentials.js";
import { shareConnected, shareLastActiveAt, type ShareRecord, type ShareStore } from "../session-store/share-store.js";
import { identityOwner } from "./caller-gate.js";

export interface SharesRouteDeps {
  store: ShareStore;
  routing: ShareRouting;
  resolveCaller: CallerResolver;
  authChallenge?: string;
  /** `RUNNER_MAX_SHARES_PER_OWNER`. */
  maxPerOwner: number;
  now?: () => Date;
}

const createBodySchema = {
  type: "object",
  required: ["name", "application"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 512 },
    application: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

/** The control plane's `/v1/shares`: get-or-create, list and delete a caller's
 *  shares. Connection state is the relay's; these routes only read it. */
export function sharesRoute(deps: SharesRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  return async (app: FastifyInstance) => {
    app.post<{ Body: CreateShareRequest }>(
      "/v1/shares",
      { schema: { body: createBodySchema } },
      async (req, reply) => {
        const owner = await identityOwner(deps, req, reply, "a share");
        if (!owner) return;
        const outcome = await deps.store.createShare({
          owner,
          name: req.body.name,
          application: req.body.application,
          now: now(),
          maxPerOwner: deps.maxPerOwner,
        });
        if (outcome.kind === "limit") {
          reply.code(429).send({
            error: "too_many_shares",
            message: `this runner keeps at most ${deps.maxPerOwner} shares per owner; delete one with telo shares delete <id>`,
          });
          return;
        }
        reply.code(outcome.kind === "created" ? 201 : 200).send(shareDocument(deps.routing, outcome.share));
      },
    );

    app.get("/v1/shares", async (req, reply) => {
      const owner = await identityOwner(deps, req, reply, "a share list");
      if (!owner) return;
      const at = now();
      const shares = await deps.store.listShares(owner);
      const list: ShareList = {
        shares: shares
          .map((share) => ({ share, lastActiveAt: shareLastActiveAt(share, at) }))
          .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime() || a.share.id.localeCompare(b.share.id))
          .map(({ share, lastActiveAt }) => ({
            id: share.id,
            name: share.name,
            application: share.application,
            connected: shareConnected(share, at),
            lastActiveAt: lastActiveAt.toISOString(),
          })),
      };
      reply.send(list);
    });

    app.delete<{ Params: { id: string } }>("/v1/shares/:id", async (req, reply) => {
      const owner = await identityOwner(deps, req, reply, "deleting a share");
      if (!owner) return;
      const deleted = await deps.store.deleteShare(req.params.id, owner, now());
      if (!deleted) {
        reply.code(404).send({ error: "share_not_found", message: `no share ${req.params.id}` });
        return;
      }
      reply.code(204).send();
    });
  };
}

function shareDocument(routing: ShareRouting, share: ShareRecord): Share {
  const addresses = routing.addresses(share.id);
  return {
    id: share.id,
    name: share.name,
    application: share.application,
    publicUrlTemplate: addresses.publicUrlTemplate,
    publicUrlSecondaryTemplate: addresses.publicUrlSecondaryTemplate,
    tunnelUrl: addresses.tunnelUrl,
  };
}
