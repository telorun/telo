#!/usr/bin/env node
/**
 * Wrap a built `telo` executable in the package formats each platform installs
 * from.
 *
 *   node .github/scripts/package-standalone.mjs --target <t> --version <v> --dir <d>
 *
 * Every format here does exactly one thing: put `telo` on the user's PATH. They
 * are therefore built from the finished binary rather than from per-format
 * staging trees — there is no second copy of "what goes in a release" to keep in
 * step with the first.
 *
 * The archive (`.tar.gz` / `.zip`) is always produced, because it is what the
 * install scripts and the musl target use, and it is the one format that needs
 * no tooling on the machine building it.
 *
 * **One policy for every native format: a missing tool is a failure.** They
 * were mixed — one format threw, the rest returned "skipped" and printed a
 * line — and a release quietly missing its `.deb` is exactly what nobody
 * notices. The tools belong on the runners that build each target; `--optional`
 * downgrades the exit for a local build, where WiX or rpmbuild is not expected.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Each target's name in the package formats' own vocabularies. `deb` and `rpm`
 *  spell the architecture their own way, and that is their namespace rather than
 *  ours — a `.deb` whose `Architecture:` disagrees with its filename is a broken
 *  package. A musl build gets neither: both formats describe glibc systems. */
const TARGET_ARCH = {
  "linux-amd64-gnu": { deb: "amd64", rpm: "x86_64" },
  "linux-amd64-musl": { deb: null, rpm: null },
  "linux-arm64-gnu": { deb: "arm64", rpm: "aarch64" },
  "darwin-amd64": {},
  "darwin-arm64": {},
  "windows-amd64": {},
  "windows-arm64": {},
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i] === "--version") args.version = argv[++i];
    else if (argv[i] === "--dir") args.dir = path.resolve(argv[++i]);
    else if (argv[i] === "--optional") args.optional = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  for (const required of ["target", "version", "dir"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (!TARGET_ARCH[args.target]) throw new Error(`unknown target: ${args.target}`);
  return args;
}

function has(tool) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

/** The archive every platform gets: the binary and nothing else, so unpacking
 *  it anywhere on PATH is a complete install. */
function buildArchive({ target, version, dir }) {
  const isWindows = target.startsWith("windows");
  const name = `telo-${version}-${target}`;
  if (isWindows) {
    const out = path.join(dir, `${name}.zip`);
    run("zip", ["-j", out, path.join(dir, "telo.exe")]);
    return out;
  }
  const out = path.join(dir, `${name}.tar.gz`);
  // `--transform` puts the binary under a single top-level directory, so an
  // extract cannot scatter a bare `telo` into the current directory.
  run("tar", ["czf", out, "-C", dir, "--transform", `s,^telo$,${name}/telo,`, "telo"]);
  return out;
}

/** A Debian package, built by hand rather than with a packaging toolchain: the
 *  payload is one file in one place, and `dpkg-deb` is present on every Debian
 *  and Ubuntu runner. */
function buildDeb({ target, version, dir }) {
  const arch = TARGET_ARCH[target].deb;
  if (!arch) return null;
  if (!has("dpkg-deb")) return { skipped: "dpkg-deb is not installed" };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "telo-deb-"));
  const binDir = path.join(staging, "usr", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(dir, "telo"), path.join(binDir, "telo"));
  fs.chmodSync(path.join(binDir, "telo"), 0o755);
  const control = path.join(staging, "DEBIAN");
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(
    path.join(control, "control"),
    [
      "Package: telo",
      `Version: ${version}`,
      `Architecture: ${arch}`,
      "Maintainer: Telo <noreply@telo.run>",
      "Section: devel",
      "Priority: optional",
      "Description: Telo — a declarative runtime for YAML manifests.",
      " The standalone build: one executable, no Node.js required.",
      "",
    ].join("\n"),
  );
  const out = path.join(dir, `telo_${version}_${arch}.deb`);
  run("dpkg-deb", ["--build", "--root-owner-group", staging, out]);
  return out;
}

/** An RPM, built from the same one-file payload. Skipped when `rpmbuild` is
 *  absent, which is reported by the caller rather than silently swallowed. */
