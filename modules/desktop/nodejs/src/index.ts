// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and the connection
// registry is one module scope.
export { Window } from "./window-controller.js";
export { Tray } from "./tray-controller.js";
export { ShowWindow } from "./show-window-controller.js";
export { Quit } from "./quit-controller.js";
