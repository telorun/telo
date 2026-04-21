---
description: "v1.0 CEL-YAML templating spec: $let, $if, $for, $eval, $include directives for compile-time manifest generation"
---

# CEL-YAML Templating Specification (v1.0)

## 1. Core Principles

1. **Directives are Reserved:** All keys starting with `$` are engine instructions. All other keys are treated as data.
2. **Top-Down Evaluation:** The engine traverses the YAML tree from root to leaves.
3. **Scoped Environments:** Variables are stored in a stack. Child nodes inherit the parent's environment.
4. **`${{ }}` is Runtime-Only:** The `${{ }}` interpolation syntax in regular data values is **never** processed by the compile engine — it passes through untouched for runtime expression resolution.
5. **Explicit Compile-Time Evaluation:** Use the `$eval` directive to explicitly evaluate `${{ }}` expressions at compile time.
6. **Order of Operations:** In any YAML Mapping (object), directives are processed in strict priority order:
   1. `$let` (Context Expansion)
   2. `$assert` (Validation)
   3. `$if` (Conditional Logic)
   4. `$for` (Iteration)
   5. `$eval` (Compile-Time Evaluation)
   6. `$key`/`$value` (Dynamic Key-Value Pairs)
   7. `$include` (Composition)
   8. **Regular Keys** (Data Passthrough)

---

## 2. Compile-Time Evaluation (`$eval`)

The `$eval` directive explicitly marks a value for compile-time CEL evaluation. It uses the same `${{ }}` syntax as runtime expressions, but wrapped in `$eval` to opt-in to compile-time resolution.

```yaml
# Compile-time evaluation (explicit):
endpoint:
  $eval: "${{ base_url }}/users"

# Runtime expression (passes through untouched):
handler: "${{ request.path }}"
```

- **Exact match:** When the entire `$eval` string is a single `${{ expr }}`, the result preserves the expression's type (number, boolean, etc.).
- **Mixed string:** When `${{ }}` appears alongside literal text, all interpolations are stringified and concatenated.

---

## 3. Directives Reference

### 3.1. Context Definition (`$let`)

Defines variables scoped to the **current object** (siblings) and **all descendants**.

- **Syntax:** Map of `variable_name: cel_expression`.
- **Behavior:** Evaluated before any other key in the same map.
- **Scope:** Variables defined here shadow global/parent variables of the same name.
- **Values:** Can be bare CEL expressions, quoted strings, or `$eval` objects.

```yaml
server:
  $let:
    cpu_request: "'250m'"
    is_prod: "env == 'production'"
    full_name:
      $eval: "${{ svc.name }}-${{ region }}"

  resources:
    limits:
      cpu:
        $eval: "${{ cpu_request }}"

  metadata:
    annotations:
      production:
        $eval: "${{ is_prod }}"
```

### 3.2. Conditionals (`$if` / `$then` / `$else`)

Conditionally includes or excludes a block.

- **Syntax:**
  - `$if`: CEL expression (must evaluate to Boolean).
  - `$then`: Object/Value to render if true.
  - `$else`: (Optional) Object/Value to render if false.
- **Behavior:** The result of the block replaces the parent key's value.

```yaml
database:
  $if: "enable_persistence"
  $then:
    type: "postgres"
    storage: "100gi"
  $else:
    type: "sqlite"
    storage: "0"
```

### 3.3. Iteration (`$for` / `$do`)

Generates lists or maps by iterating over a collection.

- **Syntax:**
  - `$for`: String iterator format.
    - List: `"item in list"`
    - Map: `"key, val in map"`
  - `$do`: The template body to render for each iteration.
- **Behavior:**
  - If used in a **List**, the results are appended/flattened into the parent list.
  - If used in a **Map**, the results are merged into the parent map.

```yaml
# List Generation
ingress:
  - $for: "host in hosts"
    $do:
      name:
        $eval: "${{ host }}"
      url:
        $eval: "https://${{ host }}.example.com"
```

### 3.4. Dynamic Key-Value Pairs (`$key` / `$value`)

Used within `$for/$do` for object-mode iteration when keys need to be computed at compile time.

```yaml
# Map Key Generation
labels:
  $for: "k, v in extra_tags"
  $do:
    $key:
      $eval: "custom-${{ k }}"
    $value:
      $eval: "${{ v }}"
```

### 3.5. Modularity (`$include` / `$with`)

Loads and renders an external YAML file.

- **Syntax:**
  - `$include`: File path string.
  - `$with`: (Optional) Map of variables to inject into the included file's root scope.
- **Behavior:** The rendered result of the external file replaces the current node.

```yaml
service:
  $include: "./templates/microservice.yaml"
  $with:
    name: "user-auth"
    port: 8080
```

### 3.6. Validation (`$assert`)

Stops processing and returns an error if a condition is not met.

- **Syntax:**
  - `$assert`: CEL expression (must evaluate to Boolean).
  - `$msg`: (Optional) Error string.

```yaml
$assert: "replicas <= 10"
$msg: "You cannot request more than 10 replicas."
```

### 3.7. Schema Definition (`$schema`)

Validates the structure and types of data inherited from the parent scope.

- **Syntax:** JSON Schema format where object schemas define keys as properties.
- **Scope:** Validates data from parent scope that flows into the current object and its descendants.

```yaml
$schema:
  env:
    type: string
  region:
    type: string

metadata:
  environment:
    $eval: "${{ env }}"
```

- **Properties:**
  - `type`: Primitive types (`string`, `number`, `integer`, `boolean`, `array`, `object`).
  - `items`: For arrays, specifies the element schema.
  - `properties`: For objects, defines keyed sub-schemas.
  - `pattern`: Regex validation for string types.
  - `enum`: Allowed values.
  - `minimum`, `maximum`: Numeric bounds.

---

## 4. Full Example: "The Kitchen Sink"

**Input Context:**

```json
{
  "env": "prod",
  "region": "us-east-1",
  "services": [
    { "name": "cart", "ha": true },
    { "name": "catalog", "ha": false }
  ]
}
```

**Template:**

```yaml
$let:
  domain: "'acme.com'"
  default_tags:
    $eval: "${{ { owner: 'platform', team: 'sre' } }}"

apiVersion: v1
kind: List
items:
  - $for: "svc in services"
    $do:
      $let:
        full_name: "svc.name + '-' + region"
        is_ha: "svc.ha && env == 'prod'"

      kind: Service
      metadata:
        name:
          $eval: "${{ full_name }}"
        labels:
          $for: "k, v in default_tags"
          $do:
            $key:
              $eval: "${{ k }}"
            $value:
              $eval: "${{ v }}"

      $if: "is_ha"
      $then:
        type: LoadBalancer
        replicas: 3
      $else:
        type: ClusterIP
        replicas: 1

      ports:
        - port: 80
          targetPort: 8080

  - $include: "common/monitoring-agent.yaml"
    $with:
      cluster_domain:
        $eval: "${{ domain }}"
```
