import { Grip } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** One entry of accounts' `/v1/products`, already validated by
 *  `telo-products.server.ts`: only such values reach CSS and `<img src>`. */
export interface TeloProduct {
  id: string;
  /** The name after "Telo". */
  name: string;
  url: string;
  icon: string;
  color: { light: string; dark: string };
}

/** This site's id in the product list. */
const CURRENT_PRODUCT = "hub";

function nameClass(id: string): string {
  return `telo-product-${id}`;
}

/** Each product's hue as `--product-<id>`, for light and dark, and the class
 *  that colours its name with it. Kept out of `style` attributes so a CSP never
 *  has to allow inline styles. */
export function ProductColors({ products }: { products: TeloProduct[] }) {
  const light = products.map((p) => `--product-${p.id}:${p.color.light};`).join("");
  const dark = products.map((p) => `--product-${p.id}:${p.color.dark};`).join("");
  const names = products.map((p) => `.${nameClass(p.id)}{color:var(--product-${p.id})}`).join("");
  return <style dangerouslySetInnerHTML={{ __html: `:root{${light}}.dark{${dark}}${names}` }} />;
}

/** The menu of every Telo product, this one marked as current. */
export function ProductSwitcher({ products }: { products: TeloProduct[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="size-8 text-muted-foreground">
          <Grip />
          <span className="sr-only">Telo products</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {products.map((product) => {
          const current = product.id === CURRENT_PRODUCT;
          return (
            <DropdownMenuItem key={product.id} asChild>
              <a
                href={product.url}
                aria-current={current ? "true" : undefined}
                className={cn(current && "font-medium")}
              >
                <img src={product.icon} alt="" width={20} height={20} />
                <span>
                  Telo <span className={nameClass(product.id)}>{product.name}</span>
                </span>
              </a>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
