import http from "node:http";

import Fastify, { type FastifyInstance } from "fastify";

import type { ShareRouting } from "../backend.js";
import { RunnerConfigError, type RunnerCoreConfig } from "../config.js";
import { IdentityVerifier } from "../identity/identity-verifier.js";
import { requireShareSeams } from "../server.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { ShareRelayTimings } from "./relay-tunnel.js";
import { storeShareDirectory } from "./share-directory.js";
import { ShareRelay } from "./share-relay.js";
import { identityTunnelAuthenticator } from "./tunnel-authenticator.js";

export interface RelayServerDeps {
  /** Names the tunnel URL and the base domain visitor hosts sit beneath; absent is refused. */
  shareRouting: ShareRouting | undefined;
  /** `shares.role` must be `relay`. */
  config: RunnerCoreConfig;
  /** The store the control plane writes shares to (Postgres), which also
   *  records every proof `jti`. Owned by the caller, who closes it after the server. */
  store: SessionStore;
  /** Where the relay's own log goes; defaults to stdout. */
  logStream?: NodeJS.WritableStream;
  /** Fetches the issuers' discovery documents and keys; defaults to `fetch`. */
  fetch?: typeof fetch;
  /** Only a test shortens them. */
  timings?: Partial<ShareRelayTimings>;
}

export interface RelayHandle {
  /** Listened on like the control plane's (`app.listen`); closing it closes every tunnel `1001`. */
  app: FastifyInstance;
  relay: ShareRelay;
}

/**
 * The relay (`RUNNER_ROLE=relay`): serves share tunnels at the host of each
 * share's tunnel URL and answers every visitor host beneath the base domain
 * from them. It serves no `/v1` route.
 */
export async function buildRelayServer(deps: RelayServerDeps): Promise<RelayHandle> {
  const { config } = deps;
  if (config.shares.role !== "relay") {
    throw new RunnerConfigError(
      `buildRelayServer serves RUNNER_ROLE=relay, but this runner's role is '${config.shares.role}' — start the control plane with buildServer.`,
    );
  }
  const { routing, shares, identity } = requireShareSeams(config, deps.shareRouting, deps.store);
  let relay: ShareRelay | undefined;
  const app = Fastify({
    logger: { level: config.logLevel, ...(deps.logStream ? { stream: deps.logStream } : {}) },
    forceCloseConnections: true,
    // Every request and upgrade is the relay's; no Fastify route answers here.
    serverFactory: () => {
      // A visitor's upload may take longer than any request timeout: it is shaped, never refused.
      const server = http.createServer({ requestTimeout: 0 }, (req, res) => relay!.handleRequest(req, res));
      server.on("upgrade", (req, socket, head) => relay!.handleUpgrade(req, socket, head));
      return server;
    },
  });
  const verifier = new IdentityVerifier({ config: identity, store: deps.store, log: app.log, fetch: deps.fetch });
  relay = new ShareRelay({
    routing,
    directory: storeShareDirectory(shares, {
      maxConnected: config.shares.maxConnected,
      maxConnectedPerOwner: config.shares.maxConnectedPerOwner,
    }),
    authenticator: identityTunnelAuthenticator(verifier),
    maxConcurrentRequests: config.shares.maxConcurrentRequests,
    maxBytesPerSecond: config.shares.maxBytesPerSecond,
    log: app.log,
    timings: deps.timings,
  });
  const started = relay;
  app.addHook("preClose", () => started.close());
  await app.ready();
  started.start();
  return { app, relay: started };
}