function buildRpm({ target, version, dir }) {
  const arch = TARGET_ARCH[target].rpm;
  if (!arch) return null;
  if (!has("rpmbuild")) return { skipped: "rpmbuild is not installed" };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-rpm-"));
  for (const sub of ["BUILD", "RPMS", "SOURCES", "SPECS", "BUILDROOT"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const spec = path.join(root, "SPECS", "telo.spec");
  fs.writeFileSync(
    spec,
    [
      "Name: telo",
      `Version: ${version}`,
      "Release: 1",
      "Summary: Telo — a declarative runtime for YAML manifests",
      "License: SEE LICENSE IN LICENSE",
      `BuildArch: ${arch}`,
      "%description",
      "The standalone build: one executable, no Node.js required.",
      "%install",
      "mkdir -p %{buildroot}/usr/bin",
      `install -m 0755 ${path.join(dir, "telo")} %{buildroot}/usr/bin/telo`,
      "%files",
      "/usr/bin/telo",
      "",
    ].join("\n"),
  );
  run("rpmbuild", ["--define", `_topdir ${root}`, "-bb", spec]);
  const built = path.join(root, "RPMS", arch, `telo-${version}-1.${arch}.rpm`);
  const out = path.join(dir, path.basename(built));
  fs.copyFileSync(built, out);
  return out;
}

/** A macOS installer package. `pkgbuild` ships with the Xcode command line
 *  tools, which every macOS runner has. */
function buildPkg({ target, version, dir }) {
  if (!has("pkgbuild")) return { skipped: "pkgbuild is not available" };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "telo-pkg-"));
  const binDir = path.join(staging, "usr", "local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(dir, "telo"), path.join(binDir, "telo"));
  fs.chmodSync(path.join(binDir, "telo"), 0o755);
  const out = path.join(dir, `telo-${version}-${target}.pkg`);
  run("pkgbuild", [
    "--root",
    staging,
    "--identifier",
    "run.telo.cli",
    "--version",
    version,
    "--install-location",
    "/",
    out,
  ]);
  return out;
}

/** A Windows installer, named per target. WiX is not present on a stock runner,
 *  so the `.zip` is the guaranteed artifact and the `.msi` is built when the
 *  toolchain is there. */
function buildMsi({ target, version, dir }) {
  if (!has("wix")) return { skipped: "the WiX toolset is not installed" };
  const wxs = path.join(dir, "telo.wxs");
  fs.writeFileSync(
    wxs,
    `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Telo CLI" Manufacturer="Telo" Version="${version}" UpgradeCode="6F1F6A1E-9F0A-4F3A-9A3F-1B0C7E5D42A7" Scope="perMachine">
    <MajorUpgrade DowngradeErrorMessage="A newer version of Telo is already installed." />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Telo">
        <Component Id="TeloExe" Guid="*">
          <File Id="telo.exe" Source="${path.join(dir, "telo.exe")}" KeyPath="yes" />
          <Environment Id="TeloPath" Name="PATH" Value="[INSTALLFOLDER]" Part="last" Action="set" System="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="Main">
      <ComponentRef Id="TeloExe" />
    </Feature>
  </Package>
</Wix>
`,
  );
  // Per target, not per platform: both Windows jobs write into one release, so
  // one name for two architectures is an upload collision in which whichever
  // job finishes second silently replaces the other's installer.
  const out = path.join(dir, `telo-${version}-${target}.msi`);
  run("wix", ["build", wxs, "-o", out]);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const produced = [];
  const skipped = [];

  const record = (result) => {
    if (!result) return;
    if (typeof result === "string") produced.push(result);
    else skipped.push(result.skipped);
  };

  record(buildArchive(args));
  if (args.target.startsWith("linux")) {
    record(buildDeb(args));
    record(buildRpm(args));
  } else if (args.target.startsWith("darwin")) {
    record(buildPkg(args));
  } else if (args.target.startsWith("windows")) {
    record(buildMsi(args));
  }

  // A checksum beside every artifact, in the `sha256sum -c` format the install
  // scripts read. Only the bare binary had one, so the archives they actually
  // download had nothing to verify against.
  for (const file of produced) {
    const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
  }

  for (const file of produced) process.stderr.write(`packaged ${file}\n`);
  for (const reason of skipped) process.stderr.write(`NOT packaged: ${reason}\n`);
  // A release that quietly lost a format is the thing nobody notices until
  // someone cannot install it, so a skip fails the build that made it.
  if (skipped.length > 0 && !args.optional) {
    throw new Error(
      `${skipped.length} package format(s) could not be built for ${args.target}. ` +
        `Install the tools named above on this runner, or pass --optional for a local build.`,
    );
  }
}

main();
