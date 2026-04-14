# Telo Official Style Guide: Naming Conventions

Welcome to the Telo Style Guide! While the Telo engine is designed to be highly flexible, following a consistent naming convention ensures that your declarative manifests are readable, maintainable, and seamlessly integrate with the broader Telo module ecosystem.

More importantly, **how you name your resources directly affects how you write CEL (Common Expression Language) expressions.**

## 1. The Golden Rule of Telo Identifiers

To ensure CEL expressions evaluate correctly, **Resource names and Import aliases must not contain hyphens (`-`).** In CEL, a hyphen is evaluated as a mathematical subtraction operator. For example, if you name a resource `my-server`, the expression `${{ resources.my-server.url }}` will crash because the engine reads it as: `resources.my` _minus_ `server.url`.

**Technical Engine Constraint:**
All instance names (Resources and Imports) must match the following regex: `^[a-zA-Z_][a-zA-Z0-9_]*$` (Alphanumeric characters and underscores only; must start with a letter or underscore).

---

## 2. Recommended Naming Conventions

While the engine permits any valid alphanumeric string for instances, the official Telo modules (`std/*`) and documentation strictly adhere to the following stylistic rules. We highly recommend you do the same.

### 🟢 `PascalCase` for Instances (Resources & Imports)

Treat your declarative resources and imports as major architectural components (Logical IDs), similar to how AWS CloudFormation names its resources.

- **Do:** MainServer, UsersDb, ProdApi
- **Don't:** mainServer, users_db, prod-api
- **CEL Usage:** `${{ resources.MainServer.url }}`

### 🟢 `PascalCase` for Resource Types (`kind`)

Resource types represent the "Class" or "Blueprint" being instantiated. They should always be capitalized, including namespaces separated by dots.

- **Do:** `Http.Server`, `Db.Postgres`, `Import`, `Module`
- **Don't:** `http.server`, `db.Postgres`

### 🟢 `camelCase` for Properties (`variables`, `secrets`, `exports`)

Data inputs and outputs behave exactly like object properties in JSON/JavaScript.

- **Do:** `dbPassword`, `maxRetries`, `apiUrl`
- **Don't:** `DB_PASSWORD`, `max_retries`, `ApiUrl`
- **CEL Usage:** `${{ secrets.dbPassword }}`

### 🟢 `kebab-case` for Module Packages (`metadata.module`, `source`)

When naming a module that will be published to the registry, use standard URL-friendly formatting. This matches GitHub repositories and NPM packages.

- **Do:** `secure-api-template`, `http-server`, `my-awesome-app`
- **Don't:** `SecureApiTemplate`, `http_server`

---

## 3. Putting It All Together

Here is a perfect example of a Telo manifest utilizing the recommended style guide:

```yaml
# 1. Module Name: kebab-case
kind: Kernel.Module
metadata:
  name: my-awesome-app

# 2. Variables & Secrets: camelCase
secrets:
  - prodDbPassword

---
# 3. Resource Kind: PascalCase
kind: Kernel.Import
metadata:
  # 4. Instance Name (Alias): camelCase
  name: prodApi
  # Module reference: kebab-case
  module: my-awesome-app
# Source: kebab-case
source: digly/secure-api-template@v1.0.0
variables:
  listenPort: 8080
secrets:
  dbPassword: "${{ secrets.prodDbPassword }}"

---
kind: Logger.Stdout
metadata:
  name: appLogger
  module: my-awesome-app
# Notice how clean the CEL expression reads:
# object.property.subProperty -> resources.prodApi.apiUrl
message: "Production API is running at: ${{ resources.prodApi.apiUrl }}"
```
