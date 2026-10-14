import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { TeloProduct } from "../products/product-list";
import { ProductSwitcher } from "./ProductSwitcher";

function product(id: string, name: string, light: string, dark: string): TeloProduct {
  return {
    id,
    name,
    url: `https://${id}.example.com/`,
    icon: `https://accounts.example.com/v1/products/${id}.0123456789abcdef.svg`,
    color: { light, dark },
  };
}

const PRODUCTS = [
  product("cloud", "Cloud", "oklch(0.53 0.1 175)", "oklch(0.74 0.12 175)"),
  product("hub", "Hub", "oklch(0.52 0.18 295)", "oklch(0.74 0.13 295)"),
  product("studio", "Studio", "oklch(0.52 0.18 260)", "oklch(0.707 0.123 260)"),
];

afterEach(() => cleanup());

describe("ProductSwitcher", () => {
  it("lists the products in order, each with its icon, linking to its home, Studio marked current", async () => {
    render(<ProductSwitcher products={PRODUCTS} />);
    await userEvent.click(screen.getByRole("button", { name: "Telo products" }));

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Telo Cloud", "Telo Hub", "Telo Studio"]);
    expect(items.map((item) => item.getAttribute("href"))).toEqual(PRODUCTS.map((p) => p.url));
    expect(items.map((item) => item.querySelector("img")?.getAttribute("src"))).toEqual(
      PRODUCTS.map((p) => p.icon),
    );
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, null, "true"]);
    expect(items[2]).toHaveClass("font-medium");
    expect(items[0]).not.toHaveClass("font-medium");
  });

  it("colours each name through its product's custom property, for both modes", async () => {
    const { container } = render(<ProductSwitcher products={PRODUCTS} />);
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain(":root{--product-cloud:oklch(0.53 0.1 175);");
    expect(css).toContain(".dark{--product-cloud:oklch(0.74 0.12 175);");
    expect(css).toContain(".telo-product-hub{color:var(--product-hub);}");

    await userEvent.click(screen.getByRole("button", { name: "Telo products" }));
    expect(await screen.findByText("Hub")).toHaveClass("telo-product-hub");
  });

  it.each([[null], [[]]])("renders nothing without a list (%j)", (products) => {
    const { container } = render(<ProductSwitcher products={products} />);
    expect(container).toBeEmptyDOMElement();
  });
});
