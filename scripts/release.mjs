#!/usr/bin/env node
// Auto-detects changed workspace packages via git, writes a changeset file,
// then delegates versioning/publishing to @changesets/cli.
//
// Usage: node scripts/release.mjs [patch|minor|major] [--from=<step>]
//   patch  (default) — bump X.Y.Z+1
//   minor             — bump X.Y+1.0
//   major             — bump X+1.0.0
//
//   --from=build    Resume after a failed build: skip version bump, run build + publish
//   --from=publish  Resume after a failed publish: skip version bump + build, run publish only

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const bump = ['patch', 'minor', 'major'].find(b => args.includes(b)) ?? 'patch';

// --from=build  : skip changeset detection + version bump, go straight to build+publish
// --from=publish: skip everything except publish
const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1];
const STEPS = ['version', 'build', 'publish'];
const fromStep = fromArg && STEPS.includes(fromArg) ? fromArg : 'version';
const skip = step => STEPS.indexOf(step) < STEPS.indexOf(fromStep);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', cwd: ROOT }).trim();
}

function runLive(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

// ---------------------------------------------------------------------------
// Guard: require clean working tree (skipped when resuming mid-release)
// ---------------------------------------------------------------------------
if (!skip('build')) {
  // Only check when starting from the beginning (fromStep === 'version')
  if (fromStep === 'version') {
    const dirty = run('git status --porcelain');
    if (dirty) {
      console.error('Error: working tree has uncommitted changes. Commit or stash first.\n');
      console.error(dirty);
      process.exit(1);
    }
  } else {
    console.log(`\nResuming from step: ${fromStep}`);
  }
}

// ---------------------------------------------------------------------------
// Discover workspace packages + write changeset (version step only)
// ---------------------------------------------------------------------------
if (!skip('version')) {
  function expandPattern(pattern) {
    const parts = pattern.split('/');
    let dirs = [ROOT];
    for (const part of parts) {
      if (part === '*') {
        dirs = dirs.flatMap(d => {
          try {
            return readdirSync(d)
              .filter(e => { try { return statSync(join(d, e)).isDirectory(); } catch { return false; } })
              .map(e => join(d, e));
          } catch { return []; }
        });
      } else {
        dirs = dirs
          .map(d => join(d, part))
          .filter(d => { try { return statSync(d).isDirectory(); } catch { return false; } });
      }
    }
    return dirs;
  }

  const wsYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [...wsYaml.matchAll(/^\s+-\s+(.+)$/gm)].map(m => m[1].trim());

  const packages = patterns
    .flatMap(expandPattern)
    .flatMap(dir => {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) return [];
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.private || !pkg.name) return [];
      return [{ dir, name: pkg.name, version: pkg.version ?? null }];
    });

  // -------------------------------------------------------------------------
  // Find base reference (last changeset tag or initial commit)
  // -------------------------------------------------------------------------
  let base;
  try {
    // Changeset tags: @scope/pkg@version — second @ appears after the first char
    const allTags = run(
      "git for-each-ref --sort=-creatordate --format='%(refname:short)' refs/tags"
    ).split('\n').filter(Boolean);
    const lastTag = allTags.find(t => t.slice(1).includes('@'));
    base = lastTag ?? run('git rev-list --max-parents=0 HEAD');
  } catch {
    base = run('git rev-list --max-parents=0 HEAD');
  }

  console.log(`\nBase: ${base}`);

  // -------------------------------------------------------------------------
  // Detect changed packages
  // -------------------------------------------------------------------------
  const changedFiles = run(`git diff --name-only "${base}"..HEAD`).split('\n').filter(Boolean);

  const toRelease = new Set();

  for (const file of changedFiles) {
    const abs = resolve(ROOT, file);
    let best = null, bestLen = 0;
    for (const pkg of packages) {
      if (abs.startsWith(pkg.dir + '/') && pkg.dir.length > bestLen) {
        best = pkg;
        bestLen = pkg.dir.length;
      }
    }
    if (best) toRelease.add(best.name);
  }

  // Packages without a version are new — always include them
  for (const pkg of packages) {
    if (!pkg.version) toRelease.add(pkg.name);
  }

  if (toRelease.size === 0) {
    console.log('Nothing to release.');
    process.exit(0);
  }

  const sorted = [...toRelease].sort();
  console.log(`\nPackages to release (${bump}):`);
  for (const name of sorted) console.log(`  ${name}`);

  // -------------------------------------------------------------------------
  // Write changeset file
  // -------------------------------------------------------------------------
  const entries = sorted.map(n => `"${n}": ${bump}`).join('\n');
  const changesetPath = join(ROOT, '.changeset', 'auto-release.md');
  writeFileSync(changesetPath, `---\n${entries}\n---\n\nAutomated release.\n`);
  console.log('\nChangeset file written.');

  // -------------------------------------------------------------------------
  // Bump versions
  // -------------------------------------------------------------------------
  console.log('\nBumping versions...');
  runLive('pnpm changeset version');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
if (!skip('build')) {
  console.log('\nBuilding...');
  runLive('pnpm -r --if-present build');
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
if (!skip('publish')) {
  console.log('\nPublishing...');
  runLive('pnpm changeset publish');
}

console.log('\nRelease complete!');
