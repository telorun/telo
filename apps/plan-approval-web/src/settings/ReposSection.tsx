import { Plus } from "lucide-react";
import * as React from "react";

import { reviewApi, type Product, type Repo } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Registered repositories, and registration of a new one in at least one product. */
export function ReposSection({
  repos,
  products,
  onRegistered,
}: {
  repos: Repo[];
  products: Product[];
  onRegistered: () => void;
}) {
  const [slug, setSlug] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(undefined);

  const toggle = (product: string, on: boolean) =>
    setChosen((current) => (on ? [...current, product] : current.filter((p) => p !== product)));

  const register = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await reviewApi.createRepo({ slug, url, products: chosen });
      setSlug("");
      setUrl("");
      setChosen([]);
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
        <CardTitle>Repositories</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repository registered.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Remote URL</TableHead>
                <TableHead>Products</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map((repo) => (
                <TableRow key={repo.slug}>
                  <TableCell>{repo.slug}</TableCell>
                  <TableCell className="break-all whitespace-normal">{repo.url}</TableCell>
                  <TableCell>{repo.products.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-col gap-3 border-t pt-4">
          <h3 className="text-sm font-medium">Register a repository</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-repo-slug">Slug</Label>
              <Input id="new-repo-slug" placeholder="api" value={slug} maxLength={64} onChange={(e) => setSlug(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-repo-url">Remote URL</Label>
              <Input
                id="new-repo-url"
                placeholder="git@github.com:acme/api.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            {products.length === 0 && (
              <p className="text-sm text-muted-foreground">Register a product first: a repository belongs to at least one.</p>
            )}
            {products.map((product) => (
              <label key={product.slug} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={chosen.includes(product.slug)}
                  onCheckedChange={(checked) => toggle(product.slug, checked === true)}
                />
                {product.name}
              </label>
            ))}
          </div>
          <Button
            className="self-start"
            disabled={busy || slug === "" || url === "" || chosen.length === 0}
            onClick={register}
          >
            <Plus />
            Register repository
          </Button>
          {error !== undefined && <ErrorNotice error={error} />}
        </div>
      </CardContent>
    </Card>
  );
}
