# Lead-intake API contract

A small HTTP service that takes in sales leads, derives fields from each, stores it and reads it back. Any implementation that meets this contract passes the contract tests in [`contract/`](./contract); the benchmarks compare implementations on that basis.

## Running

- The service listens on the port in the `PORT` environment variable.
- It keeps all state in a SQLite database inside the directory the `STATE_DIR` environment variable names (create the directory if it is missing). Every write goes to that database before the response is sent.
- When it starts with no lead stored it stores the lead `seed` (below). It stores nothing else of its own.
- Start-up must not need network access, a build step at run time or any other configuration.

All bodies are JSON. Responses carry `content-type: application/json` (or a JSON subtype such as `application/problem+json`).

## Endpoints

### `GET /ping`

`200` with `{ "status": "ok" }`. It does no work.

### `POST /leads/light`, `POST /leads/medium`, `POST /leads/heavy`

The three levels take the same body and differ only in how many fields they derive: light 5, medium 25 (light plus 20), heavy 80 (medium plus 55).

Request body — all members required, no others allowed:

| Member | Type |
| --- | --- |
| `email` | string, an e-mail address |
| `company.name` | string, at least 1 character |
| `company.employees` | integer, 0 or more (a string such as `"5"` is not an integer) |
| `company.country` | string, exactly 2 characters |
| `company.industry` | string, at least 1 character |
| `plan` | one of `free`, `trial`, `starter`, `growth`, `enterprise` |

A valid body is stored and answered `201` with the stored lead:

```json
{
  "id": "5e1eb4a8-e2c9-47bd-b398-a9d609fcb845",
  "level": "light",
  "lead": { "email": "...", "company": { "name": "...", "employees": 850, "country": "US", "industry": "saas" }, "plan": "growth" },
  "derived": { "domain": "...", "personal": false, "sizeBand": "mid", "planTier": 3, "score": 55 }
}
```

- `id` is a new UUID (lowercase, hyphenated) for every request.
- `level` is `light`, `medium` or `heavy` as called.
- `lead` is the request body as received.
- `derived` has exactly the fields of the level, with the values the rules below give.

An invalid body is answered `400`, stores nothing and has the error shape below with code `ERR_INPUT_INVALID`.

### `GET /leads/{id}`

`200` with the lead exactly as the `POST` answered it (or, for `seed`, as below); an unknown id is `404` with code `NOT_FOUND`.

### The seed lead

`GET /leads/seed` answers `200` with:

```json
{
  "id": "seed",
  "level": "light",
  "lead": { "email": "seed@example.com", "company": { "name": "Seed Co", "employees": 12, "country": "US", "industry": "saas" }, "plan": "starter" },
  "derived": { "domain": "example.com", "personal": false, "sizeBand": "smb", "planTier": 2, "score": 25 }
}
```

## Errors

Every error answer is a JSON object with a string member `code`: `ERR_INPUT_INVALID` for `400` and `NOT_FOUND` for `404`. Other members (a message, problem-details members) are allowed and not compared.

## Derived fields

Rules are written in CEL over the request's `email`, `name` (`company.name`), `employees`, `country`, `industry` and `plan`. `/` and `%` on integers truncate toward zero, `size(text)` counts characters (code points), `split` splits on every occurrence, `replace` replaces every occurrence, `lower` and `upper` change case, and a value is an integer, a string or a boolean exactly as the expression yields it. Each level has all the fields of the levels before it.

### Light — 5 fields

| Field | Rule |
| --- | --- |
| `domain` | `split(email, '@')[1]` |
| `personal` | `split(email, '@')[1] in ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']` |
| `sizeBand` | `employees > 1000 ? 'enterprise' : employees > 100 ? 'mid' : employees > 10 ? 'smb' : 'startup'` |
| `planTier` | `plan == 'enterprise' ? 4 : plan == 'growth' ? 3 : plan == 'starter' ? 2 : plan == 'trial' ? 1 : 0` |
| `score` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0)` |

### Medium — adds 20 fields

| Field | Rule |
| --- | --- |
| `corporateDomain` | `split(email, '@')[1].endsWith('.com') \|\| split(email, '@')[1].endsWith('.io') \|\| split(email, '@')[1].endsWith('.co')` |
| `region` | `country == 'US' \|\| country in ['CA', 'MX'] ? 'NA' : country in ['DE', 'FR', 'NL', 'UK', 'IE', 'ES', 'IT'] ? 'EU' : country in ['JP', 'SG', 'AU', 'IN'] ? 'APAC' : 'OTHER'` |
| `priorityCountry` | `country in ['US', 'DE', 'UK', 'JP', 'CA']` |
| `isB2B` | `industry in ['saas', 'fintech', 'enterprise', 'manufacturing']` |
| `paid` | `plan != 'free' && plan != 'trial'` |
| `isPremium` | `plan == 'enterprise' \|\| plan == 'growth'` |
| `validEmail` | `email.contains('@') && size(email) > 5` |
| `nameLength` | `size(name)` |
| `emailLocal` | `split(email, '@')[0]` |
| `geoScore` | `country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5` |
| `industryScore` | `industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5` |
| `employeesHundreds` | `employees / 100` |
| `isEnterprise` | `employees > 1000` |
| `isStartup` | `employees <= 10` |
| `slug` | `replace(lower(name), ' ', '-')` |
| `dotCount` | `size(split(email, '.')) - 1` |
| `tier` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) > 80 ? 'A' : (employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) > 50 ? 'B' : 'C'` |
| `summary` | `name + ' (' + (employees > 1000 ? 'enterprise' : employees > 100 ? 'mid' : employees > 10 ? 'smb' : 'startup') + ', ' + country + ') on ' + plan + ' plan'` |
| `emailLength` | `size(email)` |
| `hasPlus` | `email.contains('+')` |

