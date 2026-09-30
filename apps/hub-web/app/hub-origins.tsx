import * as React from "react";

/** The origins the server hands the page: where the browser calls the hub, and
 *  this site's own. Read from the root loader once per page load. */
export interface HubOrigins {
  browserApiOrigin: string;
  siteOrigin: string;
}

const HubOriginsContext = React.createContext<HubOrigins | null>(null);

export const HubOriginsProvider = HubOriginsContext.Provider;

export function useHubOrigins(): HubOrigins {
  const origins = React.useContext(HubOriginsContext);
  if (!origins) throw new Error("useHubOrigins outside the root layout's HubOriginsProvider");
  return origins;
}
