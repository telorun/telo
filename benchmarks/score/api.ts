import Fastify from "fastify";

// Mirrors benchmarks/score/api.yaml: same field set, same formulas, same
// response shape — so native vs Telo measures the orchestration + CEL cost,
// not algorithmic differences.

type Event = { type: string; ts?: string; score?: number; tags?: string[] };
type Lead = {
  email: string;
  company: { name: string; employees: number; country: string; industry: string; founded: number };
  plan: string;
  signupDate?: string;
  events: Event[];
  attrs: { source: string; utm?: { campaign?: string; medium?: string } };
};

const NA_ALT = ["CA", "MX"];
const EU = ["DE", "FR", "NL", "UK", "IE", "ES", "IT"];
const APAC = ["JP", "SG", "AU", "IN"];
const PRIORITY = ["US", "DE", "UK", "JP", "CA"];
const PERSONAL_DOMAINS = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"]);
const B2B_INDUSTRIES = new Set(["saas", "fintech", "enterprise", "manufacturing"]);
const SCORING_INDUSTRIES = new Set(["saas", "fintech", "enterprise"]);
const ORGANIC = new Set(["organic", "direct", "referral"]);
const PAID = new Set(["ppc", "sem", "social", "display"]);
const GEO_15 = new Set(["DE", "FR", "NL", "UK", "CA", "AU"]);
const INTENT_TYPES = new Set(["demo_request", "pricing_view", "contact_sales"]);

function regionOf(country: string): string {
  if (country === "US" || NA_ALT.includes(country)) return "NA";
  if (EU.includes(country)) return "EU";
  if (APAC.includes(country)) return "APAC";
  return "OTHER";
}

function sizeBand(employees: number): string {
  if (employees > 1000) return "enterprise";
  if (employees > 100) return "mid";
  if (employees > 10) return "smb";
  return "startup";
}

function planTier(plan: string): number {
  if (plan === "enterprise") return 4;
  if (plan === "growth") return 3;
  if (plan === "starter") return 2;
  if (plan === "trial") return 1;
  return 0;
}

function companyScore(employees: number): number {
  if (employees > 1000) return 50;
  if (employees > 100) return 30;
  if (employees > 10) return 15;
  return 5;
}

function planScore(plan: string): number {
  if (plan === "enterprise") return 40;
  if (plan === "growth") return 25;
  if (plan === "starter") return 10;
  return 0;
}

function geoScore(country: string): number {
  if (country === "US") return 20;
  if (GEO_15.has(country)) return 15;
  return 5;
}

function score(lead: Lead, intentCount: number, eventCount: number, validEmail: boolean): number {
  return (
    companyScore(lead.company.employees) +
    eventCount * 3 +
    intentCount * 10 +
    planScore(lead.plan) +
    geoScore(lead.company.country) +
    (ORGANIC.has(lead.attrs.source) ? 10 : 5) +
    (SCORING_INDUSTRIES.has(lead.company.industry) ? 15 : 5) +
    (validEmail ? 5 : 0)
  );
}

const app = Fastify({ logger: false });

