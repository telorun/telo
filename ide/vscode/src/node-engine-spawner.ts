import type { EngineSpawner } from "@telorun/language-host";
import { Worker } from "worker_threads";

/** Runs an engine in a `worker_threads` worker, adapting the worker's
 *  `parentPort` to the structural port the engine serves. The engine runs from
 *  the verified bytes themselves (a `data:` module), never from a path that
 *  could change between the check and the load. A module that throws while
 *  evaluating, an uncaught error, an unreadable message or an exit nobody asked
 *  for is the engine's failure, reported once. */
export const nodeEngineSpawner: EngineSpawner = {
  spawn: ({ bytes }) => {
    const engine = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
    const bootstrap = [
      `import { parentPort } from "node:worker_threads";`,
      `const { serve } = await import(${JSON.stringify(engine)});`,
      `serve({`,
      `  postMessage: (message) => parentPort.postMessage(message),`,
      `  addEventListener: (type, listener) => parentPort.on("message", (data) => listener({ data })),`,
      `});`,
    ].join("\n");
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`));
    let terminated = false;
    let failure: string | undefined;
    const listeners: Array<(reason: string) => void> = [];
    const fail = (reason: string) => {
      if (terminated || failure !== undefined) return;
      failure = reason;
      for (const listener of listeners) listener(reason);
    };
    worker.on("error", (error) => fail(error.stack ?? error.message));
    worker.on("messageerror", (error) => fail(`a message from the engine could not be read: ${error.message}`));
    worker.on("exit", (code) => fail(`the engine's worker exited with code ${code}`));
    return {
      port: {
        postMessage: (message) => worker.postMessage(message),
        addEventListener: (type, listener) => worker.on("message", (data) => listener({ data })),
      },
      onFailure: (listener) => {
        if (failure !== undefined) listener(failure);
        else listeners.push(listener);
      },
      terminate: () => {
        terminated = true;
        void worker.terminate();
      },
    };
  },
};
