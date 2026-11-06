import type { RequestTrace } from "@telorun/http-dispatch";
import {
  deriveContext,
  isCancellationError,
  isInvokeError,
  isSuspension,
  toPlainJson,
  type ResourceContext,
  type ResourceInstance,
  type TextRecord,
} from "@telorun/sdk";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  accessRefusal,
  accessRefusalOf,
  distinctChallenges,
  ERR_HTTP_ACCESS_CHECK_UNAVAILABLE,
  ERR_HTTP_CROSS_ORIGIN_REFUSED,
  ERR_HTTP_FORBIDDEN,
  ERR_HTTP_UNAUTHENTICATED,
  type Challenge,
} from "./access-refusal.js";
import { ERR_HTTP_CREDENTIAL_MALFORMED, type CredentialRequest } from "./credential-source.js";
import { metadataPath, type ProtectedResourceReadings } from "./protected-resource.js";

/** A resource the seam dispatches: its identity for the trace, and the live instance. */
export interface Dispatched {
  readonly kind: string;
  readonly name: string;
  readonly instance: ResourceInstance;
  /** Where the slot holding it is written, for the trace (`/mounts/0/authentication/verifiers/0/from`). */
  readonly calledAt: string;
}

export interface AccessEntry {
  readonly verifier: Dispatched;
  readonly from: Dispatched;
}

export interface AuthenticationSetting {
  readonly verifiers?: readonly AccessEntry[];
  readonly anonymous?: "allow" | "deny";
}

export interface AuthorizationSetting {
  readonly policy: Dispatched;
  /** `action` and `resource`, evaluated over the request with its principal. */
  evaluate(request: FastifyRequest, principal: Readonly<Record<string, unknown>> | null): {
    action: unknown;
    resource: unknown;
  };
}

/**
 * What a mount sets on a route's Fastify `config` under {@link ROUTE_ACCESS}: the
 * route's own settings, each replacing the mount's, and the rungs of its catch
 * ladder below the server's.
 */
export interface RouteAccess {
  readonly authentication?: AuthenticationSetting;
  readonly authorization?: AuthorizationSetting;
  /** Renders `error` through the route's and the router's catch lists; false when none claims it. */
  render(error: Error, request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
}

export const ROUTE_ACCESS = "teloAccess";

/** A source's or a verifier's published reading, as the seam reads it. */
interface SourceReading {
  schemes?: unknown;
  originCheck?: { trustedOrigins?: unknown };
  bearerMethod?: unknown;
  requiresTrustedProxy?: unknown;
}

const readings = new WeakMap<ResourceInstance, Promise<Record<string, unknown>>>();

/** An instance's published reading, read once. */
export function readingOf(instance: ResourceInstance): Promise<Record<string, unknown>> {
  let reading = readings.get(instance);
  if (!reading) {
    const pending: Promise<Record<string, unknown>> = Promise.resolve(instance.snapshot?.() ?? {}).then(
      (value) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
      (error) => {
        // A rejection is not cached: the next request reads again.
        if (readings.get(instance) === pending) readings.delete(instance);
        throw error;
      },
    );
    reading = pending;
    readings.set(instance, reading);
  }
  return reading;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function challengeList(value: unknown): Challenge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry && typeof entry === "object" && typeof (entry as Challenge).scheme === "string"
      ? [{ scheme: (entry as Challenge).scheme, parameters: { ...((entry as Challenge).parameters ?? {}) } }]
      : [],
  );
}

/** An `HttpMount`'s access settings and what the seam needs of its server. */
export interface MountAccessOptions {
  readonly ctx: ResourceContext;
  readonly label: string;
  readonly authentication?: AuthenticationSetting;
  readonly authorization?: AuthorizationSetting;
  /** The mount's prefix, `""` at the root. */
  readonly path: string;
  /** The origin of the mount's public address, when its `hostnames` name one. */
  readonly publicOrigin?: string;
  /** Whether the mount publishes protected-resource metadata, which every 401 then names. */
  readonly protectedResource?: boolean;
  readonly trace: (request: FastifyRequest) => RequestTrace & { principal: Readonly<Record<string, unknown>> | null };
  readonly credentialRequest: (request: FastifyRequest) => CredentialRequest;
  readonly declaredDisplayMessage: (code: string, data?: unknown) => TextRecord | undefined;
}

