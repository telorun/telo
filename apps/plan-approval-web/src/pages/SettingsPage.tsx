import { reviewApi } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useLoad } from "@/lib/use-load";
import { ProductCard } from "@/settings/ProductCard";
import { RegisterProduct } from "@/settings/RegisterProduct";
import { ReposSection } from "@/settings/ReposSection";

export function SettingsPage() {
  const [loaded, reload] = useLoad(() => Promise.all([reviewApi.listProducts(), reviewApi.listRepos()]), []);
  if (loaded.status === "failed") return <ErrorNotice error={loaded.error} />;
  if (loaded.status === "loading") return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  const [{ products }, { repos }] = loaded.data;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Products & repositories</h1>
      {products.map((product) => (
        <ProductCard
          key={`${product.slug}:${product.name}:${product.deadline}:${product.webhookUrl}`}
          product={product}
          onSaved={reload}
        />
      ))}
      <RegisterProduct onRegistered={reload} />
      <ReposSection repos={repos} products={products} onRegistered={reload} />
    </div>
  );
}
