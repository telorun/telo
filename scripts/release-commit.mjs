// Which release a tag names: its RELEASE COMMIT.
//
// A release tag points at its release commit (the merge of the release PR), or at that
// commit's PUBLICATION commit — a branchless child whose message is
// `chore(release): publish <tag>` and whose only change respells import lines under
// the consumer roots (`publication-commit.mjs`). A tag on a publication commit names
// its first parent; every other tag, including every tag made before publication
// commits existed, names the commit it points at.
//
// An IMPORT LINE is a line of a YAML file holding a top-level `imports:` block, of the
// form `<indent>[- ]<key>: <value>` where the value — bare or quoted, a comment
// allowed after it — is an `oci://` reference or a relative path (`.`, `..`, `./…`,
// `../…`). A publication commit's diff against its first parent modifies files
// under the four roots only, keeps every mode, and pairs each removed line with an
// added import line of the same `<indent><key>: `, hunk by hunk.
//
// Usage: node scripts/release-commit.mjs [<commit>]
//   the release commit of <commit> (default HEAD), as the step output `release-commit`;
//   a release workflow compares it with its first parent to ask what the release moved.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setOutput } from "./release-actions-output.mjs";
import { CONSUMER_ROOTS } from "./release-imports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_TAG = String.raw`(?:v\d+\.\d+\.\d+|(?:modules|packages)-\d+\.\d+-\d+)`;
const SUBJECT = new RegExp(`^chore\\(release\\): publish ${RELEASE_TAG}$`);
const SOURCE = (char) => String.raw`(?:oci://${char}+|\.\.?(?:/${char}*)?)`;
const IMPORT_VALUE = `(?:"${SOURCE(String.raw`[^"\s]`)}"|'${SOURCE(String.raw`[^'\s]`)}'|${SOURCE(String.raw`\S`)})`;
const IMPORT_LINE = new RegExp(
  String.raw`^(\s*(?:-\s+)?(?:[A-Za-z_][\w-]*|"[^"]*"|'[^']*')\s*:\s+)${IMPORT_VALUE}(?:\s+#.*)?\s*$`,
);

/** The message of the publication commit of `tag`. */
export const publicationSubject = (tag) => `chore(release): publish ${tag}`;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** The `<indent><key>: ` of an import line, or undefined for any other line. */
export function importLineKey(line) {
  return IMPORT_LINE.exec(line)?.[1];
}

/** The unified diff `git diff -U0` printed, split per file in the order git lists them. */
function patchSections(patch) {
  const sections = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([]);
    else sections.at(-1)?.push(line);
  }
  return sections;
}

/** Why a file's hunks (`-U0` lines) are not respelled import lines, or undefined. */
function hunkProblem(path, lines) {
  let hunks = 0;
  let removed = [];
  let added = [];
  const close = () => {
    if (removed.length !== added.length) return "a hunk adds or removes lines";
    for (let k = 0; k < removed.length; k++) {
      const key = importLineKey(removed[k]);
      if (key === undefined || key !== importLineKey(added[k])) return `"${removed[k].trim()}" is not an import line respelled`;
    }
    removed = [];
    added = [];
    return undefined;
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const problem = close();
      if (problem) return `${path}: ${problem}`;
      hunks++;
    } else if (hunks > 0 && line.startsWith("-")) removed.push(line.slice(1));
    else if (hunks > 0 && line.startsWith("+")) added.push(line.slice(1));
  }
  const problem = close();
  if (problem) return `${path}: ${problem}`;
  return hunks === 0 ? `${path} has no text diff` : undefined;
}

/** Why the diff from `parent` to `commit` is not a publication's, or undefined. Costs a
 *  constant number of git processes however many files it changes. */
