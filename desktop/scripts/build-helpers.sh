#!/bin/bash
# 把 ../apple_asr/*.swift 编译成苹果芯片 + Intel 通用二进制，放到 build/bin/
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../apple_asr
OUT=build/bin
mkdir -p "$OUT"

build() { # 名字 源文件 最低系统版本
  local name=$1 src=$2 min=$3
  if [ "$OUT/$name" -nt "$SRC/$src" ]; then return; fi  # 源码没变就不重编
  for arch in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$arch-apple-macos$min" "$SRC/$src" -o "$OUT/$name-$arch"
  done
  lipo -create "$OUT/$name-arm64" "$OUT/$name-x86_64" -output "$OUT/$name"
  rm "$OUT/$name-arm64" "$OUT/$name-x86_64"
  codesign --force --sign - "$OUT/$name"
  echo "已编译 $name"
}

build apple_asr main.swift 26.0       # 苹果语音识别（SpeechAnalyzer）
build apple_translate translate.swift 26.0  # 苹果翻译
build syscap syscap.swift 14.2        # 电脑内部声音（Core Audio Tap）
