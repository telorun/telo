---
sidebar_label: Overview
slug: /build
description: How to author a Telo manifest — the editor, AI-assisted authoring, and the test loop that keeps changes safe.
---

# Build

Building a Telo application means writing one or more YAML manifests that declare resources, wire them together, and target what should run on boot.

The pages in this section cover the three ways people work on manifests.

## Pick a workflow

| Workflow | When it fits |
| --- | --- |
| **[Telo Editor](/build/editor)** | A desktop editor with a topology canvas, inventory, and integrated runner. The fastest way to compose flows visually and iterate against a live container. |
| **[Coding agents](/build/coding-agents)** | Plug Claude Code, Cursor, or any MCP-aware editor into the Telo registry's MCP server. The agent searches the module catalog, fetches manifests, and authors against the real surface. |
| **Plain editor** | Manifests are just YAML — any editor works. |

All three paths share the same analyzer, so a manifest authored in one tool is consumed identically by the others.

## The inner loop

A typical authoring cycle:

1. **Start from a template** — [Getting Started](/learn/getting-started) walks through a minimal `Telo.Application`; the [Examples](/examples) index has runnable manifests for common patterns (HTTP API, chat console, scheduled job).
2. **Declare imports** with `Telo.Import` and pin to a registry version. `telo upgrade` refreshes pins; the [CLI reference](/learn/installation-and-cli) covers every command in detail.
3. **Compose resources** — invokes, sequences, routers, services. The [Kernel reference](/reference/kernel) explains the building blocks; the [Standard Library](/reference/std) is the surface you import from.
4. **Run it** — `telo ./manifest.yaml` runs locally; the [Telo Editor](/build/editor)'s Deployment view spawns it in a container.
5. **[Test it](/build/testing)** — Telo tests are themselves Telo manifests, so the kernel you target in production is the kernel that runs your tests. The same `Assert.*` resources that guard production behaviour guard development behaviour.
6. **Ship it** — see [Deploy](/deploy).

The order is suggestive, not strict. Authoring, running, and testing are usually interleaved on the same manifest.
