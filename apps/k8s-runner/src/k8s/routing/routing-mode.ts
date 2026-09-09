import type { K8sRunnerConfig } from "../../config.js";
import { RunnerConfigError } from "../../config.js";
import { apiReason } from "../api-error.js";
import type { KubeClient } from "../client.js";

const GATEWAY_GROUP = "gateway.networking.k8s.io";
/** Preference order among served Gateway API versions. `v1` is GA; plenty of
 *  clusters still serve only `v1beta1`, and an HTTPRoute posted at a version the
 *  apiserver does not serve is a 404 at publish time rather than a bad route. */
const GATEWAY_VERSIONS = ["v1", "v1beta1"];

export type ResolvedRouting =
  | { layer: "none"; reason: string }
  | { layer: "ingress" }
  | { layer: "gateway"; apiVersion: string };

/** The annotation by which a cluster nominates the class unqualified Ingresses
 *  go to — which is exactly what this runner creates when no class is set. */
const DEFAULT_CLASS_ANNOTATION = "ingressclass.kubernetes.io/is-default-class";

export interface ClusterRoutingSupport {
  /** Served Gateway API version, preferred first; undefined when the group is
   *  not served at all. */
  gatewayApiVersion?: string;
  /** Number of IngressClasses, or **undefined when the list could not be read**.
   *  `networking.k8s.io` is always served, so the API being present is no
   *  evidence anyone can route with it — an installed controller registers a
   *  class, and that is the usable signal. Zero and unknown are kept apart
   *  because a refusal phrased from them is a different claim: one is about the
   *  cluster, the other about this runner's permissions. */
  ingressClassCount?: number;
  /** Set when at least one IngressClass carries the default-class annotation. */
  hasDefaultIngressClass: boolean;
  /** Why the IngressClass list could not be read, when it could not. */
  ingressClassError?: unknown;
}

/** What the cluster can actually route with. Both probes fail SOFT — discovery
 *  and IngressClass listing are the runner's least important permissions — but a
 *  failure is REPORTED rather than folded into a zero, so nothing downstream can
 *  turn a permission error into a claim about the cluster. */
export async function detectRoutingSupport(kube: KubeClient): Promise<ClusterRoutingSupport> {
  let gatewayApiVersion: string | undefined;
  try {
    const groups = await kube.apis.getAPIVersions();
    const group = groups.groups?.find((g) => g.name === GATEWAY_GROUP);
    const served = new Set((group?.versions ?? []).map((v) => v.version));
    gatewayApiVersion =
      GATEWAY_VERSIONS.find((v) => served.has(v)) ?? group?.preferredVersion?.version;
  } catch {
    gatewayApiVersion = undefined;
  }

  try {
    const classes = await kube.networking.listIngressClass();
    const items = classes.items ?? [];
    return {
      gatewayApiVersion,
      ingressClassCount: items.length,
      hasDefaultIngressClass: items.some(
        (c) => c.metadata?.annotations?.[DEFAULT_CLASS_ANNOTATION] === "true",
      ),
    };
  } catch (err) {
    return { gatewayApiVersion, hasDefaultIngressClass: false, ingressClassError: err };
  }
}

/**
 * Decide the routing layer ONCE, at boot, so a misconfiguration fails the runner
 * instead of 404-ing every session it later accepts.
 *
 * `auto` resolves on what is CONFIGURED before what is INSTALLED, and that order
 * is the whole point: Gateway API CRDs are frequently present without being the
 * intended path, so "both APIs available" is not evidence of intent and must not
 * decide anything. Only a cluster that offers two usable layers and was told
 * nothing is genuinely ambiguous — and there the answer is to refuse, because
 * guessing wrong publishes routes nothing reconciles, which is silent.
 */
export async function resolveRouting(
  kube: KubeClient,
  config: K8sRunnerConfig,
): Promise<ResolvedRouting> {
  const routing = config.sessionRouting;

  if (routing.mode === "none") {
    return { layer: "none", reason: "SESSION_ROUTING_MODE=none" };
  }
  // The base domain is what makes a host constructible at all, so it stays the
  // master switch it has always been — no domain, no routing, whatever the mode.
  if (!routing.baseDomain) {
    return {
      layer: "none",
      reason: "SESSION_ROUTING_BASE_DOMAIN is unset, so no session host can be constructed",
    };
  }

  const support = await detectRoutingSupport(kube);
  const resolved = decideLayer(config, support);
  assertTlsMatchesLayer(config, resolved);
  return resolved;
}

/** The origin certificate is refused HERE as well as at config load, because
 *  under `auto` the effective layer is not known until now: a named Gateway wins,
 *  so `mode: auto` + a Gateway + `SESSION_INGRESS_TLS_SECRET` passed the
 *  config-time check and then routed on Gateway API with the certificate
 *  ignored — plaintext origin traffic under a configuration that reads as
 *  TLS-configured, which is the silent downgrade the check exists to prevent. */
