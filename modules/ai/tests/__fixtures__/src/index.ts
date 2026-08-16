// Controller entry points. Each fixture kind's `controllers:` candidate selects
// one of these by PURL fragment, so the whole fixture module is one bundle —
// the same shape every module has.
export * as AiEchoController from "./ai-echo-controller.js";
export * as AiEchoImageController from "./ai-echo-image-controller.js";
export * as StreamCollectorController from "./stream-collector-controller.js";
