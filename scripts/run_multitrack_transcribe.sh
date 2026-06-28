#!/bin/bash
#
# 多轨项目转录流水线
# 用法: ./run_multitrack_transcribe.sh <project.json> <base_output_dir> [--flash|--v3-standard|--auto]
#
# 输出: base_output_dir/1_转录/
#   ├── review_mix.mp3
#   ├── volcengine_v3_result.json
#   └── subtitles_words.json

set -e

PROJECT_FILE="$1"
BASE_DIR="${2:-.}"
ENGINE="auto"

for arg in "$@"; do
  case "$arg" in
    --v3-standard) ENGINE="v3-standard" ;;
    --flash)       ENGINE="flash" ;;
    --auto)        ENGINE="auto" ;;
  esac
done

if [ -z "$PROJECT_FILE" ]; then
  echo "用法: $0 <project.json> <base_output_dir> [--flash|--v3-standard|--auto]"
  exit 1
fi

if [ ! -f "$PROJECT_FILE" ]; then
  echo "❌ project.json 不存在: $PROJECT_FILE"
  exit 1
fi

for cmd in ffmpeg node python3 curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ 缺少依赖: $cmd"
    exit 1
  fi
done

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUTF8=1

TOGGLE_STATE=""
if [ "$ENGINE" = "auto" ]; then
  STATE="$SKILL_DIR/.engine_toggle"
  [ "$(cat "$STATE" 2>/dev/null)" = "flash" ] && ENGINE="v3-standard" || ENGINE="flash"
  TOGGLE_STATE="$STATE"
  echo "🔄 auto 轮流：本次用 $ENGINE"
fi

TRANSCRIBE_DIR="$BASE_DIR/1_转录"
mkdir -p "$TRANSCRIBE_DIR"

echo "🎚️ 步骤1: 渲染多轨审核音频..."
node "$SKILL_DIR/scripts/render_timeline_audio.js" "$PROJECT_FILE" "$TRANSCRIBE_DIR/review_mix.mp3"
cp "$TRANSCRIBE_DIR/review_mix.mp3" "$TRANSCRIBE_DIR/audio.mp3"

echo "🚀 步骤2+3: 转录（引擎: $ENGINE）..."
case "$ENGINE" in
  flash)
    bash "$SKILL_DIR/scripts/volcengine_flash_transcribe.sh" "$TRANSCRIBE_DIR/review_mix.mp3" "$TRANSCRIBE_DIR"
    RESULT_FILE="$TRANSCRIBE_DIR/volcengine_v3_result.json"
    ;;
  v3-standard)
    bash "$SKILL_DIR/scripts/volcengine_v3_transcribe.sh" "$TRANSCRIBE_DIR/review_mix.mp3" "$TRANSCRIBE_DIR"
    RESULT_FILE="$TRANSCRIBE_DIR/volcengine_v3_result.json"
    ;;
  *)
    echo "❌ 未知引擎: $ENGINE"
    exit 1
    ;;
esac

[ -n "$TOGGLE_STATE" ] && echo "$ENGINE" > "$TOGGLE_STATE"

echo "📝 步骤4: 生成字幕..."
node "$SKILL_DIR/scripts/generate_subtitles.js" "$RESULT_FILE" "" "$TRANSCRIBE_DIR"

echo ""
echo "🎉 多轨转录完成！"
echo "   输出目录: $TRANSCRIBE_DIR"
