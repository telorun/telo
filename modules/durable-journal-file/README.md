# durable-journal-file

Stores durable runs as append-only files in a directory — one file per run.

```yaml
kind: Journal.Journal
metadata: { name: runs }
directory: ./.telo/durable
```

Point a [`DurableLocal.Workflow`](../durable-local/README.md) at it and its runs survive the process.

## Why a file store and not a memory one

A journal that dies with the process has **no durability to demonstrate**, and shipping one invites developing against a thing that lacks the single property being built. This is genuinely durable, so the development path and the production path differ in scale rather than in guarantee.

## How it stores

One newline-delimited JSON file per run, appended and flushed as each record is written. That is not a formatting preference: the whole job is that everything already finished survives an abrupt exit, and an append of one line followed by a flush is the smallest operation with that property. A format that rewrote the file would put every earlier record at risk on every write.

A run's file is read back with **first writer wins** per step: a record already present is the one that counts, so two writers converge rather than each continuing with its own value.

## A record torn mid-write

An abrupt exit during an append leaves a partial final line. Both halves of the store have to agree about what that means, and they do:

- **Reading**, a final line with no terminating newline is discarded. The record never finished being written, so the work it described never finished either, and re-executing it is right.
- **Writing**, that partial line is removed before anything is appended after it.

The second half is not optional. Appending onto a partial line *fuses* the two records into one unparseable line — and the damage is far worse than the tear was. A torn line is the last line, which the reader drops; a fused one sits in the middle, where dropping it would mean skipping a record that may describe work that did happen. So the reader refuses, and a journal that was perfectly resumable a moment earlier is not.

A bad record anywhere *else* stays a hard failure, for the same reason: replaying past it would silently skip work.

## What it does not do

- **Cross-process claiming.** The claim here is advisory and single-machine. A store whose claiming is real answers that with a database's own primitives rather than with a lock file this module would have to invent.
- **Sharing a transaction with your writes.** It always reports that its records land outside any transaction's atomicity, so a transactional region is recorded as one entry and re-runs whole on a resume. That is correct for a directory of files, and it is what a run's `collapsedRegions` count makes visible.

Use a database-backed store when several machines record to one place, or when you want a region's records to commit and roll back with the writes they describe.
