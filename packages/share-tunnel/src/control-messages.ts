// The tunnel's control messages: one JSON object per WebSocket text message,
// closed (an unknown `type` or field is a protocol error), read per direction.

/** One `tcp` port the client routes: its `ports:` key and its number. */
export interface SharePort {
  name: string;
  port: number;
}

/** What the client (the CLI) sends the relay. */
export type ClientControlMessage =
  | { type: "hello"; epoch: number | null }
  | { type: "ports"; ports: SharePort[] }
  | { type: "auth"; accessToken: string; proof: string };

/** What the relay sends the client. */
export type RelayControlMessage = { type: "hello"; epoch: number };

export type ControlMessageReading<T> = { ok: true; message: T } | { ok: false; error: string };

/** Reads a text message the client sent, as the relay judges it. */
export function readClientControlMessage(text: string): ControlMessageReading<ClientControlMessage> {
  return read(text, (object) => {
    switch (object.type) {
      case "hello":
        exactFields(object, ["type", "epoch"]);
        if (object.epoch !== null) epochField(object.epoch, "hello.epoch");
        return { type: "hello", epoch: object.epoch as number | null };
      case "ports":
        exactFields(object, ["type", "ports"]);
        return { type: "ports", ports: portsField(object.ports) };
      case "auth":
        exactFields(object, ["type", "accessToken", "proof"]);
        nonEmptyString(object.accessToken, "auth.accessToken");
        nonEmptyString(object.proof, "auth.proof");
        return { type: "auth", accessToken: object.accessToken as string, proof: object.proof as string };
      default:
        throw new Refusal(`'${object.type}' is not a message the client sends`);
    }
  });
}

/** Reads a text message the relay sent, as the client judges it. */
export function readRelayControlMessage(text: string): ControlMessageReading<RelayControlMessage> {
  return read(text, (object) => {
    if (object.type !== "hello") throw new Refusal(`'${object.type}' is not a message the relay sends`);
    exactFields(object, ["type", "epoch"]);
    epochField(object.epoch, "hello.epoch");
    return { type: "hello", epoch: object.epoch as number };
  });
}

/** The text of a control message, as sent. */
export function encodeControlMessage(message: ClientControlMessage | RelayControlMessage): string {
  return JSON.stringify(message);
}

/** Checks a ports list the client is about to announce; throws a `TypeError` naming the first fault. */
export function assertSharePorts(ports: readonly SharePort[]): void {
  try {
    portsField(ports);
  } catch (err) {
    if (err instanceof Refusal) throw new TypeError(err.message);
    throw err;
  }
}

class Refusal extends Error {}

function read<T>(
  text: string,
  judge: (object: Record<string, unknown> & { type: string }) => T,
): ControlMessageReading<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON: ${(err as Error).message}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "not a JSON object" };
  }
  const object = value as Record<string, unknown>;
  if (typeof object.type !== "string") return { ok: false, error: "no string 'type'" };
  try {
    return { ok: true, message: judge(object as Record<string, unknown> & { type: string }) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

function exactFields(object: Record<string, unknown>, fields: readonly string[]): void {
  for (const key of Object.keys(object)) {
    if (!fields.includes(key)) throw new Refusal(`'${object.type}' has no field '${key}'`);
  }
  for (const field of fields) {
    if (!(field in object)) throw new Refusal(`'${object.type}' needs '${field}'`);
  }
}

function epochField(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Refusal(`${path} must be a non-negative integer`);
  }
}

function nonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value === "") throw new Refusal(`${path} must be a non-empty string`);
}

function portsField(value: unknown): SharePort[] {
  if (!Array.isArray(value)) throw new Refusal("ports.ports must be a list");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const path = `ports.ports[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Refusal(`${path} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "port") throw new Refusal(`${path} has no field '${key}'`);
    }
    const { name, port } = entry as Record<string, unknown>;
    nonEmptyString(name, `${path}.name`);
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Refusal(`${path}.port must be an integer from 1 to 65535`);
    }
    if (names.has(name as string)) throw new Refusal(`${path}.name '${name as string}' is listed twice`);
    names.add(name as string);
    return { name: name as string, port };
  });
}
