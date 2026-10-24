/** The part of the Engine API a session's workload is driven through, in the
 *  shapes dockerode answers with. Only the fields the runner reads. */

export interface InspectedSessionContainer {
  Id: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  State?: { Status?: string; Running?: boolean; ExitCode?: number; Error?: string; OOMKilled?: boolean };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export interface ListedSessionContainer {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

export interface WaitResult {
  StatusCode: number;
  Error?: { Message: string } | null;
}

export interface SessionDockerContainer {
  id: string;
  start(): Promise<unknown>;
  inspect(): Promise<InspectedSessionContainer>;
  wait(): Promise<WaitResult>;
  remove(options: { force: true; v: true }): Promise<unknown>;
}

/** A volume mount, optionally scoped to a subdirectory of the volume.
 *  `Subpath` arrived in Engine API 1.45 (Docker 26), and an older daemon
 *  ignores it and mounts the volume WHOLE, which is why the runner refuses to
 *  boot on one. Declared here because `@types/dockerode` does not carry it. */
export interface VolumeMount {
  Type: "volume";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
}

export type PortBindings = Record<string, Array<{ HostIp: string; HostPort: string }>>;

export interface CreateContainerOpts {
  name: string;
  Image: string;
  /** Replaces the image's entry point; an app container's is the supervisor. */
  Entrypoint?: string[];
  /** Omitted to keep the image's own (the agent's catalog image). */
  Cmd?: string[];
  WorkingDir?: string;
  Env: string[];
  Labels: Record<string, string>;
  Tty: false;
  OpenStdin: false;
  AttachStdin: false;
  AttachStdout: false;
  AttachStderr: false;
  ExposedPorts?: Record<string, Record<string, never>>;
  NetworkingConfig?: { EndpointsConfig: Record<string, { Aliases?: string[] }> };
  HostConfig: {
    Binds: string[];
    /** Never: an ended container is kept until the runner removes it, so its
     *  ending can still be read — at adoption most of all. */
    AutoRemove: false;
    NetworkMode: string;
    PortBindings?: PortBindings;
    Mounts?: VolumeMount[];
  };
}

export interface PullProgress {
  followProgress(
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null, output: unknown[]) => void,
  ): void;
}

/** The docker client the backend uses. */
export interface SessionDockerClient {
  ping(): Promise<unknown>;
  version(): Promise<{ ApiVersion?: string }>;
  getVolume(name: string): { inspect(): Promise<unknown> };
  getNetwork(name: string): { inspect(): Promise<unknown> };
  getImage(name: string): { inspect(): Promise<unknown> };
  pull(image: string): Promise<NodeJS.ReadableStream>;
  modem: PullProgress;
  createContainer(options: CreateContainerOpts): Promise<SessionDockerContainer>;
  getContainer(id: string): SessionDockerContainer;
  /** `filters` is the Engine API's JSON filter document. */
  listContainers(options: { all: true; filters?: string }): Promise<ListedSessionContainer[]>;
}

export function statusCodeOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
