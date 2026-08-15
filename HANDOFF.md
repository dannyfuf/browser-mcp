# Handoff: make this browser MCP server sandbox-ready for Franky

Self-contained brief for working in this repo with a clean session. It replaces the deleted
`plans/franky-browser-2026-08-15-phase-{1,2}-*.md` files. The overall initiative and the
downstream integration phases live in the Franky repo:
`/Users/danny/buk/franky/plans/franky-browser-2026-08-15-roadmap.md` (phases 3–4). Nothing in
this document requires reading that repo — the contract Franky consumes is fully specified here.

## Why

Franky is a Slack-driven agent bot. Each task runs OpenCode inside a remote **Deno Sandbox
microVM** (Linux, Deno 2.x runtime, no Bun/Node, 4 GiB RAM, 30 min timeout). We want Franky's
agent runs to verify UI work in a real browser, save screenshots, and record short sessions —
by **vendoring this MCP server into the sandbox image**. (Connecting back to the developer's
local machine was explicitly rejected — do not revisit.)

This repo's job, before any Franky work happens: make the server runnable **headless on Linux
under Deno with no Bun**, add **session recording + file artifacts**, and prove everything
**locally on macOS** first. The macOS headed dev flow (`bun run src/index.ts`, no env vars) must
remain byte-for-byte unchanged.

## What Franky will consume (the contract — freeze these)

- **Artifact:** a committed single-file bundle `dist/browser-mcp.js`, run in the sandbox as
  `deno run -A dist/browser-mcp.js` (stdio MCP). Franky's snapshot build clones a **pinned ref**
  of this repo and copies that file. Any src change ⇒ rebuild + recommit + move the pin.
- **Env vars (names frozen; Franky sets these verbatim):**
  - `BROWSER_HEADLESS=1` — headless mode (already exists)
  - `BROWSER_NO_SANDBOX=1` — NEW: appends `--no-sandbox --disable-setuid-sandbox
    --disable-dev-shm-usage --disable-gpu`; unset ⇒ args unchanged
  - `BROWSER_USER_DATA_DIR` — persistent profile (already exists)
  - `PUPPETEER_CACHE_DIR` / `PUPPETEER_EXECUTABLE_PATH` — Chrome resolution (standard
    puppeteer vars; verify they work when the server is spawned with a stripped env)
  - `BROWSER_ARTIFACT_DIR` — NEW: where screenshots/recordings land on disk
  - `BROWSER_FFMPEG_PATH` — NEW: optional ffmpeg override; absent ffmpeg must degrade, not error
- **Chrome provisioning:** keep the full `puppeteer` package (macOS zero-config stays). Linux
  Chrome is installed at Franky image-build time via
  `@puppeteer/browsers install chrome@<pinned> --path $PUPPETEER_CACHE_DIR`. Record the pinned
  Chrome version this puppeteer release expects in the README, plus the Linux shared-lib
  (apt) deps list discovered during the Docker smoke — Franky installs exactly those.
- **Recording output:** files under `BROWSER_ARTIFACT_DIR`; tool results return **file paths as
  text blocks** (no new MCP content type). Franky's upload tool serves that directory.

## Repo facts (verified 2026-08-15)

- TS MCP server over stdio, `bun run src/index.ts`, no build step yet. ~1,000 LOC in `src/`.
- Deps: `puppeteer ^24.43.0` (full), `@modelcontextprotocol/sdk ^1.29.0`, `zod ^3`.
- **Zero Bun APIs in `src/`** (tests only). One bare Node global to fix: `Buffer` at
  `src/tools/inspection.ts:34`. `.ts`-extension imports (tsconfig `allowImportingTsExtensions`,
  `noEmit`, moduleResolution Bundler).
- Single launch site `src/browser.ts:52-97`: `headless: process.env.BROWSER_HEADLESS === '1'`,
  viewport 1280×800, `userDataDir`, args `--no-first-run --no-default-browser-check`.
- Module singleton `BrowserSession` (`src/browser.ts:297`); per-tab `TabRecord`
  (`src/browser.ts:29-35`) with console/network ring buffers (cap 200, in-RAM —
  recordings must NOT follow this pattern; frames go to disk).
