#!/usr/bin/env python3
"""
Tolerant SSE reassembler, used by record.sh to turn a raw streamed body into
the things a consumer actually cares about.

It is deliberately *tolerant*: a frame that is not valid JSON is counted and
skipped rather than fatal. That is a decision, not an accident — the hostile
profile emits frames that cannot be parsed, and a reassembler that dies on the
first one cannot show what the rest of the stream contained. The cost of the
other choice is measured separately by the `strict-json-frames` probe.

Depends on the Python standard library only, and on nothing in the harness.

  reassemble-sse.py <mode> <file>     modes: text | frags | stats
"""

import json
import sys


def frames(raw: str):
    """Yields the payload of every `data:` line, in order."""
    for block in raw.split("\n\n"):
        data = []
        for line in block.split("\n"):
            if line.startswith("data:"):
                piece = line[len("data:") :]
                data.append(piece[1:] if piece.startswith(" ") else piece)
        if data:
            yield "\n".join(data)


def main() -> int:
    mode, path = sys.argv[1], sys.argv[2]
    raw = open(path, encoding="utf-8").read()

    text = []
    frags = []
    total = unparseable = 0
    saw_done = False
    finish_reasons = []
    usage_frames = 0

    for payload in frames(raw):
        total += 1
        if payload == "[DONE]":
            saw_done = True
            continue
        try:
            value = json.loads(payload)
        except Exception:
            unparseable += 1
            continue
        if not isinstance(value, dict):
            continue
        if value.get("usage") is not None:
            usage_frames += 1
        choices = value.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        first = choices[0]
        if not isinstance(first, dict):
            continue
        if first.get("finish_reason") is not None:
            finish_reasons.append(first["finish_reason"])
        delta = first.get("delta")
        if isinstance(delta, dict) and isinstance(delta.get("content"), str):
            text.append(delta["content"])
            frags.append(delta["content"])

    if mode == "text":
        sys.stdout.write("".join(text))
    elif mode == "frags":
        for fragment in frags:
            sys.stdout.write("  |%s|\n" % fragment)
    elif mode == "stats":
        print("data: frames           %d" % total)
        print("unparseable frames     %d" % unparseable)
        print("[DONE] sentinel        %s" % ("yes" if saw_done else "NO — the stream just stops"))
        print("usage frames           %d" % usage_frames)
        print("finish_reason values   %s" % (finish_reasons or "(none)"))
        print("content fragments      %d" % len(frags))
        print("reassembled chars      %d" % len("".join(text)))
    else:
        print("unknown mode: %s" % mode, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
