import { Plus } from "lucide-react";
import * as React from "react";

import { reviewApi } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProductFields, productSettingsBody, type ProductSettings } from "@/settings/ProductFields";

const EMPTY: ProductSettings = { name: "", deadline: "", webhookUrl: "" };

export function RegisterProduct({ onRegistered }: { onRegistered: () => void }) {
  const [slug, setSlug] = React.useState("");
  const [settings, setSettings] = React.useState<ProductSettings>(EMPTY);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(undefined);

  const register = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await reviewApi.createProduct({ slug, ...productSettingsBody(settings) });
      setSlug("");
      setSettings(EMPTY);
      onRegistered();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Register a product</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-product-slug">Slug</Label>
            <Input id="new-product-slug" placeholder="acme" value={slug} maxLength={64} onChange={(e) => setSlug(e.target.value)} />
          </div>
          <ProductFields idPrefix="new-product" value={settings} onChange={setSettings} />
        </div>
        <Button className="self-start" disabled={busy || slug === "" || settings.name.trim() === ""} onClick={register}>
          <Plus />
          Register product
        </Button>
        {error !== undefined && <ErrorNotice error={error} />}
      </CardContent>
    </Card>
  );
}