- Cleanup paths that must flush recordings: `closeTab` (`src/browser.ts:133-150`), `close`
  (`src/browser.ts:176-188`), SIGINT/SIGTERM handler (`src/browser.ts:300-314`) — currently
  a synchronous `process.exit(0)` that would truncate in-flight recordings.
- Known bug: tab pruning compares `Page` object identity and can prune live tabs (noted in
  `plans/browser-mcp-server-2026-05-08-tracker.md:67`).
- `ToolResult` (`src/tools/registry.ts:4-11`): text + inline base64 image blocks only.
  Screenshot tool: `src/tools/inspection.ts:34-35`. Tools registered from a flat array
  (`src/tools/registry.ts:53-61`).
- Toolchain: `bunx tsc --noEmit` · `bunx biome check .` (noConsole — **stdout is JSON-RPC,
  never print to it**) · `BROWSER_HEADLESS=1 bun test`.

## Work stream A — Linux/Deno runtime readiness

- [ ] **A1. Env-gated hardened launch args.** When `BROWSER_NO_SANDBOX === '1'`, append exactly
  the four flags above at the launch site; unset ⇒ untouched. Unit-test the computed args both
  ways. Document in README env table.
- [ ] **A2. Chrome provisioning contract.** Verify empirically that `PUPPETEER_CACHE_DIR` and
  `PUPPETEER_EXECUTABLE_PATH` are honored when the server is spawned as a subprocess with a
  minimal env (`PATH`, `HOME`, `BROWSER_HEADLESS=1` only) — that is how OpenCode spawns MCP
  servers. If ignored, add an explicit `executablePath: process.env.PUPPETEER_EXECUTABLE_PATH`
  passthrough. Record the pinned Chrome version in the README.
  Test: `PUPPETEER_CACHE_DIR=/tmp/pptr-cache bunx @puppeteer/browsers install chrome@<pinned>`
  then launch from that cache with a stripped env.
- [ ] **A3. Fix tab-pruning identity bug.** Key `TabRecord`s by stable CDP target id, not `Page`
  object identity; prune only records whose target is gone. Write the regression test first
  (two tabs, trigger prune, both survive). Recording state will hang off this key — it must be
  stable before stream B.
- [ ] **A4. Runtime portability.** `import { Buffer } from 'node:buffer'` in
  `src/tools/inspection.ts`; grep `src/` for any other bare Node globals (`process` is fine
  under Deno 2; `__dirname`/`require` are not).
- [ ] **A5. Committed single-file bundle.** Add
  `"build": "bun build src/index.ts --target=node --outfile dist/browser-mcp.js"` (no minify).
  Puppeteer's dynamic requires (package-version/browser metadata lookups) are the likely snag —
  patch with build-time defines/aliases; fall back to esbuild if `bun build` mishandles it
  (note the fallback if taken). Commit the bundle; README note: rebuild + recommit on every
  src change.
- [ ] **A6. Deno + Linux smoke.** Write a reusable smoke script (spawn a command as stdio MCP:
  initialize → new_tab → navigate to local fixture → screenshot → close; assert non-empty
  base64 PNG). Run on macOS via `deno run -A dist/browser-mcp.js` with `BROWSER_HEADLESS=1`.
  Then in a `linux/amd64` Docker container with Deno: install Chrome via
  `deno run -A npm:@puppeteer/browsers install chrome@<pinned> --path /tmp/pptr-cache`, install
  Chrome's shared-lib apt deps, run the same smoke with
  `BROWSER_HEADLESS=1 BROWSER_NO_SANDBOX=1 PUPPETEER_CACHE_DIR=/tmp/pptr-cache`.
  **Capture the working Dockerfile + deps list in the README** — Franky's image build reuses it
  verbatim. (No Docker available ⇒ mark deferred; Franky gates its integration on an
  in-sandbox smoke anyway.)

## Work stream B — recording + file artifacts (after A3/A5)

Backend decision (committed): **raw CDP `Page.startScreencast`** on the tab's `CDPSession`.
Rejected: `page.screencast()` (hard ffmpeg dep, no incremental flush). Out of scope: HAR,
DevTools tracing, audio/cursor overlays, uploading anywhere.

