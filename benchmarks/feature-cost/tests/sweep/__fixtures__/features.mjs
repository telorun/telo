// Two features for the sweep test: one boots at every size, one stops exiting once n reaches 4
// (a server that never ends), so the sweep must record its limit and carry on.
import { application, doneStep, main, rootFromApp, runImport } from "../../../features.mjs";

export const FEATURES = [
  {
    name: "hangsAtFour",
    sizes: "count",
    generate: (n) => ({
      "telo.yaml":
        n < 4
          ? application("HangsAtFour", { imports: runImport }) + main(doneStep)
          : application("HangsAtFour", { imports: { Http: `${rootFromApp}modules/http-server` }, targets: ["!ref server"] }) +
            "---\nkind: Http.Server\nmetadata: { name: server }\nlisten: { port: 18897 }\n",
    }),
  },
  {
    name: "steady",
    sizes: "count",
    generate: () => ({ "telo.yaml": application("Steady", { imports: runImport }) + main(doneStep) }),
  },
];
