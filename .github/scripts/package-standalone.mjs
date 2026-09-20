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
  "windows-amd64": { msi: "x64" },
  "windows-arm64": { msi: "arm64" },
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

/** Whether a tool is on PATH, decided by looking for it rather than by running
 *  it: `--version` is not a universal probe. `pkgbuild --version` TAKES a
 *  version, so probing that way reports the one tool macOS is guaranteed to
 *  have as missing — and a missing tool fails the build. */
function has(tool) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => fs.existsSync(path.join(dir, tool + ext))));
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
    // `Compress-Archive`, not `zip`: a Windows runner has PowerShell and does
    // NOT have `zip` — the Git-Bash toolset it ships carries no such binary,
    // and the release failed with `spawnSync zip ENOENT`.
    run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${path.join(dir, "telo.exe")}' -DestinationPath '${out}' -Force`,
    ]);
    return out;
  }
  const out = path.join(dir, `${name}.tar.gz`);
  // The binary is copied under a directory named after the release and that
  // directory is archived, so an extract cannot scatter a bare `telo` into the
  // current directory. Not `--transform`, which is GNU tar's: macOS ships
  // bsdtar, which answers `Option --transform is not supported` and fails the
  // only format both darwin targets have.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "telo-tar-"));
  fs.mkdirSync(path.join(staging, name));
  fs.copyFileSync(path.join(dir, "telo"), path.join(staging, name, "telo"));
  fs.chmodSync(path.join(staging, name, "telo"), 0o755);
  // Without this bsdtar writes an AppleDouble `._telo` beside the binary.
  run("tar", ["czf", out, "-C", staging, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
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
      // rpm's build-root policy scripts run over the payload, and the first of
      // them strips it. The binary is a finished artifact built for a target
      // that is not this builder, so `strip` reported `Unable to recognise the
      // format of the input file` and failed the arm64 build — and on the
      // target that did match it rewrote a file carrying an injected SEA blob.
      // Nothing here needs post-processing: one prebuilt executable is copied
      // into place.
      "%define __os_install_post %{nil}",
      "Name: telo",
      `Version: ${version}`,
      "Release: 1",
      "Summary: Telo — a declarative runtime for YAML manifests",
      "License: SEE LICENSE IN LICENSE",
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
  // The architecture is the command's, never the spec's. Measured: a spec
  // carrying `BuildArch: aarch64` is refused on an x64 builder — "No compatible
  // architectures found for build" — with or without `--target`, while the same
  // spec with no `BuildArch` and `--target aarch64` builds the arm64 package.
  // `BuildArch: noarch` is not the way out either: rpm refuses arch-dependent
  // binaries in a noarch package, which this is.
  run("rpmbuild", ["--define", `_topdir ${root}`, "--target", arch, "-bb", spec]);
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
 *  toolchain is there.
 *
 *  `MediaTemplate EmbedCab="yes"` is load-bearing: WiX's implicit default media
 *  does not embed, so the payload lands in a sibling `cab1.cab` while the
 *  release uploads the `.msi` alone — and installing that download fails with
 *  "cannot find the source file cab1.cab" beside wherever it was saved. */
function buildMsi({ target, version, dir }) {
  if (!has("wix")) return { skipped: "the WiX toolset is not installed" };
  const wxs = path.join(dir, "telo.wxs");
  fs.writeFileSync(
    wxs,
    `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Telo CLI" Manufacturer="Telo" Version="${version}" UpgradeCode="6F1F6A1E-9F0A-4F3A-9A3F-1B0C7E5D42A7" Scope="perMachine">
    <MajorUpgrade DowngradeErrorMessage="A newer version of Telo is already installed." />
    <MediaTemplate EmbedCab="yes" />
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
  // `-arch` is the package's, and it defaults to x86: an arm64 executable in a
  // 32-bit package installs to the wrong Program Files and is offered to the
  // wrong machines. It also has to agree with `ProgramFiles64Folder` above.
  run("wix", ["build", "-arch", TARGET_ARCH[target].msi, wxs, "-o", out]);
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
