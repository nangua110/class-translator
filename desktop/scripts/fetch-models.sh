#!/bin/bash
# 下载本地实时识别用的英语模型（Kroko 社区模型，CC-BY-SA）。66 MB，不进 git。
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06
OUT=models/kroko-en
if [ -f "$OUT/encoder.onnx" ] && [ -f "$OUT/tokens.txt" ]; then exit 0; fi
TMP=$(mktemp -d)
gh release download asr-models -R k2-fsa/sherpa-onnx -p "$NAME.tar.bz2" -D "$TMP"
tar xjf "$TMP/$NAME.tar.bz2" -C "$TMP"
mkdir -p "$OUT"
cp "$TMP/$NAME/encoder.onnx" "$TMP/$NAME/decoder.onnx" "$TMP/$NAME/joiner.onnx" "$TMP/$NAME/tokens.txt" "$OUT/"
rm -rf "$TMP"
echo "已下载模型到 $OUT"
