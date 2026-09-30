import { createContext } from "react-router";

import { createHubReader, type HubReader } from "@/hub-reader.server";
import { settings, type Settings } from "@/settings.server";

export interface HubContext {
  settings: Settings;
  hub: HubReader;
}

/** The one context key loaders read the settings and the hub reader through;
 *  the root middleware sets it on every request. */
export const hubContext = createContext<HubContext>();

export const hubContextValue: HubContext = {
  settings,
  hub: createHubReader(settings.hubApiOrigin),
};
