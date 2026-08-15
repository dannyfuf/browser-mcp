# browser-mcp

A Model Context Protocol (MCP) server that lets an LLM agent (Claude Code, etc.) drive a real Chromium browser via Puppeteer. Useful for letting the agent develop and debug web pages: navigate, click, type, screenshot, read accessibility/HTML, watch console + network logs, run arbitrary JS, manage tabs.

## Requirements

- [Deno](https://deno.com/) ≥ 2
- macOS or Linux (Windows untested)

## Install

```sh
deno install
```

Puppeteer downloads a Chromium build (~170 MB) on install. If you'd rather use a system Chrome, see "BYO Chrome" below.

## Run

```sh
deno task dev
```

The server speaks MCP over stdio. It does **not** listen on a port — it expects an MCP client to spawn it as a child process.

To verify the wiring without an MCP client:

```sh
deno task check
deno task lint
BROWSER_HEADLESS=1 deno task test
```

## Build artifact

```sh
deno task build
```

This emits the committed, unminified ESM bundle at `dist/browser-mcp.js`. Franky runs that exact
file with `deno run -A dist/browser-mcp.js`; it does not compile `src/` in the sandbox. Every
change under `src/` must be followed by rebuilding and recommitting the bundle, then moving
Franky's pinned repository ref to the new commit.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `BROWSER_HEADLESS` | unset | Set to exactly `1` for headless Chrome. The default is headed. |
| `BROWSER_USER_DATA_DIR` | unset | Chrome user-data directory; preserves cookies and local storage across runs. |
| `BROWSER_NO_SANDBOX` | unset | Set to exactly `1` to append `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, and `--disable-gpu`. Intended for sandbox/container images. |
| `BROWSER_ARTIFACT_DIR` | OS temp + `browser-mcp-artifacts` | Parent directory for file screenshots and recording directories. Created lazily. |
| `BROWSER_FFMPEG_PATH` | `ffmpeg` resolved from `PATH` | Explicit ffmpeg executable used to assemble recordings. Missing or invalid ffmpeg keeps recoverable JPEG frames instead of failing. |
| `PUPPETEER_CACHE_DIR` | Puppeteer platform default | Chrome-for-Testing cache root. Honored when the server is launched with a stripped environment. |
| `PUPPETEER_EXECUTABLE_PATH` | unset | Direct Chrome executable override. Honored when the server is launched with a stripped environment. |

## Chrome provisioning contract

The resolved Puppeteer release expects **Chrome for Testing 148.0.7778.97**. Provision that
exact version in the runtime image rather than downloading a moving `latest` build:

```sh
PUPPETEER_CACHE_DIR=/tmp/pptr-cache \
  deno run -A npm:@puppeteer/browsers install chrome@148.0.7778.97 --path /tmp/pptr-cache
```

Keep `PUPPETEER_CACHE_DIR=/tmp/pptr-cache` in the server environment, or set
`PUPPETEER_EXECUTABLE_PATH` directly to the installed Chrome binary. Both resolution paths were
verified by spawning the server with only `PATH`, `HOME`, `BROWSER_HEADLESS=1`, and the selected
Puppeteer variable; no browser-specific passthrough is required in application code.

Under Deno, the `@puppeteer/browsers` installer may exit successfully while leaving the downloaded
archive incompletely extracted. On macOS arm64, if the binary is absent, re-extract the downloaded
`148.0.7778.97-chrome-mac-arm64.zip` with `ditto -x -k` into the cache's
`chrome/mac_arm-148.0.7778.97` directory. The resulting executable must report
`Google Chrome for Testing 148.0.7778.97`. The Linux Dockerfile below completes extraction with
`unzip` and verifies the executable before deleting the archive.

## Deno bundle smoke

The reusable harness accepts any stdio MCP server command. It initializes the server, opens a tab,
navigates to a local fixture, verifies a non-empty base64 PNG screenshot, and closes the tab:

```sh
BROWSER_HEADLESS=1 deno run -A smoke/harness.ts deno run -A dist/browser-mcp.js
```

The Linux proof uses Debian 13 from Deno's pinned image and the same harness:

```sh
docker build --platform=linux/amd64 -f Dockerfile.smoke -t browser-mcp-smoke .
docker run --rm --platform=linux/amd64 browser-mcp-smoke
```

The exact direct apt package list discovered from successive Chrome launch errors is:

```text
libasound2t64
libatk-bridge2.0-0t64
libatk1.0-0t64
libcairo2
libcups2t64
libexpat1
libgbm1
libglib2.0-0t64
libnspr4
libnss3
libpango-1.0-0
libxcomposite1
libxdamage1
libxfixes3
libxkbcommon0
libxrandr2
```

`unzip` is also installed as a provisioning utility. The committed `Dockerfile.smoke` is the
canonical tested recipe:

```dockerfile
FROM denoland/deno:2.9.0

USER root
ENV PUPPETEER_CACHE_DIR=/tmp/pptr-cache

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN deno run -A npm:@puppeteer/browsers@2.13.2 install \
  chrome@148.0.7778.97 --path /tmp/pptr-cache \
  && unzip -q -o \
    /tmp/pptr-cache/chrome/148.0.7778.97-chrome-linux64.zip \
    -d /tmp/pptr-cache/chrome/linux-148.0.7778.97 \
  && test -x /tmp/pptr-cache/chrome/linux-148.0.7778.97/chrome-linux64/chrome \
  && rm /tmp/pptr-cache/chrome/148.0.7778.97-chrome-linux64.zip

WORKDIR /app
COPY dist/browser-mcp.js dist/browser-mcp.js
COPY smoke/harness.ts smoke/harness.ts

ENV BROWSER_HEADLESS=1
ENV BROWSER_NO_SANDBOX=1

CMD ["deno", "run", "-A", "smoke/harness.ts", "deno", "run", "-A", "dist/browser-mcp.js"]
```

## Tool reference

All tools take JSON args. Errors return as `isError: true` content blocks.

**Navigation**
- `browser_navigate({ url, waitUntil?, timeoutMs? })` — go to a URL
- `browser_back()` / `browser_forward()` / `browser_reload({ waitUntil? })`

**Interaction**
- `browser_click({ selector?, x?, y?, button?, clickCount?, timeoutMs? })` — provide either `selector` or viewport coordinates `x` and `y`
- `browser_type({ selector, text, delayMs?, clearFirst?, timeoutMs? })`
- `browser_press_key({ key, modifiers? })` — e.g. `Enter`, `Tab`, `ArrowDown`, `a` + `["Meta"]`
- `browser_hover({ selector })`
- `browser_select_option({ selector, values })` — for `<select>`
- `browser_scroll({ selector?, x?, y?, behavior? })`

**Inspection (the agent's eyes)**
- `browser_screenshot({ selector?, fullPage?, output? })` — `output` is `inline` (default), `file`, or `both`; file output returns a PNG path under `BROWSER_ARTIFACT_DIR`
- `browser_snapshot()` — accessibility tree with stable `ref` ids on interactive nodes; far cheaper to reason over than HTML
- `browser_get_html({ selector?, maxLength? })` — outerHTML, truncated
- `browser_get_text({ selector?, maxLength? })` — innerText, truncated
- `browser_evaluate({ expression })` — run JS in the page; returns the value

**Diagnostics**
- `browser_console_logs({ level?, sinceMs?, clear? })`
- `browser_network_logs({ statusFilter?, urlIncludes?, sinceMs?, clear? })`

**State / waits / viewport**
- `browser_wait_for_selector({ selector, state?, timeoutMs? })` — `attached` | `detached` | `visible` | `hidden`
- `browser_set_viewport({ width, height, deviceScaleFactor?, isMobile? })`
- `browser_close()` — closes current tab; shuts down the browser if it was the last tab

**Tabs**
- `browser_list_tabs()`
- `browser_new_tab({ url? })`
- `browser_switch_tab({ id })`
- `browser_close_tab({ id? })`

**Recording**
- `browser_start_recording({ tab?, max_duration_s?, quality?, max_width? })` — starts a raw CDP screencast and returns its session id and frame directory
- `browser_stop_recording()` — stops the current tab's recording and returns a WebM path, or a recoverable frames directory when assembly is skipped

Recording defaults are 120 seconds, JPEG quality 50, maximum width 1280, and every sixth CDP
frame; `max_duration_s` is capped at 300. Frames are written immediately as `frame-<n>.jpg`
alongside monotonic timestamps in `frames.ndjson`, so frame bytes are never accumulated in memory.
When ffmpeg succeeds, the JPEGs are deleted and the WebM byte size is returned. When ffmpeg is
missing or assembly fails, the frames remain and the tool returns a note instead of an error.
Normal tab and browser closes finalize active recordings. SIGINT/SIGTERM drains frame writes,
skips ffmpeg, and leaves `recording.json` marked `unassembled` next to the recoverable frames.

A typical tool sequence is:

```text
browser_start_recording({ "max_duration_s": 60 })
browser_navigate({ "url": "http://127.0.0.1:3000" })
browser_click({ "selector": "#sign-in" })
browser_type({ "selector": "#email", "text": "demo@example.com" })
browser_stop_recording()
```

Use the returned WebM path when assembly succeeds; otherwise retain or upload the returned frames
directory.

### Recording resource budget

Measured on 2026-08-15 on macOS 26.3 arm64 (Apple M5 Pro, 24 GiB) using Chrome for Testing
148.0.7778.97 and ffmpeg from `/opt/homebrew/bin/ffmpeg`. A local fixture continuously redrew a
full-window canvas and mutated/animated 240 DOM nodes for 120 seconds. RSS was sampled every
500 ms across the real stdio MCP start/navigate/interact/stop tool sequence.

| Measure | Initial defaults (quality 60, every 2nd frame) | Tuned defaults (quality 50, every 6th frame) |
| --- | ---: | ---: |
| Recorded/ffprobe duration | 120.20 s | 120.08 s |
| Peak server RSS | 175.6 MiB | 134.7 MiB |
| Peak process-tree RSS (server + Chrome + ffmpeg) | 1,063.5 MiB | 1,101.6 MiB |
| Peak raw frames directory | 374.0 MiB (186.9 MiB/min) | 111.2 MiB (55.6 MiB/min) |
| Assembled WebM | 179.6 MiB (89.7 MiB/min) | 77.8 MiB (38.9 MiB/min) |

The initial raw-frame rate exceeded the approximately 100 MB/min tuning threshold, so the
quality/frame-frequency defaults were reduced and remeasured. The tuned end-to-end peak is about
1.08 GiB, below the 4 GiB sandbox limit; the 120-second default and 300-second hard cap are also
well below the 30-minute run limit. These are deliberately busy-fixture measurements, not
guarantees for every page.

### Manual headed recording check (macOS)

1. Ensure no `BROWSER_*` or `PUPPETEER_*` overrides are set, then run `deno task dev`. Chrome for
   Testing should open headed.
2. Connect an MCP client to that process, call `browser_new_tab()`, and browse to the page under
   test with `browser_navigate`.
3. Call `browser_start_recording({ "max_duration_s": 60 })`, then click/type/scroll through the
   flow being verified.
4. Call `browser_stop_recording()` and confirm it returns a `WebM path` rather than an MCP error.
5. Validate the file with `ffprobe -v error -show_entries format=duration,size <webm-path>`, then
   open the WebM in a compatible player and visually confirm the interaction is present.
6. Stop `deno task dev` and confirm the headed Chrome process exits.

Tip: prefer `browser_snapshot` over `browser_get_html` when locating elements. CSS selectors are brittle; the accessibility tree is semantic and much smaller.

## Wire into Claude Code

```sh
claude mcp add --scope user browser-mcp -- deno run -A /Users/danny/buk/browser/src/index.ts
```

Or edit `~/.claude.json` directly:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "deno",
      "args": ["run", "-A", "/Users/danny/buk/browser/src/index.ts"],
      "env": {
        "BROWSER_HEADLESS": "0"
      }
    }
  }
}
```

After restarting Claude Code, ask it to call `ping` or `browser_navigate` — it should respond.

## Troubleshooting

**Chromium fails to launch on macOS.** Re-run `deno run -A npm:puppeteer browsers install chrome`. If you're on Apple Silicon and getting an x64 binary, set `PUPPETEER_BROWSER_PLATFORM=mac_arm` and reinstall.

**Agent sees garbled output / MCP framing errors.** Something is writing to **stdout** instead of stderr. The project enforces this via Biome's `noConsole` rule (only `console.error/warn/info` are allowed). If you add a dependency that prints to stdout on import, you'll need to silence it.

**Browser process leaks after a crash.** `pkill -f 'Chrome for Testing'` is safe to run.

**Dev loop.** Restart `deno task dev` after changing `src/`.
