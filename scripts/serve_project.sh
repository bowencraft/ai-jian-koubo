#!/bin/bash
#
# 启动多轨项目编辑器（转文字前的页面 1）
#
# 用法: serve_project.sh <project_dir> <server_js> [port|auto]

set -e

PROJECT_DIR="$1"
SERVER_JS="$2"
WANT_PORT="${3:-auto}"

[ -n "$PROJECT_DIR" ] || { echo "❌ 缺少 project_dir"; exit 1; }
[ -f "$SERVER_JS" ] || { echo "❌ 找不到 review_server.js: $SERVER_JS"; exit 1; }
mkdir -p "$PROJECT_DIR"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "❌ 找不到 node，请先安装"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
copy_if_missing() {
  local src="$1"
  local dst="$2"
  [ -f "$dst" ] || cp "$src" "$dst"
}

copy_if_missing "$SCRIPT_DIR/templates/editor.html" "$PROJECT_DIR/editor.html"
copy_if_missing "$SCRIPT_DIR/templates/editor.css" "$PROJECT_DIR/editor.css"
copy_if_missing "$SCRIPT_DIR/templates/editor.js" "$PROJECT_DIR/editor.js"

if [ ! -f "$PROJECT_DIR/project.json" ]; then
  cat > "$PROJECT_DIR/project.json" <<'JSON'
{
  "version": 1,
  "name": "multitrack_project",
  "assets": [],
  "clips": []
}
JSON
fi

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ "$WANT_PORT" = "auto" ]; then
  PORT=""
  for p in 8899 8900 8901 8902 8903; do port_busy "$p" || { PORT="$p"; break; }; done
  [ -n "$PORT" ] || { echo "❌ 端口 8899-8903 都被占用"; exit 1; }
else
  PORT="$WANT_PORT"
fi

URL="http://localhost:$PORT/editor.html"

case "$(uname -s)" in
  Darwin) LAUNCHER="$PROJECT_DIR/启动素材编辑.command" ;;
  *)      LAUNCHER="$PROJECT_DIR/启动素材编辑.sh" ;;
esac

{
  printf '%s\n' '#!/bin/bash'
  printf '%s\n' '# 双击 / 运行本文件即可启动多轨素材编辑器；保持窗口开着。'
  printf 'cd "%s" || exit 1\n' "$PROJECT_DIR"
  printf 'exec "%s" "%s" %s\n' "$NODE_BIN" "$SERVER_JS" "$PORT"
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

SPAWNED=0
if [ -z "$SERVE_REVIEW_NO_SPAWN" ]; then
  case "$(uname -s)" in
    Darwin) open "$LAUNCHER" && SPAWNED=1 ;;
    Linux)
      for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
        command -v "$t" >/dev/null 2>&1 || continue
        setsid "$t" -e bash "$LAUNCHER" >/dev/null 2>&1 && { SPAWNED=1; break; }
      done
      ;;
    MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "素材编辑器" bash "$LAUNCHER" >/dev/null 2>&1 && SPAWNED=1 ;;
  esac
fi

READY=0
if [ "$SPAWNED" = 1 ]; then
  for _ in $(seq 1 16); do
    sleep 0.5
    if curl -sS "$URL" -o /dev/null 2>&1; then READY=1; break; fi
  done
fi

echo
if [ "$READY" = 1 ]; then
  echo "✅ 多轨素材编辑器已启动: $URL"
  open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || start "" "$URL" 2>/dev/null || true
else
  echo "⚠️ 没能自动开启独立终端。请手动运行并保持窗口开着："
  echo
  echo "      bash \"$LAUNCHER\""
  echo
  echo "然后访问: $URL"
fi
