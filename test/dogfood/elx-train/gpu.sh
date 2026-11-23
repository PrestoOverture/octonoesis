#!/usr/bin/env bash
# ELX steps that run ON the GPU box (AMD Developer Cloud, MI300X). Everything lives under $ELX_ROOT.
#   ./gpu.sh check | fetch | template | dummy | serve [name=adapter-dir ...] | stop | train <100|300|800>
# ELX_DRY=1 prints the commands instead of running them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELX_ROOT="${ELX_ROOT:-$HOME/elx}"
MODEL_REPO=$(python3 -c "import json;print(json.load(open('$HERE/hyperparameters.json'))['student'])")
REVISION=$(python3 -c "import json;print(json.load(open('$HERE/hyperparameters.json'))['revision'])")
MODEL_DIR="$ELX_ROOT/models/qwen35-9b"
DATA_DIR="$ELX_ROOT/data"
RUNS_DIR="$ELX_ROOT/runs"
# ROCm 10 build of the release whose parser and LoRA docs were checked.
VLLM_IMAGE="vllm/vllm-openai-rocm:v0.34.0-rocm100"
CONTAINER=elx-vllm

run() {
  if [ "${ELX_DRY:-}" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

in_image() {
  run docker run --rm --device /dev/kfd --device /dev/dri --security-opt seccomp=unconfined \
    --group-add video -v "$ELX_ROOT:$ELX_ROOT" -v "$HERE:/elx-train:ro" -w /elx-train \
    -e PYTHONDONTWRITEBYTECODE=1 -e HF_HUB_OFFLINE=1 --entrypoint bash "$VLLM_IMAGE" -c "$1"
}

case "${1:-}" in
check)
  run rocm-smi --showproductname
  run df -h "$HOME"
  run docker --version
  ;;
fetch)
  run mkdir -p "$MODEL_DIR" "$DATA_DIR" "$RUNS_DIR"
  run docker pull "$VLLM_IMAGE"
  run docker run --rm -v "$ELX_ROOT:$ELX_ROOT" --entrypoint huggingface-cli "$VLLM_IMAGE" \
    download "$MODEL_REPO" --revision "$REVISION" --local-dir "$MODEL_DIR"
  ;;
template)
  # The agent's requests carry no template kwargs, so the server template disables thinking.
  # Training renders with enable_thinking=false; every arm must see the same prompt.
  if [ "${ELX_DRY:-}" = 1 ]; then
    echo "+ write $ELX_ROOT/student.jinja"
  else
    { printf '{%%- set enable_thinking = false %%}'; cat "$MODEL_DIR/chat_template.jinja"; } \
      >"$ELX_ROOT/student.jinja"
  fi
  ;;
dummy)
  in_image "pip install -q -r requirements.txt && python dummy_adapter.py --model '$MODEL_DIR' --out '$RUNS_DIR/dummy'"
  ;;
serve)
  shift
  lora=()
  if [ "$#" -gt 0 ]; then lora=(--enable-lora --max-lora-rank 32 --lora-modules "$@"); fi
  run docker run -d --name "$CONTAINER" --device /dev/kfd --device /dev/dri \
    --security-opt seccomp=unconfined --group-add video --network host \
    -v "$ELX_ROOT:$ELX_ROOT" -e HF_HUB_OFFLINE=1 "$VLLM_IMAGE" \
    --host 127.0.0.1 --port 8000 --model "$MODEL_DIR" --served-model-name student \
    --chat-template "$ELX_ROOT/student.jinja" --enable-auto-tool-choice \
    --tool-call-parser qwen3_coder --max-model-len 65536 --generation-config vllm \
    ${lora[@]+"${lora[@]}"}
  ;;
stop)
  run docker rm -f "$CONTAINER"
  ;;
train)
  size="${2:?usage: gpu.sh train <100|300|800>}"
  case "$size" in 100 | 300 | 800) ;; *) echo "Unknown subset: $size" >&2; exit 2 ;; esac
  out="$RUNS_DIR/lora-$size"
  resume=""
  if compgen -G "$out/epoch-*" >/dev/null; then resume="--resume"; fi
  in_image "pip install -q -r requirements.txt && python train.py --model '$MODEL_DIR' \
--data '$DATA_DIR/lora-$size.jsonl' --dev '$DATA_DIR/reserve.jsonl' \
--manifest '$DATA_DIR/manifest.json' --out '$out' $resume"
  ;;
*)
  sed -n '2,4p' "$0"
  exit 2
  ;;
esac
