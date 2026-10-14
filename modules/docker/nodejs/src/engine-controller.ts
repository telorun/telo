import type {
  ContainerEngine,
  ContainerLogOptions,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  PortBinding,
} from "@telorun/container";
import type { ResourceInstance } from "@telorun/sdk";
import type { IncomingMessage } from "node:http";
import {
  EngineStatusError,
  parseEndpoint,
  readJson,
  readText,
  send,
  type EngineRequest,
  type EngineTarget,
} from "./engine-api-client.js";

interface EngineResource {
  metadata: { name: string };
  endpoint: string;
  token?: string;
}

/**
 * Docker.Engine — the container engine contract over the Docker Engine API
 * 1.41, raw HTTP over a unix socket or TCP. Every request it sends is listed in
 * `docs/engine-api.md`; that list is the whole of what an endpoint must answer.
 */
export class DockerEngine implements ContainerEngine, ResourceInstance {
  private readonly target: EngineTarget;
  private readonly token: string | undefined;

  constructor(resource: EngineResource) {
    this.target = parseEndpoint(resource.endpoint);
    this.token = resource.token || undefined;
  }

  private send(req: EngineRequest): Promise<IncomingMessage> {
    return send(this.target, this.token, req);
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await readText(await this.send({ method: "GET", path: "/_ping", signal }));
  }

  async hasImage(image: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await readText(await this.send({ method: "GET", path: `/images/${image}/json`, signal }));
      return true;
    } catch (err) {
      if (err instanceof EngineStatusError && err.status === 404) return false;
      throw err;
    }
  }

  async pullImage(image: string, signal?: AbortSignal): Promise<void> {
    const res = await this.send({
      method: "POST",
      path: "/images/create",
      query: pullQuery(image),
      signal,
    });
    // Progress arrives as JSON lines; a failure part-way is one of them, after
    // a 200 status.
    const text = await readText(res);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { error?: unknown; errorDetail?: { message?: unknown } };
      const failure = event.errorDetail?.message ?? event.error;
      if (failure !== undefined) throw new Error(`pulling ${image} failed: ${String(failure)}`);
    }
  }

  async create(spec: ContainerSpec, signal?: AbortSignal): Promise<string> {
    const res = await this.send({
      method: "POST",
      path: "/containers/create",
      body: createBody(spec),
      signal,
    });
    const created = (await readJson(res)) as { Id?: unknown };
    if (typeof created?.Id !== "string") throw new Error("the engine created a container with no Id");
    return created.Id;
  }

  async start(id: string, signal?: AbortSignal): Promise<void> {
    await readText(await this.send({ method: "POST", path: `/containers/${id}/start`, signal }));
  }

  async inspect(id: string, signal?: AbortSignal): Promise<ContainerState> {
    const res = await this.send({ method: "GET", path: `/containers/${id}/json`, signal });
    return containerState((await readJson(res)) as InspectBody);
  }

  async *logs(
    id: string,
    options: ContainerLogOptions,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const query: Record<string, string> = {
      follow: String(options.follow),
      stdout: "true",
      stderr: "true",
    };
    if (options.tail !== undefined) query.tail = String(options.tail);
    const res = await this.send({ method: "GET", path: `/containers/${id}/logs`, query, signal });
    yield* demultiplex(res);
  }

  async list(label: string, signal?: AbortSignal): Promise<ContainerSummary[]> {
    const res = await this.send({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ label: [label] }) },
      signal,
    });
    const listed = (await readJson(res)) as Array<{ Id: string; Labels?: Record<string, string> }>;
    return listed.map((entry) => ({ id: entry.Id, labels: entry.Labels ?? {} }));
  }

  async remove(id: string, signal?: AbortSignal): Promise<void> {
    try {
      await readText(
        await this.send({
          method: "DELETE",
          path: `/containers/${id}`,
          query: { force: "true", v: "true" },
          signal,
        }),
      );
    } catch (err) {
      // 404: already gone. 409: another remover got there first.
      if (err instanceof EngineStatusError && (err.status === 404 || err.status === 409)) return;
      throw err;
    }
  }

  snapshot(): Record<string, unknown> {
    return { endpoint: this.target.endpoint };
  }
}

/** `fromImage` plus `tag`: an image with no tag names `latest`, since an empty
 *  tag asks the engine for every tag of the repository. */
export function pullQuery(image: string): Record<string, string> {
  if (image.includes("@")) return { fromImage: image };
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return { fromImage: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { fromImage: image, tag: "latest" };
}

/** Exactly the keys the engine contract allows a create to carry: every
 *  published port bound on loopback to a port the engine chooses. */
export function createBody(spec: ContainerSpec): Record<string, unknown> {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const port of spec.ports) {
    exposed[`${port}/tcp`] = {};
    bindings[`${port}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "" }];
  }
  return {
    Image: spec.image,
    ...(spec.command ? { Cmd: [...spec.command] } : {}),
    ...(spec.entrypoint ? { Entrypoint: [...spec.entrypoint] } : {}),
    Env: Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
    ...(spec.user ? { User: spec.user } : {}),
    ExposedPorts: exposed,
    Labels: { ...spec.labels },
    HostConfig: { PortBindings: bindings },
  };
}

interface InspectBody {
  State?: { Running?: boolean; ExitCode?: number };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

/** The binding inspect reports is the address the requester reaches the port
 *  at — and the only address read. */
export function containerState(body: InspectBody): ContainerState {
  const running = body.State?.Running === true;
  const bindings = new Map<number, PortBinding>();
  for (const [key, entries] of Object.entries(body.NetworkSettings?.Ports ?? {})) {
    const [port, protocol] = key.split("/");
    const first = entries?.[0];
    if (protocol !== "tcp" || !first?.HostPort) continue;
    bindings.set(Number(port), { host: first.HostIp ?? "", port: Number(first.HostPort) });
  }
  return { running, exitCode: running ? null : (body.State?.ExitCode ?? null), bindings };
}

/** The log stream's framing: an 8-byte header (stream id, three zero bytes, a
 *  big-endian payload length) before each payload. */
export async function* demultiplex(source: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoders = new Map<number, TextDecoder>();
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    let text = "";
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const stream = pending[0];
      let decoder = decoders.get(stream);
      if (!decoder) decoders.set(stream, (decoder = new TextDecoder()));
      text += decoder.decode(pending.subarray(8, 8 + size), { stream: true });
      pending = pending.subarray(8 + size);
    }
    if (text) yield text;
  }
}

export async function create(resource: EngineResource): Promise<DockerEngine> {
  return new DockerEngine(resource);
}
