#!/usr/bin/env node
// The publication commit of a release: the child of its release commit whose only
// change is `telo release imports --as=published` over the consumer roots
// (`examples/`, `starters/`, `apps/`, `blueprints/`, tests and fixtures included), on
// no branch. The release's tags are placed on it, so a tag carries pins to published
// artifacts while every branch keeps relative imports.
//
// It is made in the checkout of the release commit itself: the one computation the release
// PR's gate (`check-release-imports.mjs`) and `telo publish` run, in the layout they run it in.
// A controller bundle records the path of every dependency it inlines relative to its build
// root, so the same sources built in another tree — one borrowing this checkout's
// `node_modules` — digest differently and every module reads as changed. The checkout must be
// the release commit, installed and built (`pnpm -r build`), as a Publish job's is, with no
// tracked change and no untracked consumer manifest: anything else is refused. The rewrite
// edits the consumer manifests in place, the tree is written through a private index (HEAD,
// the real index and every branch stay where they were), and the manifests are restored from
// the release commit before the run returns. The command is the checkout's built CLI
// (`TELO_CLI` overrides it). Every import must come out published:
// one left relative fails the run, naming it, and a re-run heals a registry error.
//
// The commit is a function of the release commit and the registry's immutable pins:
// its message is `chore(release): publish <first tag>`, its author and committer the
// bot identity below, both dates the release commit's committer date, so a re-run
// makes the same sha. When the rewrite changes nothing there is no publication commit
// and the tags go on the release commit itself. A candidate makes none: its tag stays
// on the release commit, with relative imports.
//
// Usage:
//   node scripts/publication-commit.mjs --release <commit> --tag <tag> [--tag <tag>…] [--dry-run | --push]
//
//   (neither)  make the commit in the local object store and print its sha
//   --dry-run  also print the diffstat and what each tag would do; push nothing
//   --push     also create every tag at it (`release-tag.mjs`: GH_TOKEN, GITHUB_REPOSITORY)
//
// Outputs (`release-actions-output.mjs`): `publication` (`true` | `false`) and `sha`, the
// commit the tags name; the bare sha is the last line of stdout. Progress goes to stderr.
// Env: TELO_CLI, TELO_OCI_REGISTRY (read by the command).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { publicationRefusal, publicationSubject } from "./release-commit.mjs";
import { CONSUMER_ROOTS, consumerManifests, describeImports, releaseImportsJson } from "./release-imports.mjs";
import { ensureTag } from "./release-tag.mjs";
import { ROOT } from "./version-line.mjs";

export const PUBLICATION_IDENTITY = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};
const CANDIDATE_TAG = /^v\d+\.\d+\.\d+-/;

function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** Runs `--as=published` over the consumer manifests of the checkout at `root`; throws naming
 *  every import it left relative or could not decide. */
export function publishImports(root) {
  const manifests = consumerManifests(root);
  if (manifests.length === 0) return;
  console.error(`publication-commit: telo release imports --as=published over ${manifests.length} manifest(s)`);
  const { status, result } = releaseImportsJson({ cwd: root, args: ["--as=published"], manifests });
  if (status === 0) return;
  const named = describeImports([...(result?.keptRelative ?? []), ...(result?.errors ?? [])]);
  if (status === 1 && named.length > 0) {
    throw new Error(`${named.length} import(s) would not be published:\n  ${named.join("\n  ")}`);
  }
  throw new Error(`telo release imports exited ${status ?? "on a signal"} and named no import; see its output above.`);
}

/** At most `limit` of `paths`, then the count of the rest. */
const named = (paths, limit = 20) =>
  paths.slice(0, limit).join(", ") + (paths.length > limit ? ` and ${paths.length - limit} more` : "");

const lines = (text) => text.split("\n").filter(Boolean);

/** The consumer roots that exist in the checkout at `root` — a pathspec naming none is an error. */
const presentRoots = (root) => CONSUMER_ROOTS.filter((name) => existsSync(join(root, name)));

/** Tracked paths whose content differs from HEAD, the index's stat cache refreshed first. */
function changedTracked(root) {
  git(root, ["update-index", "-q", "--refresh"]);
  return lines(git(root, ["diff-index", "--name-only", "HEAD"]));
}

/** Why `cwd`'s checkout is not the release commit as published, or undefined. */
function checkoutRefusal(cwd, releaseCommit) {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head !== releaseCommit) {
    return `HEAD is ${head}, not the release commit ${releaseCommit}: check out ${releaseCommit}, install and build it, and run again`;
  }
  const changed = changedTracked(cwd);
  if (changed.length > 0) {
    return `the checkout has changes to tracked files (${named(changed)}): the release plan digests the whole tree, so a change anywhere makes the verdict about a tree that is not the release`;
  }
  const roots = presentRoots(cwd);
  const untracked = roots.length === 0 ? [] : lines(git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...roots]));
  if (untracked.length > 0) {
    return `untracked files under ${CONSUMER_ROOTS.join(", ")} (${named(untracked)}): the rewrite would read them and the commit would leave them out`;
  }
  return undefined;
}

