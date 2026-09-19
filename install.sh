#!/bin/sh
# Install the standalone `telo` executable.
#
#   curl -fsSL https://telo.run/install.sh | sh
#
# Downloads the release archive for this machine and puts one file on PATH.
# Nothing is compiled, no package manager is involved, and Node.js is not
# required — the binary carries its own runtime.
#
#   TELO_VERSION   version to install (default: the latest release)
#   TELO_INSTALL   directory to install into (default: /usr/local/bin, or
#                  ~/.local/bin when that is not writable)

set -eu

REPO="${TELO_REPO:-telorun/telo}"

fail() {
  echo "install.sh: $1" >&2
  exit 1
}

# The target the release assets are named by, in Telo's own platform vocabulary
# (`<os>-<arch>[-<libc>]`, the tokens `native:` entries and `telo install
# --platform` use). Anything else has no build: said plainly here, rather than
# downloading a 404 and reporting a tar error.
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux)
      # musl and glibc builds are not interchangeable; `ldd` names which one
      # this system links against.
      if ldd /bin/sh 2>&1 | grep -qi musl; then libc="-musl"; else libc="-gnu"; fi
      case "$arch" in
        x86_64) echo "linux-amd64$libc" ;;
        aarch64 | arm64)
          [ "$libc" = "-gnu" ] || fail "there is no linux-arm64 musl build: Node.js publishes no such runtime."
          echo "linux-arm64-gnu"
          ;;
        *) fail "unsupported architecture: $arch" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64) echo "darwin-amd64" ;;
        arm64) echo "darwin-arm64" ;;
        *) fail "unsupported architecture: $arch" ;;
      esac
      ;;
    *) fail "unsupported system: $os (on Windows use install.ps1)" ;;
  esac
}

# Where a binary can actually be written, preferring the system location but
# never requiring root: a `curl | sh` that fails on permissions at the last step
# has already spent the download.
choose_dir() {
  if [ -n "${TELO_INSTALL:-}" ]; then echo "$TELO_INSTALL"; return; fi
  if [ -w /usr/local/bin ] 2>/dev/null; then echo /usr/local/bin; return; fi
  echo "$HOME/.local/bin"
}

TARGET=$(detect_target)
DIR=$(choose_dir)

if [ -n "${TELO_VERSION:-}" ]; then
  VERSION="$TELO_VERSION"
else
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name" *: *"v\([^"]*\)".*/\1/p' | head -1)
  [ -n "$VERSION" ] || fail "could not determine the latest version; set TELO_VERSION."
fi

ASSET="telo-$VERSION-$TARGET.tar.gz"
URL="https://github.com/$REPO/releases/download/v$VERSION/$ASSET"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP/$ASSET" || fail "could not download $URL"

# The release publishes a checksum beside every archive; checking it is what
# turns a truncated or tampered download into a refusal here rather than a
# confusing failure later. Skipped only when no digest tool exists, which is
# said out loud rather than passed over.
if curl -fsSL "$URL.sha256" -o "$TMP/$ASSET.sha256" 2>/dev/null; then
  EXPECTED=$(cut -d" " -f1 < "$TMP/$ASSET.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$TMP/$ASSET" | cut -d" " -f1)
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | cut -d" " -f1)
  else
    ACTUAL=""
    echo "install.sh: no sha256 tool found; skipping checksum verification" >&2
  fi
  [ -z "$ACTUAL" ] || [ "$ACTUAL" = "$EXPECTED" ] ||
    fail "checksum mismatch for $ASSET: expected $EXPECTED, got $ACTUAL"
else
  echo "install.sh: no published checksum for $ASSET; continuing" >&2
fi

tar xzf "$TMP/$ASSET" -C "$TMP"

mkdir -p "$DIR"
install -m 0755 "$TMP/telo-$VERSION-$TARGET/telo" "$DIR/telo"

echo "installed telo $VERSION to $DIR/telo"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "note: $DIR is not on your PATH." ;;
esac
