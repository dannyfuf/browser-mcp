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
BROWSER_HEADLESS=1 deno task test
```

## Environment variables

| Var                    | Default | Effect                                                                |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `BROWSER_HEADLESS`     | unset   | Set to `1` to run headless. Default is headed (you can watch the agent). |
| `BROWSER_USER_DATA_DIR`| unset   | Path to a Chrome user data dir. Persists profile (cookies, localStorage) across runs. |

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
- `browser_screenshot({ selector?, fullPage? })` — returns PNG image content
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

## BYO Chrome (optional)

If you don't want the included Chromium download, switch `puppeteer` for `puppeteer-core` and pass `executablePath` in `src/browser.ts`. Tracked as a follow-up in `plans/browser-mcp-server-2026-05-08-tracker.md`.
