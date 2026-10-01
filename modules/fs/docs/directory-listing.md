# `Fs.DirectoryListing`

> Examples assume this module is imported under the alias `Fs`.

Lists a directory: one entry per item, with metadata only — nothing is read.

```yaml
kind: Fs.DirectoryListing
metadata: { name: list }
cwd: !cel "variables.workspace"
```

## Inputs

| Field       | Type        | Required | Purpose                                                                                   |
| ----------- | ----------- | -------- | ----------------------------------------------------------------------------------------- |
| `path`      | string      | no       | Directory to list, relative to `cwd`. Omitted or empty lists `cwd` itself.                |
| `recursive` | boolean     | no       | Walk subdirectories and include their entries. Default `false`.                           |
| `exclude`   | string[]    | no       | Base names to omit at any depth; an excluded directory is neither listed nor descended.   |
| `limit`     | integer ≥ 1 | no       | The most entries to return. Omitted: every entry.                                         |
| `cursor`    | string      | no       | The `nextCursor` of the previous page of the same listing; only entries after it return.  |

## Output

| Field        | Type   | Meaning                                                                     |
| ------------ | ------ | --------------------------------------------------------------------------- |
| `entries`    | array  | `{ name, path, type, size }` each — `type` is `file`, `directory` or `other`. |
| `nextCursor` | string | Present when more entries remain; absent when the listing is complete.      |

Each `path` is relative to `cwd` and separated with `/` on every host, so it can be fed straight back as an input and compared in CEL.

## Order

Entries come **sorted by `path`**, whether or not the listing is paged: the whole path is compared by Unicode code point, which is the order of its UTF-8 bytes — not locale collation, and not the UTF-16 order a plain string comparison gives in some languages, which differs for characters above U+FFFF. For a single directory that is name order. For a recursive listing it means a directory is not always followed directly by its children: `a.txt` sorts between `a` and `a/1.txt`, because `.` precedes `/`. [`Fs.TreeSnapshot`](./tree-snapshot.md) orders its `files` the same way.

## Paging

`limit` returns at most that many entries, in path order. When more remain, the result carries `nextCursor`; pass it as `cursor`, with the same `path`, `recursive` and `exclude`, to get the next page. No entry appears on two pages, and the last page carries no `nextCursor` — so a caller counting entries or summing sizes can stop as soon as a bound is crossed, without listing the rest:

```yaml
- name: page
  invoke: !ref list
  inputs:
    path: !cel "inputs.directory"
    recursive: true
    limit: 200
    cursor: !cel "inputs.cursor"
```

The cursor is the path of the last entry returned, and each page lists the tree as it is at that moment: an entry created behind the cursor between two pages is not returned, and one removed ahead of it is simply absent.

A page costs what it returns. The tree is walked in path order and the walk stops one entry after the page — the look-ahead that decides `nextCursor` — so a call lists only the directories on the way to its page, reads the size of only the entries it returns plus that one, and never holds the rest of the tree: work and memory follow `limit` and the size of those directories, not the size of the tree.
