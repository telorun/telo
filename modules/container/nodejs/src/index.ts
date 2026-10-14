// For an engine or a readiness kind: the contracts `Container.Instance` calls,
// and the guards it recognises them by. Importing any of this is optional — an
// implementation is recognised by its methods.
export type {
  ContainerEngine,
  ContainerLogOptions,
  ContainerReadiness,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  PortBinding,
  ReadinessTarget,
} from "./container-engine-contract.js";
export { isContainerEngine, isContainerReadiness } from "./container-engine-contract.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle.
export * as Instance from "./instance-controller.js";
export * as Port from "./port-controller.js";
export * as LogReady from "./log-ready-controller.js";
