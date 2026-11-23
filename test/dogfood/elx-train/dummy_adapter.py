"""Writes an identity LoRA adapter (zero-initialised B matrices) for the GPU serving smoke.

Served at temperature 0, it must answer exactly like the base model, which shows the adapter path
works on ROCm before any training time is spent.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForImageTextToText


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    lora = json.loads((Path(__file__).parent / "hyperparameters.json").read_text())["lora"]
    base = AutoModelForImageTextToText.from_pretrained(
        args.model, dtype=torch.bfloat16, trust_remote_code=False
    )
    model = get_peft_model(
        base,
        LoraConfig(
            r=lora["r"],
            lora_alpha=lora["alpha"],
            target_modules=lora["target_modules"],
            bias="none",
            init_lora_weights=True,
        ),
    )
    model.save_pretrained(args.out)


if __name__ == "__main__":
    main()
