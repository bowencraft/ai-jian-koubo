#!/bin/bash
#
# Package a generated review directory into a self-contained folder that can be
# shared with another editor. The package includes the review UI/data/audio,
# the minimal Node backend, and launch scripts.
#
# Usage:
#   bash scripts/package_review.sh <3_审核_dir> [output_parent_dir]
#
# Example:
#   bash scripts/package_review.sh \
#     "/path/to/output/.../剪口播/3_审核" \
#     "/path/to/share"

set -euo pipefail

REVIEW_DIR="${1:-}"
OUT_PARENT="${2:-}"

if [ -z "$REVIEW_DIR" ]; then
  echo "Usage: $0 <3_审核_dir> [output_parent_dir]" >&2
  exit 1
fi

if [ ! -d "$REVIEW_DIR" ]; then
  echo "Review directory not found: $REVIEW_DIR" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REVIEW_DIR="$(cd "$REVIEW_DIR" && pwd)"

if [ -z "$OUT_PARENT" ]; then
  OUT_PARENT="$(dirname "$REVIEW_DIR")"
fi
mkdir -p "$OUT_PARENT"
OUT_PARENT="$(cd "$OUT_PARENT" && pwd)"

for required in review.html data.json audio.mp3; do
  if [ ! -f "$REVIEW_DIR/$required" ]; then
    echo "Required review file missing: $REVIEW_DIR/$required" >&2
    exit 1
  fi
done

BASE_NAME="$(basename "$(dirname "$REVIEW_DIR")")"
STAMP="$(date +%Y%m%d_%H%M%S)"
PACKAGE_DIR="$OUT_PARENT/${BASE_NAME}_review_package_$STAMP"

mkdir -p "$PACKAGE_DIR/review" "$PACKAGE_DIR/server/lib"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
  fi
}

copy_dir_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -d "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -R "$src" "$dst"
  fi
}

copy_json_without_waveforms() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$src" ]; then
    return
  fi
  node - "$src" "$dst" <<'NODE'
const fs = require('fs');
const src = process.argv[2];
const dst = process.argv[3];
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([key, child]) => {
      if (key !== 'waveform') out[key] = strip(child);
    });
    return out;
  }
  return value;
}
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.writeFileSync(dst, JSON.stringify(strip(data), null, 2));
NODE
}

cp "$REVIEW_DIR/review.html" "$PACKAGE_DIR/review/review.html"
copy_json_without_waveforms "$REVIEW_DIR/data.json" "$PACKAGE_DIR/review/data.json"
cp "$REVIEW_DIR/audio.mp3" "$PACKAGE_DIR/review/audio.mp3"
copy_if_exists "$REVIEW_DIR/editor.html" "$PACKAGE_DIR/review/editor.html"
copy_if_exists "$REVIEW_DIR/editor.css" "$PACKAGE_DIR/review/editor.css"
copy_if_exists "$REVIEW_DIR/editor.js" "$PACKAGE_DIR/review/editor.js"
copy_if_exists "$REVIEW_DIR/review.css" "$PACKAGE_DIR/review/review.css"
copy_if_exists "$REVIEW_DIR/review.js" "$PACKAGE_DIR/review/review.js"
copy_json_without_waveforms "$REVIEW_DIR/project.json" "$PACKAGE_DIR/review/project.json"
copy_if_exists "$REVIEW_DIR/review_draft.json" "$PACKAGE_DIR/review/review_draft.json"
copy_if_exists "$REVIEW_DIR/peaks.json" "$PACKAGE_DIR/review/peaks.json"
copy_if_exists "$REVIEW_DIR/silence_periods.json" "$PACKAGE_DIR/review/silence_periods.json"
copy_dir_if_exists "$REVIEW_DIR/media" "$PACKAGE_DIR/review/media"
if [ ! -d "$PACKAGE_DIR/review/media" ]; then
  copy_dir_if_exists "$(dirname "$REVIEW_DIR")/media" "$PACKAGE_DIR/review/media"
fi

cp "$SCRIPT_DIR/review_server.js" "$PACKAGE_DIR/server/review_server.js"
cp "$SCRIPT_DIR/lib/compute_keeps.js" "$PACKAGE_DIR/server/lib/compute_keeps.js"
cp "$SCRIPT_DIR/lib/fcpxml.js" "$PACKAGE_DIR/server/lib/fcpxml.js"
cp "$SCRIPT_DIR/lib/review_exports.js" "$PACKAGE_DIR/server/lib/review_exports.js"
cp "$SCRIPT_DIR/lib/refine_boundaries.js" "$PACKAGE_DIR/server/lib/refine_boundaries.js"
cp "$SCRIPT_DIR/lib/timeline_project.js" "$PACKAGE_DIR/server/lib/timeline_project.js"
cp "$SCRIPT_DIR/lib/asset_dedupe.js" "$PACKAGE_DIR/server/lib/asset_dedupe.js"

cat > "$PACKAGE_DIR/start.sh" <<'EOF'
#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8900}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org/ and run this again." >&2
  exit 1
fi

cd "$DIR/review"
echo "Starting review server..."
echo "Open: http://localhost:$PORT"
node "$DIR/server/review_server.js" "$PORT" "$DIR/review/audio.mp3"
EOF

cat > "$PACKAGE_DIR/start.command" <<'EOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$DIR/start.sh"
EOF

cat > "$PACKAGE_DIR/README.md" <<'EOF'
# Review Package

This folder contains a portable review session for AI剪口播.

## Start

macOS: double-click `start.command`.

Terminal:

```bash
bash start.sh
```

Then open:

```text
http://localhost:8900
```

If port 8900 is busy:

```bash
PORT=8901 bash start.sh
```

## Contents

- `review/` contains the current review page, multitrack editor/project JSON when present, transcript JSON, audio, media files, and optional saved progress.
- `server/` contains the local Node backend needed for saving progress and exporting FCPXML.

Do not open `review/review.html` directly with `file://`; use the local server above.
EOF

chmod +x "$PACKAGE_DIR/start.sh" "$PACKAGE_DIR/start.command"

echo "$PACKAGE_DIR"
