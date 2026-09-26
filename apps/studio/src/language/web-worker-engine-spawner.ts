import type { EngineSpawner } from "@telorun/language-host";

/**
 * Runs an engine in a module Web Worker. The engine runs from the verified
 * bytes themselves — a `blob:` URL made from them, imported by a bootstrap that
 * serves LSP on the worker scope — never from a URL whose content could change
 * between the check and the load. A module that throws while evaluating, an
 * uncaught error or an unreadable message is the engine's failure, reported
 * once.
 */
export const webWorkerEngineSpawner: EngineSpawner = {
  spawn: ({ version, bytes }) => {
    const engineUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "text/javascript" }));
    const bootstrapUrl = URL.createObjectURL(
      new Blob([`import { serve } from ${JSON.stringify(engineUrl)};\nserve(self);\n`], {
        type: "text/javascript",
      }),
    );
    const worker = new Worker(bootstrapUrl, {
      type: "module",
      name: version === undefined ? "bundled telo engine" : `telo ${version} engine`,
    });
    let terminated = false;
    let failure: string | undefined;
    const listeners: Array<(reason: string) => void> = [];
    const fail = (reason: string) => {
      if (terminated || failure !== undefined) return;
      failure = reason;
      for (const listener of listeners) listener(reason);
    };
    worker.addEventListener("error", (event) => {
      fail(event.message || "the engine's worker failed to load its module");
    });
    worker.addEventListener("messageerror", () => fail("a message from the engine could not be read"));
    return {
      port: {
        postMessage: (message) => worker.postMessage(message),
        addEventListener: (type, listener) => worker.addEventListener(type, (event) => listener({ data: event.data })),
      },
      onFailure: (listener) => {
        if (failure !== undefined) listener(failure);
        else listeners.push(listener);
      },
      terminate: () => {
        terminated = true;
        worker.terminate();
        URL.revokeObjectURL(bootstrapUrl);
        URL.revokeObjectURL(engineUrl);
      },
    };
  },
};