interface Authenticated {
  readonly principal: Readonly<Record<string, unknown>> | null;
  readonly entry?: AccessEntry;
  readonly presentation?: Readonly<Record<string, unknown>>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The `onRequest` hook a mount's routes run first: authentication, then the
 * origin check for a credential the browser sends on its own, then
 * authorization. A refusal is rendered by the route's catch lists, then the
 * server's, then answered by default.
 */
export function mountAccessHook(options: MountAccessOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const route = (request.routeOptions.config as unknown as Record<string, unknown> | undefined)?.[ROUTE_ACCESS] as
      | RouteAccess
      | undefined;
    const mountAuthentication = options.authentication;
    const routeAuthentication = route?.authentication;
    const authorization = route?.authorization ?? options.authorization;
    if (!mountAuthentication && !routeAuthentication && !authorization) return;
    const trace = options.trace(request);
    try {
      const authenticated = await authenticate(options, request, trace, {
        verifiers: routeAuthentication?.verifiers ?? mountAuthentication?.verifiers ?? [],
        anonymous: routeAuthentication?.anonymous ?? mountAuthentication?.anonymous ?? (mountAuthentication || routeAuthentication ? "deny" : "allow"),
      });
      trace.principal = authenticated.principal;
      if (authenticated.entry) await checkOrigin(options, request, authenticated.entry);
      if (authorization) await authorize(options, request, trace, authorization, authenticated);
    } catch (error) {
      if (!isInvokeError(error)) throw error;
      const challenge = accessRefusalOf(error)?.wwwAuthenticate;
      if (challenge) reply.header("WWW-Authenticate", challenge);
      trace.reject(error);
      if (route && (await route.render(error, request, reply))) return reply;
      throw error;
    }
  };
}

async function authenticate(
  options: MountAccessOptions,
  request: FastifyRequest,
  trace: RequestTrace,
  setting: { verifiers: readonly AccessEntry[]; anonymous: "allow" | "deny" },
): Promise<Authenticated> {
  const view = options.credentialRequest(request);
  const challenges = async (refused?: { index: number; challenge: Challenge | null }) => {
    const all: Challenge[] = [];
    for (const [index, entry] of setting.verifiers.entries()) {
      const schemes = stringList(((await readingOf(entry.from.instance)) as SourceReading).schemes);
      const published = challengeList((await readingOf(entry.verifier.instance)).challenges);
      for (const scheme of schemes) {
        const own = refused?.index === index ? refused.challenge : null;
        const match = (challenge: Challenge | null | undefined) =>
          challenge && challenge.scheme.toLowerCase() === scheme.toLowerCase() ? challenge : undefined;
        all.push(match(own) ?? published.find((c) => match(c)) ?? { scheme, parameters: {} });
      }
      const own = refused?.index === index ? refused.challenge : null;
      if (own && !schemes.some((scheme) => scheme.toLowerCase() === own.scheme.toLowerCase())) all.push(own);
    }
    return mountChallenges(options, request, distinctChallenges(all));
  };
  const unauthenticated = async (
    reason: "absent" | "malformed" | "refused",
    message: string,
    refused?: { index: number; challenge: Challenge | null },
  ) => {
    const data = { reason };
    return accessRefusal(ERR_HTTP_UNAUTHENTICATED, `${options.label}: ${message}`, {
      data,
      displayMessage: options.declaredDisplayMessage(ERR_HTTP_UNAUTHENTICATED, data),
      challenges: await challenges(refused),
    });
  };

  let confirmation: Record<string, unknown> | undefined;
  for (const [index, entry] of setting.verifiers.entries()) {
    let presentation: unknown;
    try {
      presentation = await dispatch(options, trace, entry.from, view);
    } catch (error) {
      if (isInvokeError(error) && error.code === ERR_HTTP_CREDENTIAL_MALFORMED) {
        throw await unauthenticated("malformed", error.message);
      }
      throw unavailable(options, "source", entry.from, error);
    }
    if (presentation === null || presentation === undefined) continue;
    confirmation ??= confirmationOf(request, view);
    let output: Record<string, unknown>;
    try {
      output = (await dispatch(options, trace, entry.verifier, {
        presentation,
        confirmation,
        resource: resourceOf(options, request),
      })) as Record<string, unknown>;
    } catch (error) {
      throw unavailable(options, "verifier", entry.verifier, error);
    }
    if (output && output.principal && typeof output.principal === "object") {
      return {
        principal: output.principal as Record<string, unknown>,
        entry,
        presentation: presentation as Record<string, unknown>,
      };
    }
    const refusedChallenge = challengeList(output?.challenge ? [output.challenge] : [])[0] ?? null;
    throw await unauthenticated(
      "refused",
      `'${entry.verifier.name}' refused the credential: ${String(output?.reason ?? "no reason given")}`,
      { index, challenge: refusedChallenge },
    );
  }
  if (setting.anonymous === "allow") return { principal: null };
  throw await unauthenticated("absent", "the request presents no credential, and anonymous callers are denied");
}

