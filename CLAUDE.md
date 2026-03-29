# agent-view

CLI tool for visual verification of desktop apps (Electron/Tauri) via Chrome DevTools Protocol.

## Current Stage

**ALWAYS read `.claude.current-stage.md` before starting work.**
**ALWAYS update `.claude.current-stage.md` after completing any iteration, phase, bugfix, or feature work.**

## Stack

- TypeScript + Node.js (ESM, `"type": "module"`)
- pnpm
- `chrome-remote-interface` — CDP client
- `commander` — CLI framework
- TCP on localhost:47922 — IPC between CLI and lazy server

## Architecture

```
CLI (commander) → TCP → Lazy Server → CDP → Electron/Tauri/Browser
```

- CLI reads `agent-view.config.json` from cwd, sends JSON commands to server
- Server manages CDP connections, caches session refs, auto-shuts down after 5min idle
- One server for all projects, distinguished by CDP port
- Delimiter-based protocol (`\n`) for TCP IPC

## Project Structure

```
src/
  types.ts              # Shared types
  config/               # Config read/write/auto-generate
  cdp/                  # CDP transport (chrome-remote-interface wrapper)
  adapters/             # Runtime adapters (electron, browser, tauri) + registry
  inspectors/           # DOM inspector (AX tree → compact text)
  server/               # Lazy TCP server + ref store
  cli/                  # CLI entry point + commands
    commands/           # init, discover, dom, stop (+ future: launch, click, fill, screenshot)
```

## Key Conventions

- All imports use `.js` extensions (ESM requirement)
- `host: '127.0.0.1'` always explicit in CDP calls (Node.js defaults to IPv6)
- Output format: plain text for dom/scene, JSON only for discover
- Session ref IDs: incremental counter persisted in server memory, cleared per-window on each `dom` call

## Test Project

Primary: `D:\web-projects\web-client` (Electron + Vue 3, `npm run dev`)
- CDP enabled via `--remote-debugging-port=9222` in `electron/main/index.js` (dev-only)

## Plans

Implementation plans stored in `.claude/plans/`.

## Dev Commands

```bash
pnpm build              # TypeScript compilation
npx tsx src/cli/index.ts # Run CLI in dev mode (no build needed)
```
