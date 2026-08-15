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

On macOS arm64, the `@puppeteer/browsers` installer may exit successfully while leaving the
downloaded app bundle incompletely extracted. If the binary is absent, re-extract the downloaded
`148.0.7778.97-chrome-mac-arm64.zip` with `ditto -x -k` into the cache's
`chrome/mac_arm-148.0.7778.97` directory. The resulting executable must report
`Google Chrome for Testing 148.0.7778.97`. This issue was observed only in the local macOS
provisioning check; the pinned image-build contract remains the command above.

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

Recording defaults are 120 seconds, JPEG quality 60, maximum width 1280, and every second CDP
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
directory. To exercise the same flow visibly on macOS, run `deno task dev` with no browser env
vars, call the tools above from an MCP client, then open the returned WebM.

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
