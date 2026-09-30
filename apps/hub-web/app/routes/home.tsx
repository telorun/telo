import * as React from "react";
import { PackagePlus, Search } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/home";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { canonicalLink, HOME_DESCRIPTION, HOME_TITLE } from "@/module-head";
import { RegisterModule } from "@/RegisterModule";
import { SearchModules } from "@/SearchModules";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: HOME_TITLE },
  { name: "description", content: HOME_DESCRIPTION },
  canonicalLink(matches[0].loaderData.siteOrigin, "/"),
];

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

export default function Home() {
  const [tab, setTab] = React.useState("find");

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link
          to="/"
          className="self-start text-sm font-medium tracking-wide text-muted-foreground uppercase"
        >
          Telo Hub
        </Link>
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
    </>
  );
}
