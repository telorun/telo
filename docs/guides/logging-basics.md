---
description: "Every Telo application logs with no configuration. Set the level, drive it from an environment variable, and understand why secrets never reach the log."
---

# Logging basics

The first time you run an application, it talks:

```
{"time":"2026-08-10T11:44:28.577Z","level":"INFO","severity":9,"msg":"Server listening at http://127.0.0.1:8080"}
```

Nothing in your manifest asked for that. This page explains where it comes from
and how to turn it up, down, or off — which is most of what anyone needs from
logging on day one.

## Your app already logs

There is no logging to switch on. An application with no `logging:` block
behaves exactly as if a single console sink were declared, and the format
follows where the output is going:

**On a terminal** — human-readable, aligned, coloured:

```
11:44:50.558  INFO   Server listening at http://127.0.0.1:8080
```

**Piped or redirected** — one JSON object per line, ready for whatever collects
it:

```
{"time":"2026-08-10T11:44:28.577Z","level":"INFO","severity":9,"msg":"Server listening at http://127.0.0.1:8080"}
```

Same records, two encodings. You do not configure the switch; it follows the
destination, so `telo ./telo.yaml` reads well by hand and `telo ./telo.yaml >
app.log` produces something machine-readable.

Records are **structured**, not text lines. Each carries a timestamp, a
severity, a message, the resource that emitted it, any attributes that resource
attached, and — when it happened inside a dispatch — the trace and span it
belongs to. That is why the JSON form has fields rather than a formatted string:
nothing has to be parsed back out.

## Turning the volume down

One field on the application:

```yaml
kind: Telo.Application
metadata:
  name: GreetingApi
logging:
  level: warn
```

Six levels are nameable: `trace`, `debug`, `info` (the default), `warn`,
`error`, `fatal`. At `warn` the listening line above disappears, because it is
an `info` record — the app runs identically and simply says less.

This is worth reaching for sooner than you would think. A test that stands a
server up spends most of its output on request logs it does not care about;
`level: warn` is usually the difference between a readable test run and a wall
of JSON.

## Choosing the level per environment

The level is an ordinary field, so it takes an expression like any other — bind
a variable and read it:

```yaml
variables:
  logLevel:
    env: LOG_LEVEL
    type: string
    default: info
logging:
  level: !cel "variables.logLevel"
```

`LOG_LEVEL=debug telo ./telo.yaml` for a noisy local run, the default in
production, and no separate logging configuration file in either case.

## Secrets do not reach the log

Values bound to `secrets:` are redacted automatically, with no configuration —
this is the promise [Configuring an application](/learn/configuration) makes when
it tells you to put sensitive values there. Redaction happens before
serialization and before any sink sees the record, and the key is preserved
while the value is replaced, so you can still tell the field was present.

One distinction that catches people: **what you deliberately print is not a log
record.** `Console.writeLine` writes to standard output, so a secret you
interpolate into it yourself is printed exactly as written. Redaction governs
the log pipeline, not your own output.

## Where to go next

Everything above is the day-one surface. When you need more —

- **Sending records somewhere other than the console** — file sinks, several
  sinks at once, buffering and durability.
- **Turning one noisy dependency up or down** without changing the global level.
- **Redacting paths of your own**, beyond the automatic secret handling.
- **Sampling** a repeated message so a hot path cannot flood the log.
- **Shipping records** to an OTLP collector.
- **Emitting records from a controller** you are writing yourself.

— all of it is in [Logging](/build/logging).
