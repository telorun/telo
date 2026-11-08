// Derived fields of each level, written flat as the Telo twin writes them, so the gap between levels is the cost of the added rules.
export type Lead = {
  email: string;
  company: { name: string; employees: number; country: string; industry: string };
  plan: string;
};

export type Derived = Record<string, string | number | boolean>;

export function light(lead: Lead): Derived {
  const e = lead.email;
  const n = lead.company.name;
  const k = lead.company.employees;
  const c = lead.company.country;
  const i = lead.company.industry;
  const p = lead.plan;
  return {
    domain: e.split('@')[1],
    personal: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'].includes(e.split('@')[1]),
    sizeBand: k > 1000 ? 'enterprise' : k > 100 ? 'mid' : k > 10 ? 'smb' : 'startup',
    planTier: p === 'enterprise' ? 4 : p === 'growth' ? 3 : p === 'starter' ? 2 : p === 'trial' ? 1 : 0,
    score: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0),
  };
}

export function medium(lead: Lead): Derived {
  const e = lead.email;
  const n = lead.company.name;
  const k = lead.company.employees;
  const c = lead.company.country;
  const i = lead.company.industry;
  const p = lead.plan;
  return {
    domain: e.split('@')[1],
    personal: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'].includes(e.split('@')[1]),
    sizeBand: k > 1000 ? 'enterprise' : k > 100 ? 'mid' : k > 10 ? 'smb' : 'startup',
    planTier: p === 'enterprise' ? 4 : p === 'growth' ? 3 : p === 'starter' ? 2 : p === 'trial' ? 1 : 0,
    score: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0),
    corporateDomain: e.split('@')[1].endsWith('.com') || e.split('@')[1].endsWith('.io') || e.split('@')[1].endsWith('.co'),
    region: c === 'US' || ['CA', 'MX'].includes(c) ? 'NA' : ['DE', 'FR', 'NL', 'UK', 'IE', 'ES', 'IT'].includes(c) ? 'EU' : ['JP', 'SG', 'AU', 'IN'].includes(c) ? 'APAC' : 'OTHER',
    priorityCountry: ['US', 'DE', 'UK', 'JP', 'CA'].includes(c),
    isB2B: ['saas', 'fintech', 'enterprise', 'manufacturing'].includes(i),
    paid: p !== 'free' && p !== 'trial',
    isPremium: p === 'enterprise' || p === 'growth',
    validEmail: e.includes('@') && [...e].length > 5,
    nameLength: [...n].length,
    emailLocal: e.split('@')[0],
    geoScore: c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5,
    industryScore: ['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5,
    employeesHundreds: Math.trunc(k / 100),
    isEnterprise: k > 1000,
    isStartup: k <= 10,
    slug: n.toLowerCase().replaceAll(' ', '-'),
    dotCount: e.split('.').length - 1,
    tier: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) > 80 ? 'A' : (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) > 50 ? 'B' : 'C',
    summary: n + ' (' + (k > 1000 ? 'enterprise' : k > 100 ? 'mid' : k > 10 ? 'smb' : 'startup') + ', ' + c + ') on ' + p + ' plan',
    emailLength: [...e].length,
    hasPlus: e.includes('+'),
  };
}

