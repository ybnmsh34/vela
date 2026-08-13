# Choosing a local model for this machine

Short answer: start with a 7–8B model at `Q4_K_M`, measure, and only move up if
the quality gap is one you can actually name. Everything below is the reasoning,
and the numbers are worked for a 16 GB card.

The paragraph above is deliberately hard-wrapped at seventy-odd columns, the way
almost every model writes prose, and it must read as **one paragraph** — not as
four short lines with ragged endings.

## What decides the answer

Three quantities, in the order they bind:

1. **VRAM.** Weights, KV cache and the runtime's own overhead all come out of
   the same budget.
2. **Context length.** The KV cache grows linearly with it, and at 32k it can
   outweigh the model.
3. **What you are actually asking for.** Summarising a diff and writing one are
   not the same job.

### The arithmetic

A rule of thumb that has held up:

- weights ≈ *parameters* × *bits per weight* ÷ 8
- KV cache ≈ 2 × *layers* × *context* × *heads* × *head dim* × *bytes*
- leave ~1 GB for the runtime, more if you are also driving a display
  - on Windows, the desktop compositor is not free
  - on Linux with no X session running, it very nearly is

So an 8B model at four bits is about **4.5 GB** of weights, and the cache is what
decides whether 32k context fits beside it.

> Quantisation is lossy, and it is lossy *unevenly*. A model that still writes
> fluent prose at `Q3` may have quietly lost the ability to emit valid JSON.
>
> Test the capability you need, not the capability that is easy to eyeball.

## Reading the quantisation labels

| Label | Bits/weight | 8B weights | Where it breaks first |
| :--- | ---: | ---: | :--- |
| `Q8_0` | 8.5 | 8.5 GB | nothing — it is the reference |
| `Q6_K` | 6.6 | 6.6 GB | nothing you will notice |
| `Q5_K_M` | 5.7 | 5.7 GB | long-chain arithmetic |
| `Q4_K_M` | 4.9 | 4.9 GB | structured output, tool arguments |
| `Q3_K_M` | 3.9 | 3.9 GB | instruction following, JSON validity |

## Wiring it into Vela

Point Vela at the runtime's OpenAI-compatible endpoint. No key is needed and
none is asked for — `llama-server` does not authenticate by default, and *"no
API key"* is a first-class state here, not a warning.

```bash
llama-server \
  --model ./qwen3-8b-q4_k_m.gguf \
  --ctx-size 32768 \
  --host 127.0.0.1 --port 8033 \
  --jinja
```

Then add `http://127.0.0.1:8033/v1` as an endpoint and press **Check** to probe
what it can do. The capability row that matters most is `tools`: without
`--jinja` the server will answer a tool request with ~~an error~~ plain prose,
which Vela will show you as a degradation rather than silently swallowing.

### If the probe disagrees with the model card

Believe the probe. A card describes a *model*; the probe describes the
**server** in front of it, and that is the thing you are actually talking to.
See the [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp)
for the flags that change the answer.

---

#### One last thing

Run the thing you intend to run, on the machine you intend to run it on, before
you decide what it is worth. Every number above is a starting point for a
measurement, and none of them is a substitute for one.
