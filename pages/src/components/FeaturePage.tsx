import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import type { ReactNode } from "react";

export interface FeaturePoint {
  icon: string;
  title: string;
  body: ReactNode;
  /** Mark a feature that is on the roadmap but not yet available. */
  planned?: boolean;
}

// Ordered carousel of the "Designed to be" pages. The hero arrows cycle
// through this list, so each page knows its siblings by its own slug.
const FEATURE_PAGES: { slug: string; title: string }[] = [
  { slug: "/developer-first", title: "Developer first" },
  { slug: "/business-first", title: "Business first" },
  { slug: "/ai-first", title: "AI first" },
];

export interface FeaturePageProps {
  slug: string;
  emoji: string;
  title: string;
  tagline: string;
  intro: ReactNode;
  points: FeaturePoint[];
}

export default function FeaturePage({ slug, emoji, title, tagline, intro, points }: FeaturePageProps) {
  const index = FEATURE_PAGES.findIndex((page) => page.slug === slug);
  const count = FEATURE_PAGES.length;
  const prev = FEATURE_PAGES[(index - 1 + count) % count];
  const next = FEATURE_PAGES[(index + 1) % count];

  return (
    <Layout title={title} description={tagline}>
      <Head>
        <title>{`${title} - Telo`}</title>
      </Head>
      <header className="hero heroBanner">
        <div className="container featureHero">
          <Link className="featureHeroNav" to={prev.slug} aria-label={`Previous: ${prev.title}`}>
            <span className="featureHeroArrow">
              <ChevronLeft size={32} aria-hidden />
            </span>
            <span className="featureHeroNavLabel">{prev.title}</span>
          </Link>
          <div className="text--center">
            <div style={{ fontSize: "3.5rem", lineHeight: 1 }} aria-hidden>
              {emoji}
            </div>
            <h1 className="hero__title margin-top--sm">{title}</h1>
            <p className="hero__subtitle margin-bottom--none">{tagline}</p>
          </div>
          <Link className="featureHeroNav" to={next.slug} aria-label={`Next: ${next.title}`}>
            <span className="featureHeroArrow">
              <ChevronRight size={32} aria-hidden />
            </span>
            <span className="featureHeroNavLabel">{next.title}</span>
          </Link>
        </div>
      </header>

      <main className="container margin-vert--xl">
        <p>{intro}</p>

        <div className="row margin-top--lg">
          {points.map((point) => (
            <div key={point.title} className="col col--6 margin-bottom--md">
              <div className="card">
                <div className="card__header text--center">
                  <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                    {point.icon}
                  </div>
                  <h3 className="margin-top--sm margin-bottom--none">{point.title}</h3>
                  {point.planned && (
                    <span className="badge badge--secondary featurePlannedBadge">
                      <Clock size={13} aria-hidden />
                      Planned
                    </span>
                  )}
                </div>
                <div className="card__body">{point.body}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="text--center margin-top--xl">
          <Link className="button button--primary button--lg margin-right--md" to="/learn/getting-started">
            Get started
          </Link>
          <Link className="button button--outline button--primary button--lg" to="/">
            Back to home
          </Link>
        </div>
      </main>
    </Layout>
  );
}
