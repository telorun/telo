export { isShellHost, toCommandSpec } from "./shell-host.js";
export type {
  ShellHost,
  ExecutionHandle,
  StreamPart,
  BufferedResult,
  CommandSpec,
  RunOptions,
} from "./shell-host.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as LocalHostController from "./local-host-controller.js";
export * as ShellCommandController from "./shell-command-controller.js";
export * as ShellCommandStreamController from "./shell-command-stream-controller.js";
