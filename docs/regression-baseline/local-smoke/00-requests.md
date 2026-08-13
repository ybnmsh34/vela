# GATE M Part 2 — raw request bodies

Every request below was sent to `http://localhost:8033/v1` with **no `Authorization` header**
and no TLS. Responses are the sibling files. Run serially, never more than 1 in flight.

Server (unmodified, not restarted): llama.cpp `b8833-45cac7ca7`,
model `unsloth/Qwen3.6-27B-GGUF:Q5_K_M`, `n_ctx` 131072, `total_slots` 4, vision via mmproj.

---

## 01 — health
```
GET http://localhost:8033/health
```

## 02 — props
```
GET http://localhost:8033/props
```

## 03 — models
```
GET http://localhost:8033/v1/models
```

## 04 — plain, non-streaming
```
POST /v1/chat/completions
Content-Type: application/json

{"model":"unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
 "messages":[{"role":"user","content":"What is 17 * 23? Answer briefly."}],
 "max_tokens":400,"stream":false}
```

## 05 — tool calling
```
POST /v1/chat/completions
Content-Type: application/json

{"model":"unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
 "messages":[{"role":"user","content":"What is the weather in Tel Aviv right now? Use the tool."}],
 "tools":[{"type":"function","function":{
    "name":"get_weather",
    "description":"Get current weather for a city",
    "parameters":{"type":"object",
      "properties":{"city":{"type":"string","description":"City name"}},
      "required":["city"]}}}],
 "tool_choice":"auto","max_tokens":500,"stream":false}
```

## 06 — streaming, 300-token cap
```
POST /v1/chat/completions
Content-Type: application/json

{"model":"unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
 "messages":[{"role":"user","content":"Name three primary colors. Brief."}],
 "max_tokens":300,"stream":true}
```

## 07 — streaming, 2000-token cap (same prompt, budget large enough for an answer)
```
POST /v1/chat/completions
Content-Type: application/json

{"model":"unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
 "messages":[{"role":"user","content":"Name three primary colors. Brief."}],
 "max_tokens":2000,"stream":true}
```

## 08 — vision
Input image `08-vision.input.png` is a generated 64x64 PNG,
**left half pure red `#FF0000`, right half pure blue `#0000FF`** — known ground truth.

```
POST /v1/chat/completions
Content-Type: application/json

{"model":"unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
 "messages":[{"role":"user","content":[
   {"type":"text","text":"This image has two vertical halves. What color is the LEFT half and what color is the RIGHT half? Answer in one short sentence."},
   {"type":"image_url","image_url":{"url":"data:image/png;base64,<184 bytes of base64, see 08-vision.input.png>"}}]}],
 "max_tokens":1200,"stream":false}
```

## 09 — context overflow
900,000 characters of filler (`"The quick brown fox jumps over the lazy dog. "` x 20000),
tokenizing to 200,018 tokens against an `n_ctx` of 131,072.

```
POST /v1/chat/completions
Content-Type: application/json

{"model":"unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
 "messages":[{"role":"user","content":"<900000 chars of filler>\n\nSummarize in one word."}],
 "max_tokens":50,"stream":false}
```
