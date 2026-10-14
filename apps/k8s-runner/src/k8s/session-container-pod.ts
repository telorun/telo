import type { V1NetworkPolicy, V1OwnerReference, V1Pod } from "@kubernetes/client-node";
import {
  SESSION_CONTAINER_LABEL,
  SessionContainerFieldRefused,
  type SessionContainerSpec,
} from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";

/** The one container of a session container's pod. */
export const SESSION_CONTAINER_NAME = "container";
/** The label every session pod carries, valued with its session id. */
export const SESSION_POD_LABEL = "telo.run/session-id";

const NUMERIC_USER = /^(\d+)(?::(\d+))?$/;

/**
 * The pod a session's container runs as. The session namespace enforces the
 * `restricted` Pod Security standard, so it runs as a numeric non-root user,
 * with every capability dropped, no privilege escalation, the runtime's default
 * seccomp profile and no service-account token; it publishes no host or node
 * port. It carries the session label rather than the session pod's, so the
 * session's Service never selects it, and the runner's managed-by label, so the
 * boot sweep removes it. Owned by the session pod, it is collected with it.
 */
export function buildSessionContainerPod(args: {
  config: K8sRunnerConfig;
  sessionId: string;
  name: string;
  spec: SessionContainerSpec;
  owner: V1OwnerReference;
}): V1Pod {
  const { config, sessionId, name, spec } = args;
  const user = numericUser(spec.user);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: config.sessionNamespace,
      labels: {
        "app.kubernetes.io/managed-by": config.managedByLabel,
        [SESSION_CONTAINER_LABEL]: sessionId,
      },
      ownerReferences: [args.owner],
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
      ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
      securityContext: {
        runAsNonRoot: true,
        ...(user ? { runAsUser: user.uid, ...(user.gid !== undefined ? { runAsGroup: user.gid } : {}) } : {}),
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: SESSION_CONTAINER_NAME,
          image: spec.image,
          ...(spec.entrypoint ? { command: spec.entrypoint } : {}),
          ...(spec.cmd ? { args: spec.cmd } : {}),
          env: spec.env.map((entry) => {
            const eq = entry.indexOf("=");
            return { name: entry.slice(0, eq), value: entry.slice(eq + 1) };
          }),
          ...(spec.ports.length > 0
            ? { ports: spec.ports.map((port) => ({ containerPort: port, protocol: "TCP" })) }
            : {}),
          resources: config.sessionContainerResources,
          securityContext: {
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

/** `uid[:gid]`, numeric and not root, or the refusal naming `User`. */
function numericUser(user: string | undefined): { uid: number; gid?: number } | undefined {
  if (user === undefined) return undefined;
  const match = NUMERIC_USER.exec(user);
  if (!match || Number(match[1]) === 0) {
    throw new SessionContainerFieldRefused(
      "User",
      `'${user}' is not a numeric non-root uid[:gid]; this runner starts containers under the ` +
        `restricted Pod Security standard, which runs no container as root or as a named user`,
    );
  }
  return { uid: Number(match[1]), ...(match[2] !== undefined ? { gid: Number(match[2]) } : {}) };
}

/**
 * The two policies that let one session reach the containers it started and
 * nothing else reach them: its containers admit ingress from its own pods, and
 * its pods may egress to its containers. Network policies only add, so these
 * open exactly that path through the session namespace's policy, which denies
 * pod-to-pod traffic and the private ranges pod addresses live in.
 */
export function buildSessionContainerPolicies(args: {
  config: K8sRunnerConfig;
  sessionId: string;
  owner: V1OwnerReference;
}): V1NetworkPolicy[] {
  const { config, sessionId, owner } = args;
  const sessionPods = { matchLabels: { [SESSION_POD_LABEL]: sessionId } };
  const sessionContainers = { matchLabels: { [SESSION_CONTAINER_LABEL]: sessionId } };
  const metadata = (direction: PolicyDirection) => ({
    name: sessionContainerPolicyName(sessionId, direction),
    namespace: config.sessionNamespace,
    labels: { "app.kubernetes.io/managed-by": config.managedByLabel },
    ownerReferences: [owner],
  });
  return [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("ingress"),
      spec: {
        podSelector: sessionContainers,
        policyTypes: ["Ingress"],
        ingress: [{ _from: [{ podSelector: sessionPods }] }],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("egress"),
      spec: {
        podSelector: sessionPods,
        policyTypes: ["Egress"],
        egress: [{ to: [{ podSelector: sessionContainers }] }],
      },
    },
  ];
}

export const POLICY_DIRECTIONS = ["ingress", "egress"] as const;
type PolicyDirection = (typeof POLICY_DIRECTIONS)[number];

export function sessionContainerPolicyName(sessionId: string, direction: PolicyDirection): string {
  return `telo-ctr-${sessionId}-${direction}`;
}