### Heavy — adds 55 fields

| Field | Rule |
| --- | --- |
| `isUS` | `country == 'US'` |
| `isUK` | `country == 'UK'` |
| `isDE` | `country == 'DE'` |
| `isNorthAmerica` | `country == 'US' \|\| country in ['CA', 'MX']` |
| `isEurope` | `country in ['DE', 'FR', 'NL', 'UK', 'IE', 'ES', 'IT']` |
| `isApac` | `country in ['JP', 'SG', 'AU', 'IN']` |
| `isSaas` | `industry == 'saas'` |
| `isFintech` | `industry == 'fintech'` |
| `isEnterpriseIndustry` | `industry == 'enterprise'` |
| `isManufacturing` | `industry == 'manufacturing'` |
| `isRetail` | `industry == 'retail'` |
| `isHealthcare` | `industry == 'healthcare'` |
| `isFree` | `plan == 'free'` |
| `isTrial` | `plan == 'trial'` |
| `isStarter` | `plan == 'starter'` |
| `isGrowth` | `plan == 'growth'` |
| `isEnterprisePlan` | `plan == 'enterprise'` |
| `employeesOver10` | `employees > 10` |
| `employeesOver50` | `employees > 50` |
| `employeesOver100` | `employees > 100` |
| `employeesOver500` | `employees > 500` |
| `employeesOver1000` | `employees > 1000` |
| `employeesOver5000` | `employees > 5000` |
| `domainLength` | `size(split(email, '@')[1])` |
| `localLength` | `size(split(email, '@')[0])` |
| `domainHasHyphen` | `split(email, '@')[1].contains('-')` |
| `domainEndsWithOrg` | `split(email, '@')[1].endsWith('.org')` |
| `domainEndsWithIo` | `split(email, '@')[1].endsWith('.io')` |
| `domainEndsWithCom` | `split(email, '@')[1].endsWith('.com')` |
| `emailLower` | `lower(email)` |
| `emailIsLowercase` | `email == lower(email)` |
| `nameHasInc` | `name.contains('Inc')` |
| `nameHasCorp` | `name.contains('Corp')` |
| `nameWordCount` | `size(split(name, ' '))` |
| `nameFirstWord` | `split(name, ' ')[0]` |
| `nameUpper` | `upper(name)` |
| `nameIsLong` | `size(name) > 20` |
| `nameIsShort` | `size(name) < 4` |
| `companyPoints` | `employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5` |
| `planPoints` | `plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0` |
| `geoPoints` | `country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5` |
| `industryPoints` | `industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5` |
| `emailPoints` | `(email.contains('@') && size(email) > 5) ? 5 : 0` |
| `totalPoints` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) + (country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5) + (industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5) + ((email.contains('@') && size(email) > 5) ? 5 : 0)` |
| `scoreBand` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) + (country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5) + (industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5) + ((email.contains('@') && size(email) > 5) ? 5 : 0) > 100 ? 'hot' : (employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) + (country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5) + (industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5) + ((email.contains('@') && size(email) > 5) ? 5 : 0) > 60 ? 'warm' : 'cold'` |
| `needsReview` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) + (country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5) + (industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5) + ((email.contains('@') && size(email) > 5) ? 5 : 0) < 40` |
| `employeesHalf` | `employees / 2` |
| `employeesDoubled` | `employees * 2` |
| `employeesMod7` | `employees % 7` |
| `employeesTens` | `employees / 10` |
| `employeesIsEven` | `employees % 2 == 0` |
| `contactable` | `(email.contains('@') && size(email) > 5) && !(split(email, '@')[1] in ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'])` |
| `qualified` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) + (country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5) + (industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5) + ((email.contains('@') && size(email) > 5) ? 5 : 0) > 60 && plan != 'free' && plan != 'trial'` |
| `fastTrack` | `(employees > 1000 ? 50 : employees > 100 ? 30 : employees > 10 ? 15 : 5) + (plan == 'enterprise' ? 40 : plan == 'growth' ? 25 : plan == 'starter' ? 10 : 0) + (country == 'US' ? 20 : country in ['DE', 'FR', 'NL', 'UK', 'CA', 'AU'] ? 15 : 5) + (industry in ['saas', 'fintech', 'enterprise'] ? 15 : 5) + ((email.contains('@') && size(email) > 5) ? 5 : 0) > 100 && employees > 1000` |
| `sizeLabel` | `upper(employees > 1000 ? 'enterprise' : employees > 100 ? 'mid' : employees > 10 ? 'smb' : 'startup')` |


## Contract tests

[`contract/`](./contract) holds the cases as Telo manifest tests that call the implementation over HTTP; see [`README.md`](./README.md) for running them against any URL and for adding cases.
