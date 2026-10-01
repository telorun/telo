import { Inbox, Server, Settings } from "lucide-react";
import type { ReactNode } from "react";

import { AuthorField } from "@/components/AuthorField";
import { AuthorProvider } from "@/lib/author-name";
import { cn } from "@/lib/class-names";
import { InboxPage } from "@/pages/InboxPage";
import { PlanPage } from "@/pages/PlanPage";
import { RunnerPage } from "@/pages/RunnerPage";
import { RunnersPage } from "@/pages/RunnersPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { AppLink, paths, useRoute, type Route } from "@/routing";

function NavLink({ href, active, icon, label }: { href: string; active: boolean; icon: ReactNode; label: string }) {
  return (
    <AppLink
      href={href}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-muted",
        active ? "font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </AppLink>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "inbox":
      return <InboxPage />;
    case "plan":
      return <PlanPage id={route.id} />;
    case "settings":
      return <SettingsPage />;
    case "runners":
      return <RunnersPage />;
    case "runner":
      return <RunnerPage name={route.runner} />;
    case "notFound":
      return <p className="text-muted-foreground">Nothing lives at {route.path}.</p>;
  }
}

export function App() {
  const route = useRoute();
  return (
    <AuthorProvider>
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2">
          <AppLink href={paths.inbox()} className="font-semibold">
            Plan approval
          </AppLink>
          <nav className="flex items-center gap-1">
            <NavLink
              href={paths.inbox()}
              active={route.name === "inbox" || route.name === "plan"}
              icon={<Inbox className="size-4" />}
              label="Inbox"
            />
            <NavLink
              href={paths.runners()}
              active={route.name === "runners" || route.name === "runner"}
              icon={<Server className="size-4" />}
              label="Runners"
            />
            <NavLink
              href={paths.settings()}
              active={route.name === "settings"}
              icon={<Settings className="size-4" />}
              label="Products & repos"
            />
          </nav>
          <div className="ml-auto">
            <AuthorField />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Page route={route} />
      </main>
    </AuthorProvider>
  );
}
