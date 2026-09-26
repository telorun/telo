import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-languageserver/browser";

/**
 * What the engine speaks LSP over: anything that posts a message object and
 * delivers the other side's as `event.data` — a Web Worker scope, a
 * `MessagePort`, an adapted Node `parentPort`. Messages are JSON-RPC objects,
 * never framed text.
 */
export interface EnginePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export class PortMessageReader extends AbstractMessageReader implements MessageReader {
  constructor(private readonly port: EnginePort) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    let active = true;
    this.port.addEventListener("message", (event) => {
      if (active) callback(event.data as Message);
    });
    return { dispose: () => (active = false) };
  }
}

export class PortMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private errorCount = 0;

  constructor(private readonly port: EnginePort) {
    super();
  }

  write(message: Message): Promise<void> {
    try {
      this.port.postMessage(message);
      return Promise.resolve();
    } catch (error) {
      this.errorCount++;
      this.fireError(error, message, this.errorCount);
      return Promise.reject(error);
    }
  }

  end(): void {}
}
