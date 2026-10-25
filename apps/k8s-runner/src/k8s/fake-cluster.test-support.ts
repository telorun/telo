import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { threadId } from "node:worker_threads";

import type { V1Pod } from "@kubernetes/client-node";
import { FakeSupervisor } from "@telorun/runner-core/test-support";

import type { KubeClient } from "./client.js";
import {
  APP_SLOTS,
  APP_SLOTS_ANNOTATION,
  SUPERVISOR_LISTEN_ENV,
  SUPERVISOR_TOKEN_ENV,
  TOOLING_SLOT,
  WORKSPACE_PORT,
} from "./pod-spec.js";

interface FakePod {
  pod: V1Pod;
  /** The apps container's supervisors, by slot. */
  supervisors: Map<number, FakeSupervisor>;
  servers: Server[];
}

const notFound = () => Object.assign(new Error("not found"), { code: 404 });
const conflict = () => Object.assign(new Error("exists"), { code: 409 });

function matches(labels: Record<string, string> | undefined, selector: string | undefined): boolean {
  if (!selector) return true;
  return selector.split(",").every((term) => {
    const [key, value] = term.split("=");
    return labels?.[key!] === value;
  });
}

// Test files run concurrently in one process (and in several), each with its own
// copy of this module, so each takes its own 127.x.y block of loopback addresses.
const ADDRESS_BLOCK = `127.${1 + (process.pid % 250)}.${1 + (threadId % 250)}`;
let nextAddress = 20;

/**
 * A session namespace whose "kubelet" brings a created pod up on a loopback
 * address of its own: the workspace surface on its port, and a supervisor
 * speaking the protocol on each slot's port of the apps container, accepting the
 * token the pod spec carries.
 */
export class FakeCluster {
  readonly pods = new Map<string, FakePod>();
  readonly claims = new Map<string, { metadata: { name: string; labels: Record<string, string> } }>();
  readonly deletedPods: string[] = [];
  readonly deletedClaims: string[] = [];
  readonly workspaceWrites: unknown[] = [];
  private watchers: Array<{ name: string; onEvent: (type: string, obj: unknown) => void }> = [];
  /** The generation supervisors of pods created from now on claim. */
  generation = 1;

  readonly kube = {
    core: {
      readNamespace: async () => ({}),
      listNamespacedPod: async ({ labelSelector }: { labelSelector?: string }) => ({
        items: [...this.pods.values()].map((p) => p.pod).filter((p) => matches(p.metadata?.labels, labelSelector)),
      }),
      readNamespacedPod: async ({ name }: { name: string }) => {
        const found = this.pods.get(name);
        if (!found) throw notFound();
        return found.pod;
      },
      createNamespacedPod: async ({ body }: { body: V1Pod }) => this.start(body),
      replaceNamespacedPod: async ({ name, body }: { name: string; body: V1Pod }) => {
        const found = this.pods.get(name);
        if (!found) throw notFound();
        found.pod = { ...body, status: found.pod.status };
        return found.pod;
      },
      deleteNamespacedPod: async ({ name }: { name: string }) => {
        const found = this.pods.get(name);
        if (!found) throw notFound();
        this.pods.delete(name);
        this.deletedPods.push(name);
        await closeAll(found);
        return {};
      },
      createNamespacedPersistentVolumeClaim: async ({ body }: { body: { metadata: { name: string; labels: Record<string, string> } } }) => {
        if (this.claims.has(body.metadata.name)) throw conflict();
        this.claims.set(body.metadata.name, body);
        return body;
      },
      listNamespacedPersistentVolumeClaim: async ({ labelSelector }: { labelSelector?: string }) => ({
        items: [...this.claims.values()].filter((c) => matches(c.metadata.labels, labelSelector)),
      }),
      deleteNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => {
        if (!this.claims.delete(name)) throw notFound();
        this.deletedClaims.push(name);
        return {};
      },
      readNamespacedConfigMap: async () => ({}),
      listNamespacedConfigMap: async () => ({ items: [] }),
    },
    watch: {
      watch: async (path: string, query: { fieldSelector: string }, onEvent: (type: string, obj: unknown) => void) => {
        const watcher = { name: query.fieldSelector.replace("metadata.name=", ""), onEvent };
        this.watchers.push(watcher);
        return { abort: () => (this.watchers = this.watchers.filter((w) => w !== watcher)) };
      },
    },
  } as unknown as KubeClient;

