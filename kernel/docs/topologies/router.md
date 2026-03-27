# Topology: Router

A collection of entries, each mapping a matcher to a handler invocable.

## Matcher Contract

**Built-in execution:** each entry's matcher is a CEL boolean expression evaluated against an `event` variable representing the incoming request or message. The kernel evaluates matchers in declaration order and dispatches to the first entry whose expression evaluates to `true`. Evaluation stops at the first match. If no entry matches, the optional top-level `fallback` handler is invoked; if absent, the kernel returns an error.

**Custom execution:** when a controller is present, the matcher field's semantics are implementation-defined. It acts as a structural descriptor for the editor and analyzer — the controller decides how it is evaluated at runtime. For example, `Http.Api` uses a `request` object with `path` and `method` fields that the controller registers as Fastify route patterns.

## Kernel Behavior

Evaluates CEL matcher expressions in declaration order; invokes the first matching handler; passes the event context plus any entry-level `inputs` overrides to the handler.

## Analyzer Behavior

Validates that each entry's `handler` references an existing invocable resource; validates that the `fallback` handler, if present, also references an existing invocable; validates CEL expressions in `matcher` and `inputs` have access to the event context shape declared by the surrounding `Mount`.

## Editor Behavior

Activates the route mapping table sub-editor.

## Role Annotations

| Role       | Required | Description                                                                        |
| ---------- | -------- | ---------------------------------------------------------------------------------- |
| `entries`  | yes      | The array of dispatch entries                                                      |
| `matcher`  | yes      | CEL condition (built-in) or structural descriptor (custom execution) on each entry |
| `handler`  | yes      | The invocable reference on each entry                                              |
| `fallback` | no       | Top-level invocable invoked when no entry matches (built-in execution only)        |

## Example

```yaml
kind: Kernel.Definition
metadata:
  name: Api
  module: Http
capability: Mount
topology: Router
controllers:
  - pkg:npm/@telorun/http-server@>=0.1.0
schema:
  type: object
  properties:
    routes:
      x-telo-topology-role: entries
      type: array
      items:
        type: object
        properties:
          request:
            x-telo-topology-role: matcher
            type: object
          handler:
            x-telo-topology-role: handler
            x-telo-ref: Kernel.Invocable
```
