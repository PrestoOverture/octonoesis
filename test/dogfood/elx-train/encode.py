"""ELX training encoder: dataset samples -> token ids and assistant-only labels.

Uses the student's own chat template, so a training example renders as the model sees it at
inference with `enable_thinking=false`. Teacher trajectories carry no reasoning, so serving must
use the same setting for every arm.

Check a dataset without torch or weights (prints counts only, never content):

    python encode.py --tokenizer <dir> --check <dataset.jsonl>
"""

from __future__ import annotations

import argparse
import copy
import json
import re
from collections import Counter
from typing import Any

IGNORE_INDEX = -100
ASSISTANT_HEADER = "<|im_start|>assistant\n"
EMPTY_THINK = "<think>\n\n</think>\n\n"
END = "<|im_end|>"
CONTROL_TOKENS = ("<|im_start|>", "<|im_end|>", "<|endoftext|>")
TOOL_CALL = re.compile(r"<tool_call>\n<function=([^>\n]+)>\n(.*?)</function>\n</tool_call>", re.S)
PARAMETER = re.compile(r"<parameter=([^>\n]+)>\n(.*?)\n</parameter>\n", re.S)


def normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Returns template-ready messages: tool-call arguments as objects, null content as ''."""
    out = copy.deepcopy(messages)
    for message in out:
        if message.get("content") is None:
            message["content"] = ""
        calls = message.get("tool_calls")
        if not calls:
            message.pop("tool_calls", None)
            continue
        for call in calls:
            function = call["function"]
            if isinstance(function["arguments"], str):
                function["arguments"] = json.loads(function["arguments"])
    return out


def render(tokenizer: Any, sample: dict[str, Any]) -> str:
    return tokenizer.apply_chat_template(
        normalize_messages(sample["messages"]),
        tools=sample["tools"],
        tokenize=False,
        add_generation_prompt=False,
        enable_thinking=False,
    )


def assistant_spans(text: str) -> list[tuple[int, int]]:
    """Character spans the model generates: after the header and empty think, through <|im_end|>."""
    spans = []
    cursor = 0
    while (start := text.find(ASSISTANT_HEADER, cursor)) != -1:
        begin = start + len(ASSISTANT_HEADER)
        if text.startswith(EMPTY_THINK, begin):
            begin += len(EMPTY_THINK)
        end = text.find(END, begin)
        if end == -1:
            raise ValueError("Unterminated assistant turn")
        spans.append((begin, end + len(END)))
        cursor = end + len(END)
    return spans


def encode(tokenizer: Any, sample: dict[str, Any]) -> dict[str, list[int]]:
    """Tokenizes one sample; labels are ignored outside assistant-generated spans."""
    text = render(tokenizer, sample)
    encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    spans = assistant_spans(text)
    labels = [IGNORE_INDEX] * len(encoded["input_ids"])
    span = 0
    for index, (begin, end) in enumerate(encoded["offset_mapping"]):
        while span < len(spans) and begin >= spans[span][1]:
            span += 1
        if span < len(spans) and begin >= spans[span][0] and end <= spans[span][1]:
            labels[index] = encoded["input_ids"][index]
    return {"input_ids": encoded["input_ids"], "labels": labels}


def coerce(value: str, schema: dict[str, Any]) -> Any:
    kind = schema.get("type")
    if kind == "boolean":
        return value.strip().lower() == "true"
    if kind == "integer":
        return int(value)
    if kind == "number":
        return float(value)
    if kind in ("array", "object"):
        return json.loads(value)
    return value


def parse_calls(text: str, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Parses rendered tool calls back, applying each tool's parameter types."""
    schemas = {t["function"]["name"]: t["function"]["parameters"] for t in tools}
    calls = []
    for name, body in TOOL_CALL.findall(text):
        properties = schemas.get(name, {}).get("properties", {})
        arguments = {
            key: coerce(value, properties.get(key, {})) for key, value in PARAMETER.findall(body)
        }
        calls.append({"name": name, "arguments": arguments})
    return calls


def check_sample(tokenizer: Any, sample: dict[str, Any]) -> tuple[Counter, int, int]:
    """Returns issue/turn counts, token length and trainable-token count for one sample."""
    counts: Counter = Counter()
    for message in sample["messages"]:
        content = message.get("content") or ""
        if any(token in content for token in CONTROL_TOKENS):
            counts["control_token_in_content"] += 1
        for call in message.get("tool_calls") or []:
            if any(token in call["function"]["arguments"] for token in CONTROL_TOKENS):
                counts["control_token_in_arguments"] += 1
    text = render(tokenizer, sample)
    spans = assistant_spans(text)
    assistants = [m for m in normalize_messages(sample["messages"]) if m["role"] == "assistant"]
    counts["assistant_turns"] += len(assistants)
    if len(spans) != len(assistants):
        counts["span_count_mismatch"] += 1
    else:
        for (begin, end), message in zip(spans, assistants):
            expected = [
                {"name": c["function"]["name"], "arguments": c["function"]["arguments"]}
                for c in message.get("tool_calls", [])
            ]
            counts["tool_calls"] += len(expected)
            try:
                parsed = parse_calls(text[begin:end], sample["tools"])
            except (ValueError, json.JSONDecodeError):
                counts["tool_call_parse_error"] += 1
                continue
            if parsed != expected:
                counts["tool_call_roundtrip_mismatch"] += 1
    encoded = encode(tokenizer, sample)
    trainable = sum(label != IGNORE_INDEX for label in encoded["labels"])
    return counts, len(encoded["input_ids"]), trainable


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--check", required=True)
    args = parser.parse_args()
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, trust_remote_code=False)
    totals: Counter = Counter()
    lengths: list[int] = []
    trainable = 0
    with open(args.check, encoding="utf8") as handle:
        for line in handle:
            counts, length, labels = check_sample(tokenizer, json.loads(line))
            totals.update(counts)
            lengths.append(length)
            trainable += labels
    lengths.sort()
    quantile = lambda p: lengths[min(int(len(lengths) * p), len(lengths) - 1)]
    print(
        json.dumps(
            {
                "samples": len(lengths),
                "issues": dict(totals),
                "tokens": {
                    "total": sum(lengths),
                    "trainable": trainable,
                    "p50": quantile(0.5),
                    "p90": quantile(0.9),
                    "p95": quantile(0.95),
                    "max": lengths[-1],
                },
            }
        )
    )


if __name__ == "__main__":
    main()
