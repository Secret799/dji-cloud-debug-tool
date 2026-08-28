#!/usr/bin/env bash
set -euo pipefail

TARGET_ARCH="${1:-$(uname -m)}"
case "$TARGET_ARCH" in
  arm64|aarch64)
    OUTPUT_ARCH="arm64"
    COMPILER_ARCH="arm64"
    MIN_MACOS_VERSION="11.0"
    ;;
  x64|x86_64|amd64)
    OUTPUT_ARCH="x64"
    COMPILER_ARCH="x86_64"
    MIN_MACOS_VERSION="10.15"
    ;;
  *)
    echo "Unsupported macOS architecture: $TARGET_ARCH" >&2
    exit 1
    ;;
esac

FFMPEG_VERSION="9.0.1"
SOURCE_SHA256="cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
BUILD_PROFILE="rtmp-relay-sei-lgpl-v3"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="$PROJECT_ROOT/vendor/ffmpeg/darwin-$OUTPUT_ARCH"
MARKER_VALUE="$SOURCE_SHA256:$BUILD_PROFILE:$OUTPUT_ARCH"
MARKER="$DESTINATION/.build-marker"
X86_ASM_OPTION=""

if [[ "$OUTPUT_ARCH" == "x64" ]] && ! command -v nasm >/dev/null 2>&1; then
  X86_ASM_OPTION="--disable-x86asm"
  echo "NASM is unavailable; building macOS x64 FFmpeg without x86 assembly optimizations."
fi

if [[ -x "$DESTINATION/ffmpeg" && -f "$DESTINATION/LICENSE" && -f "$MARKER" ]] &&
  [[ "$(tr -d '[:space:]' < "$MARKER")" == "$MARKER_VALUE" ]]; then
  echo "Bundled FFmpeg is already prepared for macOS $OUTPUT_ARCH."
  exit 0
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
ARCHIVE="$TEMP_DIR/ffmpeg.tar.xz"

if [[ -n "${FFMPEG_SOURCE_ARCHIVE:-}" ]]; then
  cp "$FFMPEG_SOURCE_ARCHIVE" "$ARCHIVE"
else
  curl --fail --location --retry 3 --silent --show-error --output "$ARCHIVE" "$SOURCE_URL"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$SOURCE_SHA256" ]]; then
  echo "SHA-256 mismatch for FFmpeg source: expected $SOURCE_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xf "$ARCHIVE" -C "$TEMP_DIR"
SOURCE_DIR="$TEMP_DIR/ffmpeg-$FFMPEG_VERSION"
BUILD_DIR="$TEMP_DIR/build"
mkdir -p "$BUILD_DIR"

pushd "$SOURCE_DIR" >/dev/null
./configure \
  --prefix="$BUILD_DIR" \
  --target-os=darwin \
  --arch="$COMPILER_ARCH" \
  --cc="clang -arch $COMPILER_ARCH" \
  --extra-cflags="-mmacosx-version-min=$MIN_MACOS_VERSION" \
  --extra-ldflags="-mmacosx-version-min=$MIN_MACOS_VERSION" \
  ${X86_ASM_OPTION:+"$X86_ASM_OPTION"} \
  --disable-autodetect \
  --disable-debug \
  --disable-doc \
  --disable-everything \
  --disable-ffplay \
  --disable-ffprobe \
  --enable-ffmpeg \
  --enable-small \
  --enable-network \
  --enable-securetransport \
  --enable-protocol=file,http,https,pipe,rtmp,rtmps,rtp,tcp,tls,udp \
  --enable-demuxer=flv,live_flv,rtsp \
  --enable-muxer=flv,h264,hevc,null \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb \
  --enable-parser=aac,h264,hevc

grep -q '^#define CONFIG_GPL 0$' config.h
grep -q '^#define CONFIG_NONFREE 0$' config.h
BUILD_JOBS="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
make -j"${BUILD_JOBS:-2}" ffmpeg
popd >/dev/null

BINARY="$SOURCE_DIR/ffmpeg"
if [[ ! -x "$BINARY" ]]; then
  echo "FFmpeg build did not produce an executable." >&2
  exit 1
fi
if [[ "$(lipo -archs "$BINARY")" != "$COMPILER_ARCH" ]]; then
  echo "FFmpeg binary architecture does not match $COMPILER_ARCH." >&2
  exit 1
fi
for capability in 'D rtsp' 'E h264' 'E hevc' 'E null'; do
  capability_flag="${capability%% *}"
  capability_name="${capability#* }"
  if ! "$BINARY" -hide_banner -formats 2>/dev/null |
    awk -v flag="$capability_flag" -v name="$capability_name" '$1 ~ flag && $2 == name { found = 1 } END { exit !found }'; then
    echo "FFmpeg build is missing required format capability: $capability" >&2
    exit 1
  fi
done
for filter in h264_mp4toannexb hevc_mp4toannexb; do
  if ! "$BINARY" -hide_banner -bsfs 2>/dev/null | grep -Fxq "$filter"; then
    echo "FFmpeg build is missing required bitstream filter: $filter" >&2
    exit 1
  fi
done

mkdir -p "$DESTINATION"
install -m 0755 "$BINARY" "$DESTINATION/ffmpeg"
install -m 0644 "$SOURCE_DIR/COPYING.LGPLv2.1" "$DESTINATION/LICENSE"
printf '%s\n' "$MARKER_VALUE" > "$MARKER"
cat > "$DESTINATION/SOURCE.txt" <<EOF
FFmpeg $FFMPEG_VERSION minimal LGPL build for macOS $OUTPUT_ARCH
$SOURCE_URL
SHA-256 (source archive): $SOURCE_SHA256
Build profile: $BUILD_PROFILE
Enabled use cases: RTMP/RTMPS relay to FLV, and RTSP H.264/H.265 Annex-B extraction for SEI parsing
EOF

file "$DESTINATION/ffmpeg"
