import { createContext } from "react-router";

import { createHubReader, type HubReader } from "@/hub-reader.server";
import { settings, type Settings } from "@/settings.server";
import { createProductDirectory, type ProductDirectory } from "@/telo-products.server";

export interface HubContext {
  settings: Settings;
  hub: HubReader;
  /** Accounts' Telo product list, on the identity provider's origin. Null on a
   *  site with no identity provider, which shows no product switcher. */
  products: ProductDirectory | null;
}

/** The one context key loaders read the settings and the hub reader through;
 *  the root middleware sets it on every request. */
export const hubContext = createContext<HubContext>();

export const hubContextValue: HubContext = {
  settings,
  hub: createHubReader(settings.hubApiOrigin),
  products: settings.oidc ? createProductDirectory({ accountsOrigin: settings.oidc.issuer }) : null,
};
