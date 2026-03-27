# Telo Data Types

## 1. Core Principles

The Telo engine enforces strict, type-safe boundaries between resources. Every piece of data flowing through the system is validated against a **Type** resource.

- **Type Capability:** A dedicated resource category used to define data structures, validation rules, and business invariants.
- **Polyglot Support:** Telo natively supports multiple schema drivers, primarily **JSON Schema** for industry-standard validation and **CUE** for advanced logic (generics, complex invariants).
- **Encapsulated Invariants (Rich Domain Model):** Types do not just define "shapes"; they define business truth. If a Type resource specifies a rule (e.g., "balance cannot be negative"), the Kernel guarantees that no action can emit data that violates it.
- **Fail-Fast Execution:** Validation happens at the edge. If a signal's payload does not satisfy the Type's constraints, the execution is halted before it reaches the business logic.

## 2. Type Resources

Instead of a centralized dictionary, types are defined as independent resources. This allows for better modularity and specific engine selection per type.

### 2.1 Type.JsonSchema

Standard validation for common data structures. Use `rules` for cross-field business invariants that JSON Schema cannot express natively. Each rule requires a `code`; `message` is an optional inline hint for convenience.

```yaml
kind: Type.JsonSchema
metadata:
  name: BankAccount
schema:
  type: object
  required: [id, balance, status]
  properties:
    id: { type: string, format: uuid }
    balance: { type: number }
    status: { type: string, enum: [active, frozen, closed] }
rules:
  - condition: "this.status == 'closed' ? this.balance == 0 : true"
    code: "ERR_CLOSED_ACCOUNT_REMAINDERS"
    message: "A closed account must have a zero balance" # optional
```

Rule `condition` expressions are evaluated using **[Common Expression Language (CEL)](https://github.com/google/cel-spec)**. The validated object is bound to `this`. A condition must return `true` for the data to be considered valid — returning `false` triggers the associated `code`. Standard CEL types, operators, and built-in functions are available; macros such as `has()`, `all()`, and `exists()` can be used for optional fields and collections.

### 2.2 Type.Cue

Advanced validation supporting generics and complex business invariants. Use `@code()` attributes directly on constraints to attach stable machine-readable codes. Human-readable messages are resolved at the application layer (e.g., HTTP response, i18n).

```yaml
kind: Type.Cue
metadata:
  name: BankAccount
definition: |
  #BankAccount: {
    id:      string
    balance: (>= 0    @code("ERR_NEGATIVE_BALANCE")) &
             (<= 1000 @code("ERR_BALANCE_LIMIT_EXCEEDED"))
    status:  "active" | "frozen" | "closed"
  }
```

## 3. The Type Registry

During module compilation, the Kernel registers all resources with the **Type** capability by name. Resources reference types using plain name strings.

- **Local Reference:** `BankAccount`
- **Imported Reference:** `Billing.Invoice`

When a module uses a `Kernel.Import`, the Kernel maps the external module's exported types into the local registry under the import's alias.

## 4. Enforcing Types on Resources

`Invocable` resources (like `JavaScript.Script` or `Http.Request`) use `inputType` and `outputType` to declare the expected type. The value is either a **name reference** (string) or an **inline type definition**.

### Named Reference

```yaml
kind: JavaScript.Script
metadata:
  name: ProcessWithdrawal
inputType: BankAccount
outputType: BankAccount
script: |
  function main(args) {
    // arg is guaranteed to match BankAccount
    // If this code returns a negative balance, the Kernel will intercept
    // and block the signal based on the Type's rules.
    return { ...args, balance: args.balance - 100 };
  }
```

Cross-module reference:

```yaml
inputType: Billing.Invoice
```

### Inline Definition

For one-off types that don't need to be reused, the full type can be defined inline using `kind`. Supports all the same fields as a named Type resource.

```yaml
kind: JavaScript.Script
metadata:
  name: ProcessWithdrawal
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      amount: { type: number }
      currency: { type: string }
  rules:
    - condition: "this.amount > 0"
      code: "ERR_INVALID_AMOUNT"
```

```yaml
inputType:
  kind: Type.Cue
  definition: |
    amount:   number & > 0 @code("ERR_INVALID_AMOUNT")
    currency: string
```

## 5. Exports and Imports

Modules encapsulate their internal types and only expose what is necessary through the `exports` block.

### Exporting (Provider Side)

```yaml
# Inside billing-module.yaml
exports:
  types:
    PublicInvoice: InvoiceType # Points to a Type.JsonSchema resource
```

### Importing (Consumer Side)

```yaml
# Inside main-module.yaml
kind: Kernel.Import
metadata:
  name: Billing
source: modules/billing

---
kind: JavaScript.Script
metadata:
  name: Audit
inputType: Billing.PublicInvoice
```

## 6. Error Code Translation

When a validation failure occurs, the Kernel surfaces the `code` (e.g., `ERR_NEGATIVE_BALANCE`) as part of the error payload. Translation to a human-readable message is the responsibility of the consumer layer:

- **HTTP endpoints** can map codes to response messages, optionally using i18n to serve locale-appropriate strings.
- **Event handlers** or other consumers can apply their own mapping as needed.

This keeps the schema system language-agnostic and free of presentation concerns.

## 7. Collision Prevention

The Kernel enforces a strict naming policy:

1. **Reserved Names:** You cannot name a `Type` resource the same as an `Import` resource.
2. **Immutability:** Once a type is mounted in the virtual registry, it cannot be overwritten by other resources.