function assertTlsMatchesLayer(config: K8sRunnerConfig, resolved: ResolvedRouting): void {
  if (resolved.layer !== "gateway" || !config.sessionRouting.tlsSecretName) return;
  throw new RunnerConfigError(
    "SESSION_INGRESS_TLS_SECRET is set but session routing resolved to Gateway API. Under Gateway " +
      "API the origin certificate belongs to the Gateway listener's own `tls.certificateRefs`, not " +
      "to the per-session route, so this Secret would be silently ignored. Move the reference to " +
      "the Gateway and unset this, or set SESSION_ROUTING_MODE=ingress.",
  );
}

function decideLayer(config: K8sRunnerConfig, support: ClusterRoutingSupport): ResolvedRouting {
  const routing = config.sessionRouting;

  if (routing.mode === "ingress") return { layer: "ingress" };

  if (routing.mode === "gateway") {
    if (!support.gatewayApiVersion) {
      throw new RunnerConfigError(
        `SESSION_ROUTING_MODE=gateway but the cluster does not serve '${GATEWAY_GROUP}'. ` +
          "Install the Gateway API CRDs, or set SESSION_ROUTING_MODE=ingress.",
      );
    }
    return { layer: "gateway", apiVersion: support.gatewayApiVersion };
  }

  // auto — configured target first.
  if (routing.gateway) {
    if (!support.gatewayApiVersion) {
      throw new RunnerConfigError(
        `SESSION_GATEWAY_NAME is set but the cluster does not serve '${GATEWAY_GROUP}'. ` +
          "Install the Gateway API CRDs, or unset SESSION_GATEWAY_NAME to route via Ingress.",
      );
    }
    return { layer: "gateway", apiVersion: support.gatewayApiVersion };
  }
  if (routing.ingressClassName) return { layer: "ingress" };
  // A DEFAULT-marked IngressClass is configuration, not mere availability: the
  // cluster has nominated where an unqualified Ingress goes, and unqualified is
  // exactly what this runner creates. It therefore ranks with a named Gateway
  // and a configured class rather than with "an IngressClass exists" — without
  // which every cluster that ships the Gateway CRDs beside a default ingress
  // controller would refuse to boot after this upgrade, having worked before.
  if (support.hasDefaultIngressClass) return { layer: "ingress" };

  const gatewayUsable = Boolean(support.gatewayApiVersion);
  const ingressUsable = (support.ingressClassCount ?? 0) > 0;

  if (gatewayUsable && ingressUsable) {
    throw new RunnerConfigError(
      `SESSION_ROUTING_MODE=auto cannot choose: this cluster serves '${GATEWAY_GROUP}' AND has ` +
        `${support.ingressClassCount} IngressClass(es) with none marked default, and nothing says ` +
        "which should carry session traffic. Set SESSION_ROUTING_MODE=ingress (with " +
        "SESSION_INGRESS_CLASS) or SESSION_ROUTING_MODE=gateway (with SESSION_GATEWAY_NAME).",
    );
  }
  if (gatewayUsable) {
    throw new RunnerConfigError(
      `SESSION_ROUTING_MODE=auto resolved to Gateway API, but SESSION_GATEWAY_NAME is unset — a ` +
        "route has to name the Gateway it attaches to, and picking one of several would fail as " +
        "silently as publishing none. Set SESSION_GATEWAY_NAME (and SESSION_GATEWAY_NAMESPACE " +
        `when the Gateway is not in '${config.sessionNamespace}').`,
    );
  }
  if (ingressUsable) return { layer: "ingress" };

  // Say which of the two it is. Reporting a permission failure as "no
  // IngressClass exists" is a claim about the cluster drawn from a fact about
  // this runner's access, and it sends an operator to install a controller they
  // already have.
  if (support.ingressClassError !== undefined) {
    throw new RunnerConfigError(
      "SESSION_ROUTING_BASE_DOMAIN is set but the routing layer could not be resolved: listing " +
        `IngressClasses failed (${apiReason(support.ingressClassError)}) and '${GATEWAY_GROUP}' is ` +
        "not served. Grant `list` on `ingressclasses`, or set SESSION_ROUTING_MODE explicitly.",
    );
  }
  throw new RunnerConfigError(
    "SESSION_ROUTING_BASE_DOMAIN is set but this cluster offers no usable routing layer: no " +
      `IngressClass exists and '${GATEWAY_GROUP}' is not served. Install an Ingress controller or ` +
      "the Gateway API, or set SESSION_ROUTING_MODE=none to run logs-only.",
  );
}