function nonImportChange(cwd, parent, commit) {
  const raw = git(cwd, "diff", "--raw", "-z", "--no-renames", "--no-abbrev", parent, commit).split("\0").filter(Boolean);
  if (raw.length === 0) return "it changes nothing";
  const files = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [oldMode, newMode, , , status] = raw[i].slice(1).split(" ");
    const path = raw[i + 1];
    if (!CONSUMER_ROOTS.some((root) => path.startsWith(`${root}/`))) return `${path} is outside ${CONSUMER_ROOTS.join(", ")}`;
    if (status !== "M" || oldMode !== newMode) return `${path} is not modified in place (${status}, ${oldMode} → ${newMode})`;
    if (!/\.ya?ml$/.test(path)) return `${path} is not a manifest`;
    files.push(path);
  }
  const withImports = new Set(
    git(cwd, "grep", "-l", "-z", "-E", "^imports:", commit, "--", ...files.map((path) => `:(literal)${path}`))
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf(":") + 1)),
  );
  let sections;
  for (const [index, path] of files.entries()) {
    if (!withImports.has(path)) return `${path} holds no imports: block`;
    sections ??= patchSections(git(cwd, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", parent, commit));
    const problem = hunkProblem(path, sections[index] ?? []);
    if (problem) return problem;
  }
  return undefined;
}

/** Why `commit` is not a publication commit, or undefined when it is one. */
export function publicationRefusal({ cwd = ROOT, commit }) {
  const [parents, subject] = git(cwd, "log", "-1", "--format=%P%x1f%s", commit).split("\x1f");
  if (!SUBJECT.test(subject)) return `its subject "${subject}" names no publication`;
  const parent = parents.split(" ").filter(Boolean);
  if (parent.length !== 1) return `it has ${parent.length} parents`;
  return nonImportChange(cwd, parent[0], commit);
}

/** Whether `commit` is a publication commit. */
export function isPublicationCommit({ cwd = ROOT, commit }) {
  return publicationRefusal({ cwd, commit }) === undefined;
}

/** `{ tag, commit }` of every tag under `patterns` (`refs/tags/…`, all when none) naming a commit. */
function taggedCommits(cwd, patterns) {
  const lines = git(
    cwd,
    "for-each-ref",
    "--format=%(refname:strip=2)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)",
    ...(patterns.length > 0 ? patterns : ["refs/tags"]),
  );
  return lines
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [tag, type, object, peeledType, peeled] = line.split("\t");
      if (peeledType === "commit") return [{ tag, commit: peeled }];
      return type === "commit" ? [{ tag, commit: object }] : [];
    });
}

/** `commit -> its release commit` for `commits`, asked in one `git log`. */
function releaseCommits(cwd, commits) {
  const unique = [...new Set(commits)];
  const result = new Map();
  if (unique.length === 0) return result;
  for (const line of git(cwd, "log", "--no-walk=unsorted", "--format=%H%x1f%P%x1f%s", ...unique).split("\n")) {
    const [sha, parents, subject] = line.split("\x1f");
    const parent = parents.split(" ").filter(Boolean);
    const publication = SUBJECT.test(subject) && parent.length === 1 && nonImportChange(cwd, parent[0], sha) === undefined;
    result.set(sha, publication ? parent[0] : sha);
  }
  return result;
}

/** `tag -> release commit` for every tag under `patterns` (`refs/tags/…`). */
export function releaseCommitsOf({ cwd = ROOT, patterns = [] }) {
  const tagged = taggedCommits(cwd, patterns);
  const release = releaseCommits(
    cwd,
    tagged.map(({ commit }) => commit),
  );
  return new Map(tagged.map(({ tag, commit }) => [tag, release.get(commit)]));
}

/** The release commit `tag` names. Throws when `tag` is no tag of a commit. */
export function releaseCommitOf({ cwd = ROOT, tag }) {
  return releaseCommitOfCommit({ cwd, commit: `refs/tags/${tag}` });
}

/** The release commit of `commit`: its first parent when it is a publication commit,
 *  else itself. Throws when `commit` names no commit. */
export function releaseCommitOfCommit({ cwd = ROOT, commit }) {
  const sha = git(cwd, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
  return releaseCommits(cwd, [sha]).get(sha);
}

/** The tags under `patterns` whose release commit is `commit`, sorted: those pointing
 *  at it and those on its publication commit. */
export function tagsOfReleaseCommit({ cwd = ROOT, commit, patterns = [] }) {
  const sha = git(cwd, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
  return [...releaseCommitsOf({ cwd, patterns })]
    .filter(([, release]) => release === sha)
    .map(([tag]) => tag)
    .sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [commit = "HEAD"] = process.argv.slice(2);
  try {
    setOutput("release-commit", releaseCommitOfCommit({ commit }));
  } catch (error) {
    const reason = `${error?.stderr ?? ""}`.trim() || (error instanceof Error ? error.message : String(error));
    console.log(`::error::release-commit: cannot read the release commit of ${commit}: ${reason}`);
    process.exit(1);
  }
}
