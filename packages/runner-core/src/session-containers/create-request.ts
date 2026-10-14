import { SESSION_CONTAINER_LABEL, type SessionContainerSpec } from "./session-container-engine.js";

/** A create body the engine admits: the container to run, and the ports the
 *  session asked a binding for, which inspect answers. */
export interface AdmittedCreate {
  spec: SessionContainerSpec;
  bound: number[];
}

/** Why a create body is refused, naming the field by its full path. */
export interface RefusedCreate {
  field: string;
  message: string;
}

const ACCEPTED_KEYS = new Set([
  "Image",
  "Cmd",
  "Entrypoint",
  "Env",
  "User",
  "ExposedPorts",
  "Labels",
  "HostConfig",
]);
const PORT_KEY = /^(\d{1,5})\/tcp$/;
const ENV_ENTRY = /^[^=]+=/;
const LOOPBACK = "127.0.0.1";

/**
 * Admit a `POST /containers/create` body, or name the first field this engine
 * does not run. Only the documented keys are accepted, and `HostConfig` only
 * as one loopback binding with an engine-chosen port per exposed port — the
 * shape a client asks for its address in. The engine publishes nothing on any
 * host: inspect answers that binding with the address the session reaches the
 * container at.
 */
export function admitCreate(body: unknown, sessionId: string): AdmittedCreate | RefusedCreate {
  if (!isPlainObject(body)) return refuse("(body)", "must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!ACCEPTED_KEYS.has(key)) return refuse(key, "is not accepted by this engine");
  }

  if (typeof body.Image !== "string" || body.Image.trim() === "") {
    return refuse("Image", "must be a non-empty string");
  }
  const cmd = stringList(body.Cmd, "Cmd");
  if (isRefusal(cmd)) return cmd;
  const entrypoint = stringList(body.Entrypoint, "Entrypoint");
  if (isRefusal(entrypoint)) return entrypoint;
  const env = stringList(body.Env, "Env");
  if (isRefusal(env)) return env;
  const badEnv = (env ?? []).findIndex((entry) => !ENV_ENTRY.test(entry));
  if (badEnv !== -1) return refuse(`Env[${badEnv}]`, "must be NAME=value");
  if (body.User !== undefined && typeof body.User !== "string") {
    return refuse("User", "must be a string");
  }

  const ports: number[] = [];
  if (body.ExposedPorts !== undefined) {
    if (!isPlainObject(body.ExposedPorts)) return refuse("ExposedPorts", "must be an object");
    for (const [key, value] of Object.entries(body.ExposedPorts)) {
      const port = tcpPort(key);
      if (port === undefined) {
        return refuse(`ExposedPorts.${key}`, "must name a tcp port as <port>/tcp");
      }
      if (!isPlainObject(value) || Object.keys(value).length > 0) {
        return refuse(`ExposedPorts.${key}`, "must be {}");
      }
      ports.push(port);
    }
  }

  const labels: Record<string, string> = {};
  if (body.Labels !== undefined) {
    if (!isPlainObject(body.Labels)) return refuse("Labels", "must be an object");
    for (const [key, value] of Object.entries(body.Labels)) {
      if (key === SESSION_CONTAINER_LABEL) {
        return refuse(`Labels.${key}`, "is set by the runner");
      }
      if (typeof value !== "string") return refuse(`Labels.${key}`, "must be a string");
      labels[key] = value;
    }
  }
  labels[SESSION_CONTAINER_LABEL] = sessionId;

  const bound: number[] = [];
  if (body.HostConfig !== undefined) {
    if (!isPlainObject(body.HostConfig)) return refuse("HostConfig", "must be an object");
    for (const key of Object.keys(body.HostConfig)) {
      if (key !== "PortBindings") return refuse(`HostConfig.${key}`, "is not accepted by this engine");
    }
    const bindings = body.HostConfig.PortBindings;
    if (bindings !== undefined) {
      if (!isPlainObject(bindings)) return refuse("HostConfig.PortBindings", "must be an object");
      for (const [key, value] of Object.entries(bindings)) {
        const field = `HostConfig.PortBindings.${key}`;
        const port = tcpPort(key);
        if (port === undefined || !ports.includes(port)) {
          return refuse(field, "must name a port listed in ExposedPorts");
        }
        if (!Array.isArray(value) || value.length !== 1) {
          return refuse(field, "must hold exactly one binding");
        }
        const binding: unknown = value[0];
        if (!isPlainObject(binding)) return refuse(`${field}[0]`, "must be an object");
        for (const name of Object.keys(binding)) {
          if (name !== "HostIp" && name !== "HostPort") {
            return refuse(`${field}[0].${name}`, "is not accepted by this engine");
          }
        }
        if (binding.HostIp !== LOOPBACK) {
          return refuse(`${field}[0].HostIp`, `must be ${LOOPBACK}`);
        }
        if (binding.HostPort !== undefined && binding.HostPort !== "") {
          return refuse(
            `${field}[0].HostPort`,
            "must be empty: this engine binds no host port and answers the address in inspect",
          );
        }
        bound.push(port);
      }
    }
  }

  return {
    spec: {
      image: body.Image,
      ...(cmd ? { cmd } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      env: env ?? [],
      ...(typeof body.User === "string" && body.User !== "" ? { user: body.User } : {}),
      ports,
      labels,
    },
    bound,
  };
}

export function isRefusal(value: unknown): value is RefusedCreate {
  return isPlainObject(value) && typeof value.field === "string" && typeof value.message === "string";
}

function refuse(field: string, message: string): RefusedCreate {
  return { field, message };
}

function stringList(value: unknown, field: string): string[] | undefined | RefusedCreate {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return refuse(field, "must be a list of strings");
  const bad = value.findIndex((item) => typeof item !== "string");
  if (bad !== -1) return refuse(`${field}[${bad}]`, "must be a string");
  return value as string[];
}

function tcpPort(key: string): number | undefined {
  const match = PORT_KEY.exec(key);
  if (!match) return undefined;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
