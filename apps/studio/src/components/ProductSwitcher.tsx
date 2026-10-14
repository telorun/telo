import { Grip } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTeloProducts } from "../products/page-products";
import {
  productColorRules,
  productNameClass,
  STUDIO_PRODUCT_ID,
  type TeloProduct,
} from "../products/product-list";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** The Telo products menu, from accounts' list. Nothing at all while the list
 *  is being read, after a failure, or when it is empty — Studio's own wordmark
 *  never depends on accounts. */
export function ProductSwitcher({ products }: { products: readonly TeloProduct[] | null }) {
  if (!products || products.length === 0) return null;
  return (
    <>
      <style>{productColorRules(products)}</style>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" title="Telo products">
            <Grip />
            <span className="sr-only">Telo products</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {products.map((product) => {
            const current = product.id === STUDIO_PRODUCT_ID;
            return (
              <DropdownMenuItem key={product.id} asChild>
                <a
                  href={product.url}
                  aria-current={current ? "true" : undefined}
                  className={cn("gap-2", current && "font-medium")}
                >
                  <img src={product.icon} alt="" width={20} height={20} />
                  <span>
                    Telo <span className={productNameClass(product.id)}>{product.name}</span>
                  </span>
                </a>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** `ProductSwitcher` over the list this page load read. */
export function TopBarProductSwitcher() {
  return <ProductSwitcher products={useTeloProducts()} />;
}
