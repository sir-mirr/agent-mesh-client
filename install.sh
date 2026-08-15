#!/bin/sh
set -eu

REPOSITORY="sir-mirr/agent-mesh-client"
VERSION="${AGENT_MESH_VERSION:-latest}"
INSTALL_DIRECTORY="${AGENT_MESH_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET="darwin-arm64" ;;
  Darwin-x86_64) TARGET="darwin-x64" ;;
  Linux-x86_64) TARGET="linux-x64" ;;
  Linux-aarch64|Linux-arm64) TARGET="linux-arm64" ;;
  *) printf '%s\n' "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  RELEASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
else
  RELEASE_URL="https://github.com/$REPOSITORY/releases/download/$VERSION"
fi

ARCHIVE="agent-mesh-$TARGET.tar.gz"
TEMP_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIRECTORY"' EXIT HUP INT TERM

curl -fL --proto '=https' --tlsv1.2 "$RELEASE_URL/$ARCHIVE" -o "$TEMP_DIRECTORY/$ARCHIVE"
curl -fL --proto '=https' --tlsv1.2 "$RELEASE_URL/SHA256SUMS" -o "$TEMP_DIRECTORY/SHA256SUMS"

EXPECTED="$(awk -v file="$ARCHIVE" '$2 == file { print $1 }' "$TEMP_DIRECTORY/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then
  printf '%s\n' "No checksum published for $ARCHIVE" >&2
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TEMP_DIRECTORY/$ARCHIVE" | awk '{ print $1 }')"
else
  ACTUAL="$(sha256sum "$TEMP_DIRECTORY/$ARCHIVE" | awk '{ print $1 }')"
fi
[ "$EXPECTED" = "$ACTUAL" ] || { printf '%s\n' "Checksum verification failed" >&2; exit 1; }

mkdir -p "$INSTALL_DIRECTORY"
tar -xzf "$TEMP_DIRECTORY/$ARCHIVE" -C "$TEMP_DIRECTORY"
install -m 0755 "$TEMP_DIRECTORY/agent-mesh" "$INSTALL_DIRECTORY/agent-mesh"

printf '%s\n' "Installed $INSTALL_DIRECTORY/agent-mesh"
printf '%s\n' "Run: $INSTALL_DIRECTORY/agent-mesh"
