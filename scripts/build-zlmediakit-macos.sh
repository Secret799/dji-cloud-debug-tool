#!/usr/bin/env bash
set -euo pipefail

ZLM_COMMIT="fdaec2604d4091886158cbaca39dca2b5e5d25db"
ZLTOOLKIT_COMMIT="b311fdef4c9aabb94d33579e0a3810e6db7810c2"
MEDIA_SERVER_COMMIT="21c4451ff2e4c4bb1c817e606c8b4e5deac1e719"
JSONCPP_COMMIT="ca98c98457b1163cca1f7d8db62827c115fec6d1"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_ARCH="${1:-$(uname -m)}"
case "$TARGET_ARCH" in
  arm64) OUTPUT_ARCH="arm64" ;;
  x64|x86_64) TARGET_ARCH="x86_64"; OUTPUT_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: $TARGET_ARCH" >&2; exit 1 ;;
esac

ZLM_TMP="$(mktemp -d "${TMPDIR:-/tmp}/dji-zlm-build.XXXXXX")"
trap 'rm -rf "$ZLM_TMP"' EXIT
SOURCE_DIR="$ZLM_TMP/source"
BUILD_DIR="$ZLM_TMP/build"
mkdir -p "$SOURCE_DIR"

download_and_extract() {
  local repository="$1"
  local commit="$2"
  local destination="$3"
  local archive="$ZLM_TMP/$(echo "$repository" | tr '/' '-').tar.gz"
  mkdir -p "$destination"
  curl --fail --location --show-error --output "$archive" "https://api.github.com/repos/$repository/tarball/$commit"
  tar -xzf "$archive" -C "$destination" --strip-components=1
}

download_and_extract "ZLMediaKit/ZLMediaKit" "$ZLM_COMMIT" "$SOURCE_DIR"
download_and_extract "ZLMediaKit/ZLToolKit" "$ZLTOOLKIT_COMMIT" "$SOURCE_DIR/3rdpart/ZLToolKit"
download_and_extract "ireader/media-server" "$MEDIA_SERVER_COMMIT" "$SOURCE_DIR/3rdpart/media-server"
download_and_extract "open-source-parsers/jsoncpp" "$JSONCPP_COMMIT" "$SOURCE_DIR/3rdpart/jsoncpp"

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$TARGET_ARCH" \
  -DENABLE_API=OFF \
  -DENABLE_FFMPEG=OFF \
  -DENABLE_OPENSSL=OFF \
  -DENABLE_WEBRTC=OFF \
  -DENABLE_SRT=OFF \
  -DENABLE_TESTS=OFF \
  -DENABLE_OBJCOPY=OFF \
  -DDISABLE_REPORT=ON
cmake --build "$BUILD_DIR" --target MediaServer --config Release -j "$(sysctl -n hw.logicalcpu)"

DESTINATION="$PROJECT_ROOT/vendor/zlmediakit/$OUTPUT_ARCH"
mkdir -p "$DESTINATION"
cp "$SOURCE_DIR/release/darwin/Release/MediaServer" "$DESTINATION/MediaServer"
chmod 755 "$DESTINATION/MediaServer"
cp "$SOURCE_DIR/LICENSE" "$PROJECT_ROOT/vendor/zlmediakit/LICENSE"
echo "Built ZLMediaKit $ZLM_COMMIT for $OUTPUT_ARCH: $DESTINATION/MediaServer"
