import * as React from "react";
import { PackagePlus, Search } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RegisterModule } from "@/RegisterModule";
import { SearchModules } from "@/SearchModules";

export function App() {
  // Two views, no router — search deep-links via `?q=` (see SearchModules), which
  // is the only URL state worth carrying for a two-tab app.
  const [tab, setTab] = React.useState("find");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <span className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          Telo Hub
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          Find a module, on any host
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Federated discovery across every registered Telo module — the HTTP registry, OCI
          registries, and direct manifest URLs. Search matches on what a resource{" "}
          <em>does</em>, not just its name.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="find">
            <Search /> Find
          </TabsTrigger>
          <TabsTrigger value="register">
            <PackagePlus /> Register
          </TabsTrigger>
        </TabsList>

        <TabsContent value="find">
          <SearchModules />
        </TabsContent>
        {/* The form is a reading/typing surface — keep it narrow even though the
            search view spans the wider shell. */}
        <TabsContent value="register" className="max-w-2xl">
          <RegisterModule />
        </TabsContent>
      </Tabs>
    </main>
  );
}
