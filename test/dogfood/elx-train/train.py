"""ELX P3: train one LoRA adapter on a fixed dataset subset.

Hyperparameters come only from hyperparameters.json and are fixed before training. Each epoch
writes a resumable checkpoint, so a lost instance costs at most one epoch.

    python train.py --model <dir|repo> --data lora-100.jsonl --dev reserve.jsonl \
        --manifest manifest.json --out runs/lora-100 [--resume]

`--tiny` swaps in a small random model on CPU to exercise the whole loop without weights.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import time
from pathlib import Path
from typing import Any

import torch
from peft import LoraConfig, PeftModel, get_peft_model
from transformers import AutoConfig, AutoModelForImageTextToText, AutoTokenizer

from encode import IGNORE_INDEX, encode

HERE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def verify_manifest(data: Path, manifest: Path) -> str:
    """Refuses a data file whose hash differs from the subset manifest."""
    entry = json.loads(manifest.read_text())["files"].get(data.name)
    if entry is None:
        raise SystemExit(f"{data.name} is not in the manifest")
    actual = sha256(data)
    if actual != entry["sha256"]:
        raise SystemExit(f"{data.name} does not match the manifest hash")
    return actual


def load_examples(path: Path, tokenizer: Any, limit: int, keep_last: int) -> list[dict[str, Any]]:
    examples = []
    with path.open(encoding="utf8") as handle:
        for index, line in enumerate(handle):
            if limit and index >= limit:
                break
            encoded = encode(tokenizer, json.loads(line))
            if keep_last:
                encoded = {key: value[-keep_last:] for key, value in encoded.items()}
            examples.append(encoded)
    return examples


def tiny_model(model_dir: str) -> Any:
    config = AutoConfig.from_pretrained(model_dir, trust_remote_code=False)
    text = config.text_config
    text.hidden_size, text.intermediate_size = 32, 64
    text.num_hidden_layers, text.layer_types = 2, ["full_attention", "linear_attention"]
    text.num_attention_heads, text.num_key_value_heads = 2, 1
    for name, value in (("linear_num_attention_heads", 2), ("linear_num_key_value_heads", 1)):
        if hasattr(text, name):
            setattr(text, name, value)
    config.vision_config.depth, config.vision_config.hidden_size = 1, 32
    config.vision_config.out_hidden_size = 32
    return AutoModelForImageTextToText.from_config(config, trust_remote_code=False)


def batch_loss(model: Any, example: dict[str, list[int]], device: torch.device) -> torch.Tensor:
    input_ids = torch.tensor([example["input_ids"]], device=device)
    labels = torch.tensor([example["labels"]], device=device)
    return model(input_ids=input_ids, labels=labels, use_cache=False).loss


@torch.no_grad()
def evaluate(model: Any, examples: list[dict[str, list[int]]], device: torch.device) -> float:
    model.eval()
    total, tokens = 0.0, 0
    for example in examples:
        count = sum(label != IGNORE_INDEX for label in example["labels"][1:])
        if count:
            total += batch_loss(model, example, device).item() * count
            tokens += count
    model.train()
    return total / max(tokens, 1)


def lr_factor(step: int, total: int, warmup: int) -> float:
    if step < warmup:
        return (step + 1) / max(warmup, 1)
    progress = (step - warmup) / max(total - warmup, 1)
    return max(0.0, 1.0 - progress)


def loss_decreased(losses: list[float]) -> bool:
    """Training-loss gate: mean of the last 10% of steps is below the first 10%."""
    window = max(len(losses) // 10, 1)
    return sum(losses[-window:]) / window < sum(losses[:window]) / window


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--dev", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--hyperparameters", type=Path, default=HERE / "hyperparameters.json")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--tiny", action="store_true", help="Random small model, CPU dry run")
    parser.add_argument("--limit", type=int, default=0, help="Dry run only: first N samples")
    parser.add_argument("--keep-last", type=int, default=0, help="Dry run only: last N tokens")
    args = parser.parse_args()
    if (args.limit or args.keep_last) and not args.tiny:
        raise SystemExit("--limit and --keep-last are for --tiny dry runs only")

    hp = json.loads(args.hyperparameters.read_text())
    if args.manifest:
        data_sha = verify_manifest(args.data, args.manifest)
        if args.dev:
            verify_manifest(args.dev, args.manifest)
    elif not args.tiny:
        raise SystemExit("--manifest is required for real training")
    else:
        data_sha = sha256(args.data)

    random.seed(hp["seed"])
    torch.manual_seed(hp["seed"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cpu" and not args.tiny:
        raise SystemExit("No GPU found; refusing to train on CPU")

    revision = None if Path(args.model).exists() else hp["revision"]
    tokenizer = AutoTokenizer.from_pretrained(args.model, revision=revision, trust_remote_code=False)
    train = load_examples(args.data, tokenizer, args.limit, args.keep_last)
    dev = load_examples(args.dev, tokenizer, args.limit, args.keep_last) if args.dev else []
    longest = max(len(example["input_ids"]) for example in [*train, *dev])
    if longest > hp["max_seq_length"]:
        raise SystemExit(f"Sample of {longest} tokens exceeds max_seq_length; refusing to truncate")

    if args.tiny:
        base = tiny_model(args.model)
    else:
        base = AutoModelForImageTextToText.from_pretrained(
            args.model, revision=revision, dtype=torch.bfloat16, trust_remote_code=False
        )
    base.config.use_cache = False
    base.gradient_checkpointing_enable()
    base.enable_input_require_grads()

    args.out.mkdir(parents=True, exist_ok=True)
    checkpoints = sorted(args.out.glob("epoch-*"), key=lambda p: int(p.name.split("-")[1]))
    start_epoch, state = 0, None
    if args.resume and checkpoints:
        model = PeftModel.from_pretrained(base, checkpoints[-1], is_trainable=True)
        state = torch.load(checkpoints[-1] / "trainer.pt", map_location="cpu", weights_only=False)
        start_epoch = state["epoch"] + 1
    elif checkpoints:
        raise SystemExit(f"{args.out} already has checkpoints; pass --resume")
    else:
        lora = hp["lora"]
        model = get_peft_model(
            base,
            LoraConfig(
                r=lora["r"],
                lora_alpha=lora["alpha"],
                lora_dropout=lora["dropout"],
                target_modules=lora["target_modules"],
                bias="none",
            ),
        )
    model.to(device)
    model.train()

    parameters = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(
        parameters, lr=hp["learning_rate"], weight_decay=hp["weight_decay"]
    )
    accumulation = hp["accumulation_steps"]
    total_steps = hp["epochs"] * math.ceil(len(train) / accumulation)
    warmup = math.ceil(total_steps * hp["warmup_fraction"])
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda step: lr_factor(step, total_steps, warmup)
    )
    losses: list[float] = []
    if state:
        optimizer.load_state_dict(state["optimizer"])
        scheduler.load_state_dict(state["scheduler"])
        losses = state["losses"]

    log = (args.out / "train_log.jsonl").open("a", encoding="utf8")
    started = time.time()
    dev_losses = state["dev_losses"] if state else ([evaluate(model, dev, device)] if dev else [])
    for epoch in range(start_epoch, hp["epochs"]):
        order = list(range(len(train)))
        random.Random(hp["seed"] + epoch).shuffle(order)
        optimizer.zero_grad(set_to_none=True)
        running = 0.0
        for position, index in enumerate(order, 1):
            loss = batch_loss(model, train[index], device)
            if not torch.isfinite(loss):
                raise SystemExit(f"Non-finite loss at epoch {epoch}, position {position}")
            (loss / accumulation).backward()
            running += loss.item()
            pending = ((position - 1) % accumulation) + 1
            if pending == accumulation or position == len(order):
                torch.nn.utils.clip_grad_norm_(parameters, hp["max_grad_norm"])
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
                losses.append(running / pending)
                log.write(json.dumps({"epoch": epoch, "step": len(losses), "loss": losses[-1]}) + "\n")
                log.flush()
                running = 0.0
        if dev:
            dev_losses.append(evaluate(model, dev, device))
        checkpoint = args.out / f"epoch-{epoch}"
        model.save_pretrained(checkpoint)
        torch.save(
            {
                "epoch": epoch,
                "optimizer": optimizer.state_dict(),
                "scheduler": scheduler.state_dict(),
                "losses": losses,
                "dev_losses": dev_losses,
            },
            checkpoint / "trainer.pt",
        )

    model.save_pretrained(args.out / "adapter")
    summary = {
        "data": args.data.name,
        "data_sha256": data_sha,
        "hyperparameters": hp,
        "tiny_dry_run": args.tiny,
        "samples": len(train),
        "tokens": sum(len(example["input_ids"]) for example in train),
        "steps": len(losses),
        "first_loss": losses[0],
        "last_loss": losses[-1],
        "train_loss_decreased": loss_decreased(losses),
        "dev_losses": dev_losses,
        "seconds": round(time.time() - started, 1),
    }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({key: value for key, value in summary.items() if key != "hyperparameters"}))


if __name__ == "__main__":
    main()
