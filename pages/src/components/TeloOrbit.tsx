import Link from "@docusaurus/Link";
import {
  AppWindow,
  Ban,
  BookOpen,
  CheckCheck,
  Database,
  EyeOff,
  Globe,
  Hourglass,
  Inbox,
  KeyRound,
  Languages,
  Layers,
  Lock,
  MessagesSquare,
  Package,
  Power,
  RefreshCw,
  Repeat1,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

type Planet = { label: string; icon: LucideIcon; section: string };
type Ring = { name: "inner" | "middle" | "outer"; offset: number; planets: Planet[] };

// Each planet links to its section of the benefits ledger.
const rings: Ring[] = [
  {
    name: "inner",
    offset: 20,
    planets: [
      { label: "request cancellation", icon: Ban, section: "running" },
      { label: "graceful shutdown", icon: Power, section: "running" },
      { label: "safe retries", icon: RefreshCw, section: "running" },
      { label: "timeouts that cancel", icon: Timer, section: "running" },
      { label: "validation on every call", icon: ShieldCheck, section: "running" },
    ],
  },
  {
    name: "middle",
    offset: 0,
    planets: [
      { label: "checked before it runs", icon: CheckCheck, section: "checked-before-it-runs" },
      { label: "tracing", icon: Waypoints, section: "observability-and-security" },
      { label: "structured logging", icon: ScrollText, section: "observability-and-security" },
      { label: "secret redaction", icon: EyeOff, section: "observability-and-security" },
      { label: "public share links", icon: Globe, section: "running" },
      { label: "one executable", icon: Package, section: "delivery" },
      { label: "desktop apps", icon: AppWindow, section: "delivery" },
      { label: "vulnerability audit", icon: ShieldAlert, section: "observability-and-security" },
    ],
  },
  {
    name: "outer",
    offset: 10,
    planets: [
      { label: "durable execution", icon: Hourglass, section: "durable-execution" },
      { label: "background jobs", icon: Layers, section: "background-jobs" },
      { label: "transactional outbox", icon: Inbox, section: "background-jobs" },
      { label: "idempotency keys", icon: Repeat1, section: "background-jobs" },
      { label: "distributed locks", icon: Lock, section: "coordination" },
      { label: "schema migrations", icon: Database, section: "sql" },
      { label: "rotating JWT keys", icon: KeyRound, section: "security" },
      { label: "OpenAPI docs", icon: BookOpen, section: "http-server" },
      { label: "resumable AI chat", icon: MessagesSquare, section: "ai" },
      { label: "translations", icon: Languages, section: "translation" },
    ],
  },
];

// The order planets fly in during the assembly: alternating rings, inner first.
const arrivalOrder = new Map<string, number>(
  rings
    .flatMap((ring, r) => ring.planets.map((p, i) => [p.label, i * rings.length + r] as const))
    .sort(([, a], [, b]) => a - b)
    .map(([label], n) => [label, n]),
);

/** The hero's logo and title as a sun, with Telo's built-in features orbiting it. */
export default function TeloOrbit({ children }: { children: ReactNode }) {
  return (
    <div className="orbitStage">
      {rings.map((ring) => (
        <div key={ring.name} className={`orbitRing orbitRing--${ring.name}`} aria-hidden>
          <div className="orbitPath" />
          {ring.planets.map((planet, i) => {
            const Icon = planet.icon;
            const style = {
              "--start": `${ring.offset + (360 / ring.planets.length) * i}deg`,
              "--arrival": arrivalOrder.get(planet.label),
            } as CSSProperties;
            return (
              <Link
                key={planet.label}
                className="orbitPlanet"
                style={style}
                to={`/learn/what-you-get#${planet.section}`}
                tabIndex={-1}
              >
                <span className="orbitPlanetBody">
                  <Icon size={14} aria-hidden />
                  {planet.label}
                </span>
              </Link>
            );
          })}
        </div>
      ))}
      <div className="orbitSun">{children}</div>
    </div>
  );
}