- [ ] **B1. Artifact dir + screenshot-to-file.** `BROWSER_ARTIFACT_DIR` (default: OS tmp +
  `/browser-mcp-artifacts`), lazy creation, collision-free timestamped names. Optional param on
  `browser_screenshot` to write the PNG to disk and return the path as text (alongside or
  instead of the inline image).
- [ ] **B2. Recording engine** (new `src/recording.ts`). `format: 'jpeg'`, `quality` default 60,
  `maxWidth` default 1280 (aspect-preserving), `everyNthFrame` default 2. On each
  `Page.screencastFrame`: ack immediately, write `<artifact_dir>/<session-id>/frame-<n>.jpg`,
  append `{n, monotonic ts}` to `frames.ndjson`. **No frame bytes retained in memory.**
  `max_duration_s` default 120, hard cap 300 — auto-stop and note the cap fired. State lives on
  `TabRecord` keyed by target id; one active recording per tab (second start ⇒ error).
- [ ] **B3. Optional webm assembly.** Resolve ffmpeg from `BROWSER_FFMPEG_PATH` else PATH;
  absent ⇒ return frames dir + "assembly skipped" note, never an error. Assemble via concat
  demuxer with per-frame durations from `frames.ndjson` (VP9, VP8 fallback); subprocess, never
  stdout. Delete frames on success, keep on failure. Report output byte size.
- [ ] **B4. Flush hooks.** `closeTab`: stop + finalize before closing the page. `close`:
  finalize all tabs. Signal handler: rework to async drain — stop screencasts, flush ndjson,
  **skip ffmpeg on the signal path** (leave frames marked "unassembled"), guard double-invoke,
  then exit. Transport-level test: SIGTERM mid-recording ⇒ frames + metadata survive on disk.
- [ ] **B5. Tools.** `browser_start_recording` (`tab?`, `max_duration_s`, `quality`,
  `max_width`) → session id + dir as text. `browser_stop_recording` → webm path (or frames
  dir), duration, frame count, byte size. Zod schemas encode the caps. Register in the flat
  array; README worked example.
- [ ] **B6. Budget validation.** Record ~2 min headless against a busy fixture; measure peak
  RSS + disk for frames and webm; write numbers into README. Tune quality/everyNthFrame if disk
  exceeds ~100 MB/min. Manual headed macOS checklist in README (start, browse, stop, play the
  webm) — this is the user's local test procedure.
- [ ] **B7. Rebuild + recommit bundle; rerun the Deno smoke** extended with a record round-trip
  (no-ffmpeg fallback acceptable). Note the final ref — that's what Franky pins.

## Definition of done

- `bunx tsc --noEmit`, `bunx biome check .`, `BROWSER_HEADLESS=1 bun test` all clean (incl. new
  launch-arg, pruning-regression, recording lifecycle/flush/fallback tests).
- Committed `dist/browser-mcp.js` passes the Deno smoke on macOS and the linux/amd64 headless
  smoke (or Linux explicitly deferred with a note).
- Playable webm with ffmpeg; graceful frames-dir fallback without. SIGTERM mid-recording leaves
  recoverable frames (test-verified).
- Budget numbers measured; defaults fit 4 GiB / 30 min.
- macOS headed dev flow verified unchanged with no env vars set.
- README documents: full env table, provisioning contract + pinned Chrome version, Linux deps
  list/Dockerfile, recording docs, local test checklists, rebuild-and-recommit rule.

## Known risks

- **Puppeteer may not bundle cleanly** (dynamic requires). Fallbacks in order: esbuild with
  defines/aliases → clone-plus-node_modules vendoring on the Franky side (env/args work here
  stays valid either way).
- **Cache-path resolution inside a bundle** — puppeteer computes its cache path at import time;
  caught by A2/A6, mitigated by the explicit `executablePath` passthrough.
- **CDP screencast is content-driven/irregular** — real timestamps + concat durations handle
  it; jerky video on idle pages is acceptable for verification footage.
- **ffmpeg assembly time** could stall a stop call — bounded by the 300 s cap; if still slow,
  make assembly async (stop returns frames dir immediately) and note it.