/** Every challenge of a mount's 401 and 403 passes through here. */
function mountChallenges(options: MountAccessOptions, request: FastifyRequest, challenges: Challenge[]): Challenge[] {
  if (!options.protectedResource) return challenges;
  const resource_metadata = `${mountOrigin(options, request)}${metadataPath(options.path)}`;
  return challenges.map((challenge) => ({
    scheme: challenge.scheme,
    parameters: { ...challenge.parameters, resource_metadata },
  }));
}

/** The issuers the mount's verifiers declare and the RFC 6750 methods its sources read, as they publish them. */
export async function protectedResourceReadings(entries: readonly AccessEntry[]): Promise<ProtectedResourceReadings> {
  const issuers: string[] = [];
  const bearerMethods: string[] = [];
  for (const entry of entries) {
    // A verifier publishes `issuer` as configured: text, or the `Telo.Url` it was typed from.
    const issuer = toPlainJson((await readingOf(entry.verifier.instance)).issuer);
    if (typeof issuer === "string") issuers.push(issuer);
    const method = ((await readingOf(entry.from.instance)) as SourceReading).bearerMethod;
    if (typeof method === "string") bearerMethods.push(method);
  }
  return { issuers, bearerMethods };
}

async function checkOrigin(options: MountAccessOptions, request: FastifyRequest, entry: AccessEntry): Promise<void> {
  const originCheck = ((await readingOf(entry.from.instance)) as SourceReading).originCheck;
  if (!originCheck) return;
  const upgrade = request.headers.upgrade !== undefined;
  if (SAFE_METHODS.has(request.method) && !upgrade) return;
  const site = singleHeader(request.headers["sec-fetch-site"]);
  if (site === "same-origin" || site === "none") return;
  const origin = singleHeader(request.headers.origin);
  if (origin !== undefined) {
    if (origin === mountOrigin(options, request)) return;
    if (stringList(originCheck.trustedOrigins).includes(origin)) return;
  }
  throw accessRefusal(
    ERR_HTTP_CROSS_ORIGIN_REFUSED,
    `${options.label}: a ${request.method} request authenticated by a cookie came from ` +
      `${origin === undefined ? "an undisclosed origin" : `'${origin}'`}, which is neither this site nor a trusted origin`,
    { displayMessage: options.declaredDisplayMessage(ERR_HTTP_CROSS_ORIGIN_REFUSED) },
  );
}

async function authorize(
  options: MountAccessOptions,
  request: FastifyRequest,
  trace: RequestTrace,
  authorization: AuthorizationSetting,
  authenticated: Authenticated,
): Promise<void> {
  const { action, resource } = authorization.evaluate(request, authenticated.principal);
  let decision: Record<string, unknown>;
  try {
    decision = (await dispatch(options, trace, authorization.policy, {
      principal: authenticated.principal,
      action,
      resource: resource ?? null,
      context: { method: request.method, path: request.url, host: request.host, ip: request.ip },
    })) as Record<string, unknown>;
  } catch (error) {
    throw unavailable(options, "policy", authorization.policy, error);
  }
  if (decision?.allow === true) return;
  const requiredScopes = stringList(decision?.requiredScopes);
  const data = requiredScopes.length > 0 ? { requiredScopes } : {};
  const scheme = authenticated.entry ? await presentedScheme(authenticated) : undefined;
  throw accessRefusal(
    ERR_HTTP_FORBIDDEN,
    `${options.label}: '${authorization.policy.name}' denied '${String(action)}'` +
      (typeof decision?.reason === "string" ? `: ${decision.reason}` : ""),
    {
      data,
      displayMessage: options.declaredDisplayMessage(ERR_HTTP_FORBIDDEN, data),
      ...(scheme && requiredScopes.length > 0
        ? {
            challenges: mountChallenges(options, request, [
              { scheme, parameters: { error: "insufficient_scope", scope: requiredScopes.join(" ") } },
            ]),
          }
        : {}),
    },
  );
}

