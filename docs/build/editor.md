---
sidebar_label: Telo Editor
slug: /build/editor
description: A web and desktop editor for authoring Telo manifests visually — topology canvas, resource inventory, raw YAML, and an integrated runner.
---

# Telo Editor

The Telo Editor is a web and desktop application for authoring and running Telo manifests. It opens a workspace directory, parses every `telo.yaml` and `Telo.Application` it finds, runs the same static analysis the [CLI's `telo check`](/learn/installation-and-cli) uses, and exposes four coordinated views over the same underlying model.

The editor never owns a hidden representation: the YAML on disk is the source of truth, and every view edits it directly. Diagnostics shown in the editor match exactly what the kernel will accept at boot.

## Workspaces

A workspace is any directory containing one or more `Telo.Application` or `Telo.Library` files. The editor walks the tree, resolves `Telo.Import` statements and presents every resource it finds.

Module documentation (schema descriptions) is rendered inline next to each field, so authors don't need to context-switch to a docs site to know what a property does.

## Running manifests from the editor

The Deployment view runs your manifest in a Docker container and streams logs back into the editor. The container can live on your machine or any reachable host, so the same setup that works locally also drives a remote staging box.

It is the same Docker loop you'd use in production — see [Deploy with Docker](/deploy/docker). The editor just packages and ships the manifest for you on every "Run".
