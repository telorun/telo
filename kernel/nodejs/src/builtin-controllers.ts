import type { ControllerInstance } from "@telorun/sdk";

/**
 * The controllers this kernel implements itself, by the entry a definition
 * names in `controllers: [{ runtime: kernel, entry }]`. The kernel registers
 * every one at boot from this table, and its keys are what
 * `BUILTIN_CONTROLLER_ENTRIES` exports — so a reader asking which entries the
 * Node kernel hosts reads the registry itself, never a copy of it.
 *
 * The need types the kernel declares (`Telo.PublicUrl`, …) are not entries:
 * each is a kind served by the `Telo.NeedType` controller, registered per
 * definition at boot.
 */
const BUILTIN_CONTROLLERS: Readonly<Record<string, () => Promise<ControllerInstance>>> = {
  "Telo.Definition": () =>
    import("./controllers/resource-definition/resource-definition-controller.js"),
  "Telo.Abstract": () => import("./controllers/resource-definition/abstract-controller.js"),
  // A need type registers the kind its fulfilments are.
  "Telo.NeedType": () => import("./controllers/need/need-type-controller.js"),
  "Telo.Application": () => import("./controllers/module/module-controller.js"),
  "Telo.Library": () => import("./controllers/module/module-controller.js"),
  "Telo.Import": () => import("./controllers/module/import-controller.js"),
  // The mandatory sinks live in the kernel rather than in a standard-library
  // module: §16 requires every conforming runtime to implement both, so
  // shipping them as an installable module would make conformance depend on
  // whether that module happened to be installed.
  "Telo.ConsoleSink": () => import("./controllers/logging/console-sink-controller.js"),
  "Telo.FileSink": () => import("./controllers/logging/file-sink-controller.js"),
  // The trace sink every runtime can offer with no collector: spans as log
  // records, read wherever the logs already go.
  "Telo.LogTraceSink": () => import("./controllers/tracing/log-trace-sink-controller.js"),
  // Data shapes are a kernel concern for the same reason: every kind with an
  // invocation contract declares one, so `inputType:` must be writable without
  // first importing a module.
  "Telo.JsonSchema": () => import("./controllers/type/json-schema-controller.js"),
  // A function written in CEL, built in for the same reason: declaring one must
  // not require importing a module that provides the kind.
  "Telo.Function": () => import("./controllers/function/function-controller.js"),
};

/** Every controller entry this kernel registers at boot. */
export const BUILTIN_CONTROLLER_ENTRIES: readonly string[] = Object.freeze(
  Object.keys(BUILTIN_CONTROLLERS),
);

/** Each built-in controller, loaded, with the entry it is registered under. */
export async function loadBuiltinControllers(): Promise<Array<[string, ControllerInstance]>> {
  return Promise.all(
    Object.entries(BUILTIN_CONTROLLERS).map(
      async ([entry, load]): Promise<[string, ControllerInstance]> => [entry, await load()],
    ),
  );
}
