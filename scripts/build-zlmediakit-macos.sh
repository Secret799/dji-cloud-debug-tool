#!/usr/bin/env bash
set -euo pipefail

ZLM_COMMIT="fdaec2604d4091886158cbaca39dca2b5e5d25db"
ZLTOOLKIT_COMMIT="b311fdef4c9aabb94d33579e0a3810e6db7810c2"
MEDIA_SERVER_COMMIT="21c4451ff2e4c4bb1c817e606c8b4e5deac1e719"
JSONCPP_COMMIT="ca98c98457b1163cca1f7d8db62827c115fec6d1"
LIBSRTP_COMMIT="fd08747fa6800b321d53e15feb34da12dc697dee"
OPENSSL_VERSION="3.6.3"
OPENSSL_SHA256="243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_ROOT="${ZLM_OUTPUT_ROOT:-$PROJECT_ROOT/vendor/zlmediakit}"
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
SRTP_SOURCE_DIR="$ZLM_TMP/libsrtp-source"
SRTP_BUILD_DIR="$ZLM_TMP/libsrtp-build"
SRTP_INSTALL_DIR="$ZLM_TMP/libsrtp-install"
OPENSSL_SOURCE_DIR="$ZLM_TMP/openssl-source"
OPENSSL_INSTALL_DIR="$ZLM_TMP/openssl-install"
OPENSSL_ROOT="${ZLM_OPENSSL_ROOT:-$OPENSSL_INSTALL_DIR}"
mkdir -p "$SOURCE_DIR"

download_and_extract() {
  local repository="$1"
  local commit="$2"
  local destination="$3"
  local archive="$ZLM_TMP/$(echo "$repository" | tr '/' '-').tar.gz"
  local curl_args=(--fail --location --retry 3 --silent --show-error)
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl_args+=(--header "Authorization: Bearer $GITHUB_TOKEN")
  fi
  mkdir -p "$destination"
  curl "${curl_args[@]}" --output "$archive" "https://api.github.com/repos/$repository/tarball/$commit"
  tar -xzf "$archive" -C "$destination" --strip-components=1
}

download_and_extract "ZLMediaKit/ZLMediaKit" "$ZLM_COMMIT" "$SOURCE_DIR"
download_and_extract "ZLMediaKit/ZLToolKit" "$ZLTOOLKIT_COMMIT" "$SOURCE_DIR/3rdpart/ZLToolKit"
download_and_extract "ireader/media-server" "$MEDIA_SERVER_COMMIT" "$SOURCE_DIR/3rdpart/media-server"
download_and_extract "open-source-parsers/jsoncpp" "$JSONCPP_COMMIT" "$SOURCE_DIR/3rdpart/jsoncpp"
download_and_extract "cisco/libsrtp" "$LIBSRTP_COMMIT" "$SRTP_SOURCE_DIR"

BUILD_JOBS="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
if [[ -n "${ZLM_OPENSSL_ROOT:-}" ]]; then
  for required_file in include/openssl/ssl.h lib/libssl.a lib/libcrypto.a; do
    if [[ ! -f "$OPENSSL_ROOT/$required_file" ]]; then
      echo "ZLM_OPENSSL_ROOT is missing $required_file: $OPENSSL_ROOT" >&2
      exit 1
    fi
  done
else
  OPENSSL_ARCHIVE="$ZLM_TMP/openssl.tar.gz"
  curl --fail --location --retry 3 --silent --show-error \
    --output "$OPENSSL_ARCHIVE" \
    "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"
  OPENSSL_ACTUAL_SHA256="$(shasum -a 256 "$OPENSSL_ARCHIVE" | awk '{print $1}')"
  if [[ "$OPENSSL_ACTUAL_SHA256" != "$OPENSSL_SHA256" ]]; then
    echo "OpenSSL source SHA-256 mismatch: expected $OPENSSL_SHA256, got $OPENSSL_ACTUAL_SHA256" >&2
    exit 1
  fi
  mkdir -p "$OPENSSL_SOURCE_DIR"
  tar -xzf "$OPENSSL_ARCHIVE" -C "$OPENSSL_SOURCE_DIR" --strip-components=1

  OPENSSL_TARGET="darwin64-arm64-cc"
  if [[ "$OUTPUT_ARCH" == "x64" ]]; then
    OPENSSL_TARGET="darwin64-x86_64-cc"
  fi
  pushd "$OPENSSL_SOURCE_DIR" >/dev/null
  ./Configure "$OPENSSL_TARGET" \
    no-shared \
    no-tests \
    no-docs \
    --prefix="$OPENSSL_INSTALL_DIR" \
    --openssldir="$OPENSSL_INSTALL_DIR/ssl"
  make -j"${BUILD_JOBS:-2}"
  make install_sw
  popd >/dev/null
fi

cmake -S "$SRTP_SOURCE_DIR" -B "$SRTP_BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$TARGET_ARCH" \
  -DCMAKE_INSTALL_PREFIX="$SRTP_INSTALL_DIR" \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_OPENSSL=OFF \
  -DLIBSRTP_TEST_APPS=OFF
cmake --build "$SRTP_BUILD_DIR" --target install --config Release -j "${BUILD_JOBS:-2}"

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$TARGET_ARCH" \
  -DENABLE_API=OFF \
  -DENABLE_FFMPEG=OFF \
  -DENABLE_OPENSSL=ON \
  -DOPENSSL_USE_STATIC_LIBS=TRUE \
  -DOPENSSL_ROOT_DIR="$OPENSSL_ROOT" \
  -DSRTP_PREFIX="$SRTP_INSTALL_DIR" \
  -DENABLE_WEBRTC=ON \
  -DENABLE_SRT=OFF \
  -DENABLE_TESTS=OFF \
  -DENABLE_OBJCOPY=OFF \
  -DDISABLE_REPORT=ON
if ! grep -Rqs -- '-DENABLE_WEBRTC' "$BUILD_DIR/src" "$BUILD_DIR/webrtc"; then
  echo "ZLMediaKit configuration did not enable WebRTC; verify OpenSSL and libsrtp" >&2
  exit 1
fi
cmake --build "$BUILD_DIR" --target MediaServer --config Release -j "${BUILD_JOBS:-2}"

DESTINATION="$OUTPUT_ROOT/$OUTPUT_ARCH"
mkdir -p "$DESTINATION"
cp "$SOURCE_DIR/release/darwin/Release/MediaServer" "$DESTINATION/MediaServer"
chmod 755 "$DESTINATION/MediaServer"
cp "$SOURCE_DIR/LICENSE" "$OUTPUT_ROOT/LICENSE"
echo "Built ZLMediaKit $ZLM_COMMIT for $OUTPUT_ARCH: $DESTINATION/MediaServer"
