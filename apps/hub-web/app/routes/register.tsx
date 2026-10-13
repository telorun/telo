import type { Route } from "./+types/register";
import { canonicalLink, REGISTER_DESCRIPTION, REGISTER_TITLE, shareTags } from "@/module-head";
import { RegisterModule } from "@/RegisterModule";

export const meta: Route.MetaFunction = ({ matches }) => {
  const { siteOrigin } = matches[0].loaderData;
  return [
    { title: REGISTER_TITLE },
    { name: "description", content: REGISTER_DESCRIPTION },
    canonicalLink(siteOrigin, "/register"),
    ...shareTags(siteOrigin, "/register", REGISTER_TITLE, REGISTER_DESCRIPTION),
  ];
};

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

export default function Register() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Register a module</h1>
      </header>
      <RegisterModule />
    </div>
  );
}
