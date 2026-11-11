// For a backend: the point interface the operations call and the guard they
// recognise a point by. Importing either is optional — a point is recognised by
// its methods, so a backend importing nothing from here is still a point.
export type {
  OfferOutcome,
  RendezvousPoint,
  TakeOutcome,
} from "./rendezvous-point-contract.js";
export { isRendezvousPoint } from "./rendezvous-point-contract.js";
export { ERR_RENDEZVOUS_AWAIT_TIMEOUT, ERR_RENDEZVOUS_KEY_BUSY } from "./await-controller.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle.
export * as Await from "./await-controller.js";
export * as Deliver from "./deliver-controller.js";
export * as MemoryPoint from "./memory-point-controller.js";