async function presentedScheme(authenticated: Authenticated): Promise<string | undefined> {
  const scheme = authenticated.presentation?.scheme;
  if (typeof scheme === "string") return scheme;
  return stringList(((await readingOf(authenticated.entry!.from.instance)) as SourceReading).schemes)[0];
}

function unavailable(
  options: MountAccessOptions,
  stage: "source" | "verifier" | "policy",
  dispatched: Dispatched,
  error: unknown,
): unknown {
  // A cancellation, a suspension and an uncoded failure are not an answer.
  if (isCancellationError(error) || isSuspension(error) || !isInvokeError(error)) return error;
  options.ctx.log.warn(
    "Access check unavailable",
    {
      "httpserver.access.stage": stage,
      "httpserver.access.resource": `${dispatched.kind}/${dispatched.name}`,
      "error.type": error.code,
      "error.message": error.message,
    },
    { eventName: "http.server.access_check.unavailable" },
  );
  const data = { stage };
  return accessRefusal(
    ERR_HTTP_ACCESS_CHECK_UNAVAILABLE,
    `${options.label}: the ${stage} '${dispatched.name}' could not decide: [${error.code}] ${error.message}`,
    { data, displayMessage: options.declaredDisplayMessage(ERR_HTTP_ACCESS_CHECK_UNAVAILABLE, data), cause: error },
  );
}

function dispatch(options: MountAccessOptions, trace: RequestTrace, target: Dispatched, inputs: unknown) {
  return options.ctx.invokeResolved(
    target.kind,
    target.name,
    target.instance,
    inputs,
    deriveContext(trace.context, { calledAt: target.calledAt }),
  );
}

/** The proof of possession the transport can vouch for (`Auth.Confirmation`). */
function confirmationOf(request: FastifyRequest, view: CredentialRequest): Record<string, unknown> {
  const confirmation: Record<string, unknown> = {};
  const fingerprint = view.clientCertificate?.fingerprint256;
  if (typeof fingerprint === "string") {
    confirmation.certificateThumbprint = Buffer.from(fingerprint.replace(/:/g, ""), "hex").toString("base64url");
  }
  const proof = singleHeader(request.headers.dpop);
  if (proof !== undefined) {
    confirmation.dpop = { proof, method: request.method, uri: `${requestOrigin(request)}${request.url.split("?")[0]}` };
  }
  return confirmation;
}

/** The canonical URI of the protected resource: the mount's origin and path. */
export function resourceOf(options: Pick<MountAccessOptions, "path" | "publicOrigin">, request: FastifyRequest): string {
  const path = options.path === "" || options.path === "/" ? "/" : options.path.replace(/\/$/, "");
  return `${mountOrigin(options, request)}${path}`;
}

function mountOrigin(options: Pick<MountAccessOptions, "publicOrigin">, request: FastifyRequest): string {
  return options.publicOrigin ?? requestOrigin(request);
}

/** The origin the client used, under the server's proxy trust. */
function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Each entry of a written `verifiers` list as the seam dispatches it. */
export function liveEntries(
  written: ReadonlyArray<{ verifier: unknown; from: unknown }>,
  refs: ReadonlyArray<{ verifier: { kind: string; name: string }; from: { kind: string; name: string } }>,
  at: string,
): AccessEntry[] {
  return written.map((entry, index) => ({
    verifier: {
      ...refs[index]!.verifier,
      instance: entry.verifier as ResourceInstance,
      calledAt: `${at}/${index}/verifier`,
    },
    from: { ...refs[index]!.from, instance: entry.from as ResourceInstance, calledAt: `${at}/${index}/from` },
  }));
}
