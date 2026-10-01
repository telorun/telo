import { Download, Save } from "lucide-react";
import * as React from "react";

import { historyUrl, reviewApi, type Product } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTimestamp } from "@/lib/time-format";
import { AppLink, paths } from "@/routing";
import { ProductFields, productSettingsBody, type ProductSettings } from "@/settings/ProductFields";

/** One product: its settings (a full replacement on save) and its latest webhook deliveries. */
export function ProductCard({ product, onSaved }: { product: Product; onSaved: () => void }) {
  const [settings, setSettings] = React.useState<ProductSettings>({
    name: product.name,
    deadline: product.deadline ?? "",
    webhookUrl: product.webhookUrl ?? "",
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(undefined);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await reviewApi.updateProduct(product.slug, productSettingsBody(settings));
      onSaved();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{product.name}</CardTitle>
        <CardDescription>
          {product.slug} · {product.pendingDeliveries} webhook deliveries pending
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" asChild>
            <a href={historyUrl.product(product.slug)} target="_blank" rel="noopener">
              <Download />
              History (JSON)
            </a>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-3">
          <ProductFields idPrefix={`product-${product.slug}`} value={settings} onChange={setSettings} />
        </div>
        <Button className="self-start" disabled={busy || settings.name.trim() === ""} onClick={save}>
          <Save />
          Save settings
        </Button>
        {error !== undefined && <ErrorNotice error={error} />}
        <div>
          <h3 className="mb-2 text-sm font-medium">Latest webhook deliveries</h3>
          {product.deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No delivery attempted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.deliveries.map((delivery) => (
                  <TableRow key={`${delivery.outboxId}:${delivery.attempt}`}>
                    <TableCell>{formatTimestamp(delivery.at)}</TableCell>
                    <TableCell>{delivery.event}</TableCell>
                    <TableCell>
                      <AppLink href={paths.plan(delivery.planId)} className="hover:underline">
                        {delivery.planId.slice(0, 8)}
                      </AppLink>
                    </TableCell>
                    <TableCell>{delivery.attempt}</TableCell>
                    <TableCell>{delivery.status ?? "—"}</TableCell>
                    <TableCell className="whitespace-normal text-destructive">{delivery.error ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