/**
 * Makes the publication commit of `release` named for `tag`:
 * `{ releaseCommit, sha, publication, diffstat }`, `sha` being the release commit
 * itself when the rewrite changes nothing. `rewrite(root)` rewrites the checkout's
 * consumer manifests in place; they are restored before this returns.
 */
export function makePublicationCommit({ cwd = ROOT, release, tag, rewrite = publishImports }) {
  let releaseCommit;
  try {
    releaseCommit = git(cwd, ["rev-parse", "--verify", "--quiet", `${release}^{commit}`]);
  } catch {
    throw new Error(`${release} is not a commit of this repository.`);
  }
  const refusal = checkoutRefusal(cwd, releaseCommit);
  if (refusal) throw new Error(refusal);

  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const scratch = mkdtempSync(join(tmpdir(), "telo-publication-"));
  let failed = false;
  let result;
  try {
    rewrite(root);
    const index = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    git(root, ["read-tree", releaseCommit], index);
    const roots = presentRoots(root);
    if (roots.length > 0) git(root, ["add", "--update", "--", ...roots], index);
    const tree = git(root, ["write-tree"], index);
    if (tree === git(cwd, ["rev-parse", `${releaseCommit}^{tree}`])) {
      result = { releaseCommit, sha: releaseCommit, publication: false, diffstat: "" };
    } else {
      const date = git(cwd, ["log", "-1", "--format=%cd", "--date=raw", releaseCommit]);
      const { name, email } = PUBLICATION_IDENTITY;
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: date,
      };
      const sha = git(cwd, ["commit-tree", "--no-gpg-sign", tree, "-p", releaseCommit, "-m", publicationSubject(tag)], env);
      const notPublication = publicationRefusal({ cwd, commit: sha });
      if (notPublication) throw new Error(`the rewrite of ${releaseCommit} is not a publication: ${notPublication}.`);
      result = { releaseCommit, sha, publication: true, diffstat: git(cwd, ["diff", "--stat", releaseCommit, sha]) };
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      const roots = presentRoots(root);
      if (roots.length > 0) git(root, ["restore", `--source=${releaseCommit}`, "--worktree", "--", ...roots]);
      const left = changedTracked(root);
      if (left.length > 0) throw new Error(`the checkout was not restored: ${named(left)} still differ from ${releaseCommit}`);
    } catch (restore) {
      // A failed run already throws its own cause; the restore failure is named beside it.
      if (!failed) throw restore;
      console.error(`publication-commit: ${restore.message}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return result;
}

function options(argv) {
  const tags = [];
  let release;
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--tag" || arg === "--release") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      if (arg === "--tag") tags.push(value);
      else release = value;
    } else if (arg === "--dry-run" || arg === "--push") flags.add(arg);
    else throw new Error(`unknown argument '${arg}'.`);
  }
  if (!release || tags.length === 0) {
    throw new Error("usage: publication-commit.mjs --release <commit> --tag <tag> [--tag <tag>…] [--dry-run | --push]");
  }
  if (flags.size > 1) throw new Error("--dry-run and --push exclude each other.");
  const candidate = tags.find((tag) => CANDIDATE_TAG.test(tag));
  if (candidate) {
    throw new Error(`${candidate} is a release candidate, which has no publication commit: its tag stays on the release commit.`);
  }
  return { release, tags, dryRun: flags.has("--dry-run"), push: flags.has("--push") };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { release, tags, dryRun, push } = options(process.argv.slice(2));
    const made = makePublicationCommit({ release, tag: tags[0] });
    if (made.publication) {
      console.error(`publication-commit: ${made.sha} publishes ${made.releaseCommit}:\n${made.diffstat}`);
    } else {
      console.error(`publication-commit: the rewrite changes nothing; the tags name ${made.releaseCommit} itself.`);
    }
    for (const tag of tags) {
      if (push) {
        console.error(`publication-commit: ${tag} ${ensureTag({ tag, sha: made.sha })} at ${made.sha}.`);
      } else if (dryRun) {
        try {
          const would = ensureTag({ tag, sha: made.sha, create: () => {} });
          console.error(`publication-commit: would tag ${tag} at ${made.sha} (${would === "created" ? "new" : "already there"}).`);
        } catch (conflict) {
          console.log(`::warning::publication-commit: --push would refuse ${tag}: ${conflict.message}`);
        }
      }
    }
    if (dryRun) console.error("publication-commit: dry run; nothing was pushed or tagged.");
    setOutput("publication", made.publication);
    setOutput("sha", made.sha);
    console.log(made.sha);
  } catch (error) {
    console.error(`::error::publication-commit: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