app.post<{ Body: { lead: Lead } }>(
  "/v1/score",
  {
    schema: {
      body: {
        type: "object",
        required: ["lead"],
        properties: { lead: { type: "object" } },
      },
    },
  },
  (request, reply) => {
    const lead = request.body.lead;
    const email = lead.email;
    const domain = email.split("@")[1] ?? "";
    const validEmail = email.includes("@") && email.length > 5;
    const companyAge = 2026 - lead.company.founded;
    const eventCount = lead.events.length;
    const eventTypes = lead.events.map((e) => e.type);
    // Predicates kept in lock-step with api.yaml — same multi-clause shape so
    // the per-iteration JS work mirrors the per-iteration CEL work.
    const demoCount = lead.events.filter(
      (e) => e.type === "demo_request" && e.ts !== undefined && e.ts.startsWith("2026") && (e.score ?? 0) > 30,
    ).length;
    const pricingCount = lead.events.filter(
      (e) => e.type === "pricing_view" && e.ts !== undefined && (e.score ?? 0) > 20 && (e.tags?.length ?? 0) > 0,
    ).length;
    const contactCount = lead.events.filter((e) => e.type === "contact_sales" && (e.score ?? 0) > 10).length;
    const intentCount = lead.events.filter(
      (e) => INTENT_TYPES.has(e.type) && (e.score ?? 0) > 25 && e.ts !== undefined && e.ts.startsWith("2026"),
    ).length;
    const hasIntent = lead.events.some((e) => INTENT_TYPES.has(e.type) && (e.score ?? 0) > 50);
    const allEventsValid = lead.events.every(
      (e) =>
        typeof e.type === "string" &&
        e.type.length > 0 &&
        e.ts !== undefined &&
        e.ts.length > 10,
    );
    // Tag-membership checks via flat `includes` (mirrors api.yaml's `'tag' in e.tags`
    // form, kept flat to match the cel-vm-compatible expression shape).
    const priorityCount = lead.events.filter(
      (e) => (e.tags ?? []).includes("priority") || (e.tags ?? []).includes("high") || (e.tags ?? []).includes("enterprise"),
    ).length;
    const engagedCount = lead.events.filter(
      (e) => (e.tags ?? []).includes("engaged") || (e.tags ?? []).includes("returning"),
    ).length;
    const hasEnterpriseTag = lead.events.some((e) => (e.tags ?? []).includes("enterprise"));
    const scoredEvents = lead.events.map((e) => e.score ?? 0).filter((s) => s > 0);
    const highScoreCount = lead.events.filter((e) => (e.score ?? 0) > 50).length;
    const tagDiversity = lead.events.map((e) => e.tags ?? []).filter((ts) => ts.length > 1).length;
    const total = score(lead, intentCount, eventCount, validEmail);

    reply.send({
      lead: {
        email,
        domain,
        validEmail,
        corporateDomain: domain.endsWith(".com") || domain.endsWith(".io") || domain.endsWith(".co"),
        personal: PERSONAL_DOMAINS.has(domain),
      },
      company: {
        name: lead.company.name,
        employees: lead.company.employees,
        sizeBand: sizeBand(lead.company.employees),
        ageYears: companyAge,
        established: companyAge > 5,
        new: companyAge <= 2,
        country: lead.company.country,
        region: regionOf(lead.company.country),
        priorityCountry: PRIORITY.includes(lead.company.country),
        industry: lead.company.industry,
        isB2B: B2B_INDUSTRIES.has(lead.company.industry),
      },
      events: {
        total: eventCount,
        demos: demoCount,
        pricing: pricingCount,
        contact: contactCount,
        intent: intentCount,
        types: eventTypes,
        hasIntent,
        allValid: allEventsValid,
        engaged: eventCount > 5,
        veryEngaged: eventCount > 15,
        highVolume: eventCount > 50,
        intentRatio: eventCount > 0 ? intentCount / eventCount : 0,
        priorityCount,
        engagedCount,
        hasEnterpriseTag,
        highScoreCount,
        tagDiversity,
        scoredEvents,
        qualityRatio: eventCount > 0 ? highScoreCount / eventCount : 0,
        priorityRatio: eventCount > 0 ? priorityCount / eventCount : 0,
      },
      plan: {
        current: lead.plan,
        paid: lead.plan !== "free" && lead.plan !== "trial",
        tier: planTier(lead.plan),
        isPremium: lead.plan === "enterprise" || lead.plan === "growth",
      },
      attrs: {
        source: lead.attrs.source,
        organic: ORGANIC.has(lead.attrs.source),
        paid: PAID.has(lead.attrs.source),
        hasUtm: lead.attrs.utm !== undefined && lead.attrs.utm !== null,
        utmCampaign: lead.attrs.utm?.campaign ?? "none",
      },
      score: {
        company: companyScore(lead.company.employees),
        engagement: eventCount * 3 + intentCount * 10,
        plan: planScore(lead.plan),
        geo: geoScore(lead.company.country),
        source: ORGANIC.has(lead.attrs.source) ? 10 : 5,
        industry: SCORING_INDUSTRIES.has(lead.company.industry) ? 15 : 5,
        email: validEmail ? 5 : 0,
        total,
      },
      tier: total > 120 ? "A" : total > 80 ? "B" : "C",
      summary: `${lead.company.name} (${
        lead.company.employees > 1000 ? "enterprise" : lead.company.employees > 100 ? "mid" : "small"
      }, ${lead.company.country}) — ${eventCount} events on ${lead.plan} plan`,
    });
  },
);

await app.listen({ port: 8845 });
