import type * as React from "react";
import { Link } from "react-router";

import { modulePagePath } from "@/module-ref";

/** A link to a module's page, or — for a ref with no page — the ref itself as
 *  monospace text. */
export function ModuleLink({
  moduleRef,
  className,
  title,
  children,
}: {
  moduleRef: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const path = modulePagePath(moduleRef);
  if (!path) return <code className="font-mono break-all">{moduleRef}</code>;
  return (
    <Link to={path} className={className} title={title}>
      {children}
    </Link>
  );
}