export function heavy(lead: Lead): Derived {
  const e = lead.email;
  const n = lead.company.name;
  const k = lead.company.employees;
  const c = lead.company.country;
  const i = lead.company.industry;
  const p = lead.plan;
  return {
    domain: e.split('@')[1],
    personal: ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'].includes(e.split('@')[1]),
    sizeBand: k > 1000 ? 'enterprise' : k > 100 ? 'mid' : k > 10 ? 'smb' : 'startup',
    planTier: p === 'enterprise' ? 4 : p === 'growth' ? 3 : p === 'starter' ? 2 : p === 'trial' ? 1 : 0,
    score: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0),
    corporateDomain: e.split('@')[1].endsWith('.com') || e.split('@')[1].endsWith('.io') || e.split('@')[1].endsWith('.co'),
    region: c === 'US' || ['CA', 'MX'].includes(c) ? 'NA' : ['DE', 'FR', 'NL', 'UK', 'IE', 'ES', 'IT'].includes(c) ? 'EU' : ['JP', 'SG', 'AU', 'IN'].includes(c) ? 'APAC' : 'OTHER',
    priorityCountry: ['US', 'DE', 'UK', 'JP', 'CA'].includes(c),
    isB2B: ['saas', 'fintech', 'enterprise', 'manufacturing'].includes(i),
    paid: p !== 'free' && p !== 'trial',
    isPremium: p === 'enterprise' || p === 'growth',
    validEmail: e.includes('@') && [...e].length > 5,
    nameLength: [...n].length,
    emailLocal: e.split('@')[0],
    geoScore: c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5,
    industryScore: ['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5,
    employeesHundreds: Math.trunc(k / 100),
    isEnterprise: k > 1000,
    isStartup: k <= 10,
    slug: n.toLowerCase().replaceAll(' ', '-'),
    dotCount: e.split('.').length - 1,
    tier: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) > 80 ? 'A' : (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) > 50 ? 'B' : 'C',
    summary: n + ' (' + (k > 1000 ? 'enterprise' : k > 100 ? 'mid' : k > 10 ? 'smb' : 'startup') + ', ' + c + ') on ' + p + ' plan',
    emailLength: [...e].length,
    hasPlus: e.includes('+'),
    isUS: c === 'US',
    isUK: c === 'UK',
    isDE: c === 'DE',
    isNorthAmerica: c === 'US' || ['CA', 'MX'].includes(c),
    isEurope: ['DE', 'FR', 'NL', 'UK', 'IE', 'ES', 'IT'].includes(c),
    isApac: ['JP', 'SG', 'AU', 'IN'].includes(c),
    isSaas: i === 'saas',
    isFintech: i === 'fintech',
    isEnterpriseIndustry: i === 'enterprise',
    isManufacturing: i === 'manufacturing',
    isRetail: i === 'retail',
    isHealthcare: i === 'healthcare',
    isFree: p === 'free',
    isTrial: p === 'trial',
    isStarter: p === 'starter',
    isGrowth: p === 'growth',
    isEnterprisePlan: p === 'enterprise',
    employeesOver10: k > 10,
    employeesOver50: k > 50,
    employeesOver100: k > 100,
    employeesOver500: k > 500,
    employeesOver1000: k > 1000,
    employeesOver5000: k > 5000,
    domainLength: [...e.split('@')[1]].length,
    localLength: [...e.split('@')[0]].length,
    domainHasHyphen: e.split('@')[1].includes('-'),
    domainEndsWithOrg: e.split('@')[1].endsWith('.org'),
    domainEndsWithIo: e.split('@')[1].endsWith('.io'),
    domainEndsWithCom: e.split('@')[1].endsWith('.com'),
    emailLower: e.toLowerCase(),
    emailIsLowercase: e === e.toLowerCase(),
    nameHasInc: n.includes('Inc'),
    nameHasCorp: n.includes('Corp'),
    nameWordCount: n.split(' ').length,
    nameFirstWord: n.split(' ')[0],
    nameUpper: n.toUpperCase(),
    nameIsLong: [...n].length > 20,
    nameIsShort: [...n].length < 4,
    companyPoints: k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5,
    planPoints: p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0,
    geoPoints: c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5,
    industryPoints: ['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5,
    emailPoints: e.includes('@') && [...e].length > 5 ? 5 : 0,
    totalPoints: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) + (c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5) + (['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5) + (e.includes('@') && [...e].length > 5 ? 5 : 0),
    scoreBand: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) + (c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5) + (['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5) + (e.includes('@') && [...e].length > 5 ? 5 : 0) > 100 ? 'hot' : (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) + (c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5) + (['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5) + (e.includes('@') && [...e].length > 5 ? 5 : 0) > 60 ? 'warm' : 'cold',
    needsReview: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) + (c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5) + (['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5) + (e.includes('@') && [...e].length > 5 ? 5 : 0) < 40,
    employeesHalf: Math.trunc(k / 2),
    employeesDoubled: k * 2,
    employeesMod7: k % 7,
    employeesTens: Math.trunc(k / 10),
    employeesIsEven: k % 2 === 0,
    contactable: (e.includes('@') && [...e].length > 5) && !(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'].includes(e.split('@')[1])),
    qualified: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) + (c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5) + (['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5) + (e.includes('@') && [...e].length > 5 ? 5 : 0) > 60 && p !== 'free' && p !== 'trial',
    fastTrack: (k > 1000 ? 50 : k > 100 ? 30 : k > 10 ? 15 : 5) + (p === 'enterprise' ? 40 : p === 'growth' ? 25 : p === 'starter' ? 10 : 0) + (c === 'US' ? 20 : ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'].includes(c) ? 15 : 5) + (['saas', 'fintech', 'enterprise'].includes(i) ? 15 : 5) + (e.includes('@') && [...e].length > 5 ? 5 : 0) > 100 && k > 1000,
    sizeLabel: (k > 1000 ? 'enterprise' : k > 100 ? 'mid' : k > 10 ? 'smb' : 'startup').toUpperCase(),
  };
}
