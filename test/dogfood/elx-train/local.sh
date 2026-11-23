#!/usr/bin/env bash
# ELX steps that run on the Mac. The harness stays here and reaches the student through an SSH
# tunnel, so only the scrubbed subsets and this directory ever go to the GPU box.
#   ./local.sh verify | upload <ssh-host> | tunnel <ssh-host> | smoke [run-name] | p1 [run-name]
#   ./local.sh pull <ssh-host> <100|300|800>
# ELX_DRY=1 prints the commands instead of running them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUTPUT="$HOME/projects/octonoesis-dogfood"
SUBSETS="$OUTPUT/elx-p2-subsets"
UPLOADS=(lora-100.jsonl lora-300.jsonl lora-800.jsonl reserve.jsonl manifest.json)
CODE=(encode.py train.py dummy_adapter.py gpu.sh hyperparameters.json requirements.txt)

run() {
  if [ "${ELX_DRY:-}" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

drive_dir() {
  local drive
  drive=$(ls -d "$HOME"/Library/CloudStorage/GoogleDrive-*/My\ Drive 2>/dev/null | head -1)
  [ -n "$drive" ] || { echo "Google Drive is not mounted." >&2; exit 1; }
  printf '%s/octonoesis-elx' "$drive"
}

# Refuses anything that differs from the manifest or still carries local identity.
verify() {
  bun --no-env-file -e '
    import { createHash } from "node:crypto"
    import { readFileSync } from "node:fs"
    import os from "node:os"
    import path from "node:path"
    import { leakCheck } from "'"$REPO"'/test/dogfood/elx-dataset"
    const dir = process.argv[1]
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"))
    for (const [name, entry] of Object.entries(manifest.files)) {
      const text = readFileSync(path.join(dir, name), "utf8")
      if (createHash("sha256").update(text).digest("hex") !== entry.sha256)
        throw new Error(`${name}: hash differs from manifest`)
      const leaks = leakCheck(text, [], os.userInfo().username)
      if (leaks.length) throw new Error(`${name}: ${leaks.join(", ")}`)
    }
    console.log(`verified ${Object.keys(manifest.files).length} files`)
  ' "$SUBSETS"
}

student_env() {
  export LLM_PROVIDER=openai OPENAI_BASE_URL=http://127.0.0.1:8000/v1 OPENAI_API_KEY=elx-local
}

harness() {
  student_env
  cd "$REPO"
  run bun --no-env-file test/dogfood/run.ts --calibrate --capture --provider openai --model student "$@"
}

case "${1:-}" in
verify) verify ;;
upload)
  host="${2:?usage: local.sh upload <ssh-host>}"
  verify
  run ssh "$host" 'mkdir -p ~/elx/data ~/elx/code'
  run rsync -av --chmod=F600 "${UPLOADS[@]/#/$SUBSETS/}" "$host:elx/data/"
  run rsync -av "${CODE[@]/#/$HERE/}" "$host:elx/code/"
  ;;
tunnel)
  host="${2:?usage: local.sh tunnel <ssh-host>}"
  run ssh -N -L 127.0.0.1:8000:127.0.0.1:8000 "$host"
  ;;
smoke)
  # Stream 12: smoke seeds are 11+, and 11 was used by the Spark capture smoke.
  harness --families elx-train --per-family 1 --stop-after-sessions 10 --stream-seed 12 \
    --concurrency 2 --output "$OUTPUT/${2:-elx-smoke-base}"
  ;;
p1)
  harness --per-family 10 --stream-seed 8 --concurrency 4 --output "$OUTPUT/${2:-elx-p1}"
  ;;
pull)
  host="${2:?usage: local.sh pull <ssh-host> <size>}"
  size="${3:?usage: local.sh pull <ssh-host> <size>}"
  # Straight to Drive: credit exhaustion deletes the box, and the Mac disk stays out of it.
  target="$(drive_dir)/adapters/lora-$size"
  run mkdir -p "$target"
  run rsync -av "$host:elx/runs/lora-$size/adapter" "$host:elx/runs/lora-$size/summary.json" \
    "$host:elx/runs/lora-$size/train_log.jsonl" "$target/"
  ;;
*)
  sed -n '2,6p' "$0"
  exit 2
  ;;
esac
