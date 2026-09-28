---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Breaking: `OpenSpanOptions.inbound` is the W3C Trace Context carrier, `{ traceparent, tracestate? }`, exactly as a transport received it (it was `{ traceId, parentSpanId? }`). The kernel's `openSpan` parses it: a valid `traceparent` makes the span a child of the upstream span, in the upstream trace, and the upstream parent id is exported verbatim as the span's `parentSpanId` (also `Telo.LogTraceSink`'s `telo.span.parent_span_id`); an invalid or all-zero one is ignored in full and the span roots a new trace. The step engine's `TryStep.when` is typed as the predicate it is, a boolean or a compiled `!cel` expression. A templated kind's `mount:` now forwards every argument of the transport's `register` call to its mount child, not only `app` and `prefix`, so a templated mount receives `Http.Server`'s request scope.
