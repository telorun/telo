import {
  AbstractMessageReader,
  AbstractMessageWriter,
  RAL,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-languageserver-protocol";
import type { EnginePort } from "./host-seams.js";

/** A reader/writer pair — one end of an LSP connection. */
export interface MessageTransports {
  reader: MessageReader;
  writer: MessageWriter;
}

class CallbackReader extends AbstractMessageReader {
  private callbacks: DataCallback[] = [];
  listen(callback: DataCallback): Disposable {
    this.callbacks.push(callback);
    return { dispose: () => (this.callbacks = this.callbacks.filter((c) => c !== callback)) };
  }
  deliver(message: Message): void {
    for (const callback of this.callbacks) callback(message);
  }
}

class CallbackWriter extends AbstractMessageWriter {
  constructor(private readonly send: (message: Message) => void) {
    super();
  }
  write(message: Message): Promise<void> {
    try {
      this.send(message);
      return Promise.resolve();
    } catch (error) {
      this.fireError(error, message);
      return Promise.reject(error);
    }
  }
  end(): void {}
}

/** Two connected ends in one process — the editor's LSP client on one, the
 *  router on the other. Messages are delivered asynchronously, as over a real
 *  channel, so neither side re-enters the other. */
export function createInProcessTransports(): { client: MessageTransports; server: MessageTransports } {
  const toClient = new CallbackReader();
  const toServer = new CallbackReader();
  const later = (deliver: () => void) => void Promise.resolve().then(deliver);
  return {
    client: { reader: toClient, writer: new CallbackWriter((m) => later(() => toServer.deliver(m))) },
    server: { reader: toServer, writer: new CallbackWriter((m) => later(() => toClient.deliver(m))) },
  };
}

/** One end over an engine's structural port. */
export function portTransports(port: EnginePort): MessageTransports {
  const reader = new CallbackReader();
  port.addEventListener("message", (event) => reader.deliver(event.data as Message));
  return { reader, writer: new CallbackWriter((m) => port.postMessage(m)) };
}

/**
 * The JSON-RPC runtime layer, installed from web globals when the host has not
 * installed one — an LSP client library normally has (VS Code's installs
 * Node's). Only object-message transports are used here, so the byte-stream
 * half of the layer is refused rather than emulated.
 */
export function ensureMessageRuntime(): void {
  try {
    RAL();
    return;
  } catch {
    // Not installed yet: install the web one below.
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  RAL.install({
    applicationJson: {
      encoder: {
        name: "application/json",
        encode: (message: Message) => Promise.resolve(encoder.encode(JSON.stringify(message))),
      },
      decoder: {
        name: "application/json",
        decode: (buffer: Uint8Array) => Promise.resolve(JSON.parse(decoder.decode(buffer))),
      },
    },
    messageBuffer: {
      create: () => {
        throw new Error("@telorun/language-host speaks LSP over message objects, never byte streams.");
      },
    },
    console,
    timer: {
      setTimeout: (callback, ms, ...args) => {
        const handle = setTimeout(callback, ms, ...args);
        return { dispose: () => clearTimeout(handle) };
      },
      setImmediate: (callback, ...args) => {
        const handle = setTimeout(callback, 0, ...args);
        return { dispose: () => clearTimeout(handle) };
      },
      setInterval: (callback, ms, ...args) => {
        const handle = setInterval(callback, ms, ...args);
        return { dispose: () => clearInterval(handle) };
      },
    },
  });
}
