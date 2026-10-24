import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { resolveAccountsOrigin } from "./accounts-origin";
import { fetchProducts, type TeloProduct } from "./product-list";

let pageLoad: Promise<TeloProduct[] | null> | null = null;
let accountsOrigin: Promise<string> | null = null;

/** Where accounts is for this page load — also Studio's identity provider,
 *  the issuer a runner must trust for Studio to send it a sign-in. */
export function accountsOriginForThisPage(): Promise<string> {
  accountsOrigin ??= resolveAccountsOrigin({
    desktop: isTauri(),
    fetch: globalThis.fetch.bind(globalThis),
    buildTimeAccountsUrl: (import.meta.env as Record<string, string | undefined>)
      .VITE_TELO_ACCOUNTS_URL,
  });
  return accountsOrigin;
}

/** The product list, read once per page load. `null` on any failure. */
export function productsForThisPage(): Promise<TeloProduct[] | null> {
  pageLoad ??= (async () => fetchProducts(await accountsOriginForThisPage(), globalThis.fetch.bind(globalThis)))();
  return pageLoad;
}

/** The product list once read; `null` while reading and after a failure. */
export function useTeloProducts(): TeloProduct[] | null {
  const [products, setProducts] = useState<TeloProduct[] | null>(null);
  useEffect(() => {
    let live = true;
    void productsForThisPage().then((list) => {
      if (live) setProducts(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return products;
}
