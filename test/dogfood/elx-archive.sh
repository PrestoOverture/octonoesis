#!/usr/bin/env bash
# Archive an ELX run directory to Google Drive (streaming mode) and verify the copy.
# Usage: test/dogfood/elx-archive.sh <run-dir> [--delete-local]
#   --delete-local removes the local run dir after a verified archive; refused while the
#   run is locked (in progress). Without it the archive is a snapshot backup.
set -euo pipefail
RUN="${1:?run dir}"
DELETE="${2:-}"
RUN="$(cd "$RUN" && pwd)"
NAME="$(basename "$RUN")"
DRIVE="$(ls -d "$HOME"/Library/CloudStorage/GoogleDrive-*/"My Drive" 2>/dev/null | head -1)"
[ -n "$DRIVE" ] || { echo "Google Drive (My Drive) not mounted" >&2; exit 1; }
DEST="$DRIVE/octonoesis-elx"
mkdir -p "$DEST"
if [ -e "$RUN/.run-lock" ] && [ "$DELETE" = "--delete-local" ]; then
  echo "Run is locked (in progress); refusing --delete-local" >&2
  exit 1
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/$NAME-$STAMP.tar.gz"
tar czf "$OUT.partial" -C "$(dirname "$RUN")" "$NAME"
gzip -t "$OUT.partial"
want="$(cd "$(dirname "$RUN")" && find "$NAME" | wc -l | tr -d ' ')"
got="$(tar tzf "$OUT.partial" | wc -l | tr -d ' ')"
[ "$want" = "$got" ] || { echo "Entry count mismatch: $want local vs $got archived" >&2; exit 1; }
mv "$OUT.partial" "$OUT"
shasum -a 256 "$OUT" | awk '{print $1}' > "$OUT.sha256"
echo "Archived $NAME → $OUT ($(du -h "$OUT" | cut -f1), $got entries)"
if [ "$DELETE" = "--delete-local" ]; then
  rm -rf "$RUN"
  echo "Deleted local $RUN"
fi
df -h /System/Volumes/Data | tail -1 | awk '{print "Local free:", $4}'
