#!/usr/bin/env node
// The publication commit of a release: the child of its release commit whose only
// change is `telo release imports --as=published` over the consumer roots
// (`examples/`, `starters/`, `apps/`, `blueprints/`, tests and fixtures included), on
// no branch. The release's tags are placed on it, so a tag carries pins to published
// artifacts while every branch keeps relative imports.
//
// It is made in a scratch worktree of the release commit, removed afterwards, so the
// caller's checkout is never touched. The command is the caller's built CLI (`TELO_CLI`
// overrides it), and the worktree borrows the caller's `node_modules` directories for
// the controller builds the release plan digests — which reach the workspace packages
// a bundle inlines in the caller's tree — so the caller's checkout must be the release
// commit, installed and built (`pnpm -r build`), as a Publish job's is; it warns when
// HEAD is another commit. Every import must come out published:
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
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { publicationRefusal, publicationSubject } from "./release-commit.mjs";
import { consumerManifests, describeImports, releaseImportsJson } from "./release-imports.mjs";
import { ensureTag } from "./release-tag.mjs";
import { ROOT } from "./version-line.mjs";

export const PUBLICATION_IDENTITY = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};
const CANDIDATE_TAG = /^v\d+\.\d+\.\d+-/;
const SKIP_DIRS = new Set([".git", ".claude", ".telo", "target"]);

function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** Links every `node_modules` directory of `from` into `to` where `to` has the parent
 *  directory and no entry of that name. Returns the links made. */
function borrowDependencies(from, to) {
  const links = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(from, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const path = dir ? join(dir, entry.name) : entry.name;
      if (entry.name !== "node_modules") {
        if (existsSync(join(to, path))) visit(path);
        continue;
      }
      if (!existsSync(join(to, path))) {
        symlinkSync(join(from, path), join(to, path), "dir");
        links.push(join(to, path));
      }
    }
  };
  visit("");
  return links;
}

/** Runs `--as=published` over the consumer manifests of `worktree`; throws naming every
 *  import it left relative or could not decide. */
export function publishImports(worktree) {
  const manifests = consumerManifests(worktree);
  if (manifests.length === 0) return;
  console.error(`publication-commit: telo release imports --as=published over ${manifests.length} manifest(s)`);
  const { status, result } = releaseImportsJson({ cwd: worktree, args: ["--as=published"], manifests });
  if (status === 0) return;
  const named = describeImports([...(result?.keptRelative ?? []), ...(result?.errors ?? [])]);
  if (status === 1 && named.length > 0) {
    throw new Error(`${named.length} import(s) would not be published:\n  ${named.join("\n  ")}`);
  }
  throw new Error(`telo release imports exited ${status ?? "on a signal"} and named no import; see its output above.`);
}

/**
 * Makes the publication commit of `release` named for `tag`:
 * `{ releaseCommit, sha, publication, diffstat }`, `sha` being the release commit
 * itself when the rewrite changes nothing. `rewrite(worktree)` rewrites the tree.
 */
export function makePublicationCommit({ cwd = ROOT, release, tag, rewrite = publishImports }) {
  let releaseCommit;
  try {
    releaseCommit = git(cwd, ["rev-parse", "--verify", "--quiet", `${release}^{commit}`]);
  } catch {
    throw new Error(`${release} is not a commit of this repository.`);
  }
  if (git(cwd, ["rev-parse", "HEAD"]) !== releaseCommit) {
    console.log(
      `::warning::publication-commit: this checkout is not at ${releaseCommit}; the controller builds borrow its ` +
        "node_modules (workspace packages included), so a module may read as changed. Run it from a checkout of the release commit.",
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), "telo-publication-"));
  const worktree = join(scratch, "tree");
  let links = [];
  let added = false;
  let failed = false;
  try {
    git(cwd, ["worktree", "add", "--detach", "--quiet", worktree, releaseCommit]);
    added = true;
    links = borrowDependencies(git(cwd, ["rev-parse", "--show-toplevel"]), worktree);
    rewrite(worktree);
    git(worktree, ["add", "--update"]);
    const tree = git(worktree, ["write-tree"]);
    if (tree === git(cwd, ["rev-parse", `${releaseCommit}^{tree}`])) {
      return { releaseCommit, sha: releaseCommit, publication: false, diffstat: "" };
    }
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
    const refusal = publicationRefusal({ cwd, commit: sha });
    if (refusal) throw new Error(`the rewrite of ${releaseCommit} is not a publication: ${refusal}.`);
    return { releaseCommit, sha, publication: true, diffstat: git(cwd, ["diff", "--stat", releaseCommit, sha]) };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      for (const link of links) if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
      if (added) git(cwd, ["worktree", "remove", "--force", worktree]);
      rmSync(scratch, { recursive: true, force: true });
    } catch (cleanup) {
      // A failed run already throws its own cause; the leftover is named beside it.
      if (!failed) throw cleanup;
      console.error(`publication-commit: could not remove the scratch worktree ${worktree}: ${cleanup.message}`);
    }
  }
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