  /** Bring a pod up as the kubelet would. Exposed to stand up a pod an earlier
   *  runner process created. */
  async start(body: V1Pod, live: Record<string, string> = {}): Promise<V1Pod> {
    const name = body.metadata!.name!;
    const ip = `${ADDRESS_BLOCK}.${nextAddress++}`;
    const pod: V1Pod = {
      ...body,
      metadata: { ...body.metadata, uid: `uid-${name}` },
      status: {
        phase: "Running",
        podIP: ip,
        containerStatuses: body.spec!.containers.map((c) => ({
          name: c.name,
          image: c.image ?? "",
          imageID: "",
          ready: true,
          restartCount: 0,
          state: { running: {} },
        })),
      },
    };
    const fake: FakePod = { pod, supervisors: new Map(), servers: [] };
    fake.servers.push(await this.workspaceServer(ip));
    const apps = body.spec!.containers.find((c) => c.name === "apps");
    if (apps) {
      const env = Object.fromEntries((apps.env ?? []).map((e) => [e.name, e.value ?? ""]));
      const base = Number(env[SUPERVISOR_LISTEN_ENV]!.split(":")[1]);
      const slots = JSON.parse(body.metadata!.annotations![APP_SLOTS_ANNOTATION]!) as Record<string, number>;
      for (let slot = 0; slot <= APP_SLOTS; slot += 1) {
        const app = Object.keys(slots).find((name) => slots[name] === slot);
        fake.supervisors.set(
          slot,
          await FakeSupervisor.start({
            host: ip,
            port: base + slot,
            token: env[SUPERVISOR_TOKEN_ENV]!,
            generation: this.generation,
            live: app === undefined ? undefined : live[app],
          }),
        );
      }
    }
    this.pods.set(name, fake);
    return pod;
  }

  supervisorOf(app: string): FakeSupervisor {
    for (const fake of this.pods.values()) {
      const slot = (JSON.parse(fake.pod.metadata!.annotations![APP_SLOTS_ANNOTATION]!) as Record<string, number>)[app];
      if (slot !== undefined) return fake.supervisors.get(slot)!;
    }
    throw new Error(`no supervisor for '${app}'`);
  }

  /** The supervisor the runner's own tasks run on. */
  toolingSupervisor(): FakeSupervisor {
    const fake = [...this.pods.values()][0];
    if (!fake) throw new Error("no pod");
    return fake.supervisors.get(TOOLING_SLOT)!;
  }

  onlyPod(): V1Pod {
    const pods = [...this.pods.values()];
    if (pods.length !== 1) throw new Error(`expected one pod, found ${pods.length}`);
    return pods[0]!.pod;
  }

  /** Send a watch event for a pod, as the API server would. */
  emit(type: string, pod: V1Pod): void {
    for (const w of this.watchers) if (w.name === pod.metadata?.name) w.onEvent(type, pod);
  }

  async close(): Promise<void> {
    for (const fake of this.pods.values()) await closeAll(fake);
    this.pods.clear();
  }

  private async workspaceServer(ip: string): Promise<Server> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "POST") {
          this.workspaceWrites.push(JSON.parse(body));
          res.end(JSON.stringify({ written: 1, deleted: 0 }));
        } else {
          res.end(JSON.stringify({ files: [] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(WORKSPACE_PORT, ip, resolve));
    return server;
  }
}

async function closeAll(fake: FakePod): Promise<void> {
  await Promise.all([
    ...[...fake.supervisors.values()].map((s) => s.close()),
    ...fake.servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  ]);
}

export type { AddressInfo };
