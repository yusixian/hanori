# Offline quote renderer

The default Compose `quote-worker` service renders sanitized quotation input with Pango/Cairo and
Noto Sans, Noto Sans CJK and Noto Color Emoji. It has no network, Bot token, database or model
credentials. The application accesses only `/quote-control/worker.sock` through its dedicated volume.
`GET /health` succeeds only after a native CJK/emoji render; `POST /render` accepts the shared
`QuoteRenderInput` JSON contract and returns image bytes with `x-quote-width`/`x-quote-height` headers.
No caller-selected paths or URLs are accepted. A busy worker returns 409 without queuing.
With `QUOTE_WORKER_SOCKET` configured, application `/api/health/ready` includes `quoteRenderer`:
production acceptance requires both the candidate Git SHA and `quoteRenderer: true`. Renderer
unavailability is observable there without making unrelated application readiness fail.

The renderer accepts 1–10 messages, 4,096 UTF-16 units per body and 12,000 total; 100 formatting
entities per message. Author names accept 256 UTF-16 units, author keys 512, and parent
preview text 180. Callers truncate previews at grapheme boundaries within that UTF-16 budget.
Entities use Telegram UTF-16 offsets. Callers must already apply authorization,
privacy, protected-content and spoiler masking. Adjacent equal author key/name messages share one
bubble while keeping their individual text, parent previews and images in order. Text has up to
432 logical pixels of width with a compact 36-pixel avatar; parent previews use smaller text and
a vertical accent to separate them from the quoted body. Short bubbles still shrink to content.

Static PNG/JPEG/WebP inputs are bounded to 8 MiB and 16 million pixels each, 24 MiB combined;
avatars are limited to 1 MiB and 4 million pixels. Animated inputs are rejected. Output is transparent
WebP with longest side 512 and at most 512 KiB. If scaling would make body text smaller than 14 px
or names smaller than 10 px, or WebP exceeds that budget, output is a readable PNG (at most
512 × 4,096 and 8 MiB). Oversized text is rejected, not silently omitted.

Compose enforces UID 1000, no network, read-only root, dropped capabilities, no new privileges,
512 MiB memory, one CPU, 32 processes and a 128 MiB temporary filesystem. One job runs at a time
with a 15-second deadline. Timeout, client cancellation and shutdown kill and reap the child process
group; temporary inputs and outputs are removed. Startup probes are also cancelled during shutdown.

Build and native verification: `docker build --target quote-worker .`. The image build executes
`test_renderer.py` against the production Alpine libraries and fonts. Broker/client regressions run
through Vitest. Native tests use fictional messages and generated image fixtures only.

The implementation is original. The GPLv3 [quoda project](https://github.com/NahidaBuer/quoda)
was studied for behavior; its source and fixtures were not copied into this MIT project. Python
bindings, Cairo/Pango, Pillow and Noto fonts remain under their respective upstream licenses.
