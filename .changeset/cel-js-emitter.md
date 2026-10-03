---
"@telorun/cel": minor
---

`@telorun/cel` compiles an expression to **JavaScript source**, as a second backend over the same runtime
as the closure one.

`environment.emit(sources)` answers one module for a set of expressions — its `text`, its `key` and its
integrity `header` — and `environment.emittedModule(sources, store)` reads it back from a store the host
supplies, emitting and writing it where the store holds nothing usable. A host loads the text however it
loads a module and calls `programsFromEmittedModule(loaded, module, environment.emitterRuntime())`, which
verifies the module's header before a single function runs and answers one `CelProgram` per expression. An
emitted program is faster by exactly one thing — what the closure calls cost — since both backends pay the
same shared runtime underneath: measured on one machine over six runs, 1.20x-1.44x on expressions that
call many small operations and a wash (0.99x-1.09x) on one dominated by a dotted-chain search and a
conversion.

**Both backends answer identically, case for case** — the same value, or the same error code and the same
range. That is a property of the wiring rather than of the tests: everything around a call now lives once
(`backend-runtime.ts`) — admitting a host value, the member read in every form, `has()`, a bool operand,
an aggregate's optional entry, a name and a dotted chain, and the per-call-site overload dispatch with its
bounded cache — and both backends call those functions by reference, so the only thing they compile
differently is how control gets from one call to the next. It is gated three ways: every form of the
grammar (with completeness over the tree's own node kinds), every one of the 214 calls the registry holds,
and every one of the 1,814 conformance rows.

**The runtime is injected, never imported.** The module's default export is a factory taking the runtime
support library, and the text names no specifier of any kind — so it loads from a `data:` URL, from a
cache directory mounted anywhere and under a host whose resolver is not Node's, and it cannot silently
accept a runtime of another version. `RUNTIME_BINDINGS` is the whole contract. No CEL member read is a
host property access: `a.b`, `a['b']`, `a[expr]`, `.?`, `[?]` and `has()` all emit a call to the member-read
seam, and the only properties the emitted code reads at all are six of the engine's own structural fields.
Nothing is asynchronous, and nothing touches a filesystem: the engine exports one store seam and no
loader.

**The cache key covers the environment, not just the source**: the emitter's format generation
(`EMITTER_FORMAT_GENERATION`, bumped on any change to the text the emitter writes for any tree), the
engine version (`ENGINE_VERSION`, generated from the telo version line at `prepare` and gitignored, as the
analyzer's surface generation already is), the environment's digest and the ordered list of expression
sources. The digest is over the environment's **resolved listing** — every surviving function signature,
every named type, every variable, every namespace, every option — so two environments built by different
registration orders are one key while a host that replaced or removed a standard function is a different
one.

**The integrity header inside the module carries five fields**, because the three provenance ones are
byte-identical for every module one engine writes against one environment and so distinguish only a shared
cache root and a stale environment: `format`, `engine`, `environment`, plus `key` (the module's own
identity) and `body` (the digest of every byte after the header line, which covers the `integrity` export
and therefore cannot live in it). Every mismatch a stored **text** shows is a recompile naming itself under
`refused` — another key's text, a text truncated after its header, a text edited after it was written; a
loaded **module** that declares nothing, declares another key, exports no factory or answers the wrong
number of functions is refused with `CelEngineError` code `emitted_module_rejected`. A store's write should
still be atomic — written elsewhere, then renamed — because several hosts share one cache root: that is how
a half-written entry is avoided, and the body digest is how one is detected if it is not. Verifying a
stored 838 KB module (1,771 expressions) costs 9-15 ms against 29-39 ms to emit it, and a store hit now
parses nothing.

Emission is deterministic: the same expressions in the same order against the same environment are the
same bytes.
