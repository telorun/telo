import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { resolveAccountsOrigin } from "./accounts-origin";
import { fetchProducts, type TeloProduct } from "./product-list";

let pageLoad: Promise<TeloProduct[] | null> | null = null;

/** The product list, read once per page load. `null` on any failure. */
export function productsForThisPage(): Promise<TeloProduct[] | null> {
  pageLoad ??= (async () => {
    const fetchImpl = globalThis.fetch.bind(globalThis);
    const accountsOrigin = await resolveAccountsOrigin({
      desktop: isTauri(),
      fetch: fetchImpl,
      buildTimeAccountsUrl: (import.meta.env as Record<string, string | undefined>)
        .VITE_TELO_ACCOUNTS_URL,
    });
    return fetchProducts(accountsOrigin, fetchImpl);
  })();
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
