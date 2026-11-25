# compact-handoff

**English** | [简体中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

**Pre-compaction `HANDOFF.md` generator & compaction replacement for coding agents.**

`compact-handoff` keeps long-running engineering sessions from losing architectural context, rationale, and dead ends when an agent hits its context window limit or when you switch tools mid-feature.

> **Scope note:** `compact-handoff` is **not** a multi-agent orchestrator or task router. It does not spawn agent swarms or coordinate parallel workers — it maintains a single, surgical `<project-root>/HANDOFF.md` state file that survives context compactions and seamlessly transfers context across **OpenCode**, **Pi**, **Claude Code**, and **Gemini CLI**.

---

## How It Works

```
  Context Usage Check (default: 50% window or custom token threshold)
         │
         ├── Mid-turn tool loop & < 85% ──▶ Defer compaction (never interrupt mid-answer)
         │
         ├── Turn boundary (>= 50%) OR Emergency Cap (>= 85% mid-turn)
         │        │
         │        ▼
         │   [Pre-Compaction Capture]
         │     • Dynamic transcript budget: 12 KB (with 45 KB git diff) up to
         │       48 KB (when git diff is empty in pure design/planning sessions)
         │     • User-intent-first distillation (strips >8-line code blocks,
         │       keeps initial goal, all user turns, conclusions & questions)
         │     • Secret path omission + inline token/key redaction
         │     • Dual-mode LLM JSON extractor (Code Mode + Discussion Mode,
         │       with discussion-aware deterministic fallback)
         │        │
         │        ▼
         │   [Surgical HANDOFF.md Update]
         │     • Preserves Overview, Commands & custom ## sections verbatim
         │     • Regenerates Current status (Done / In progress / Next) &
         │       Open questions snapshot
         │     • Appends & deduplicates dated Decision log + Gotchas (EN + CJK)
         │        │
         │        ▼
         │   [Compaction Replacement]
         │     • Replaces generic compaction prose with buildCompactSummaryFromHandoff()
         │     • Rolling window (latest 15 Done / Decisions / Gotchas / Open questions)
         │       in prompt; 100% full history preserved on disk in HANDOFF.md
         │
         └── New Session / Resume in Any Host
                  │
                  ▼
             [Rolling-Window Startup Injection]
               • Injects Overview, Current status, latest 10 Decisions,
                 latest 15 Gotchas, Open questions, and Commands on first turn
```

---

## Supported Hosts

| Host | Integration Mechanism | Auto Pre-Compaction | Compaction Replacement | Startup Injection | Subagent Isolation |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **OpenCode** | Extension (`extensions/opencode/handoff.ts`) | ✅ Turn-boundary + 85% cap | ✅ `experimental.session.compaction.provide` | ✅ `chat.message` | ✅ Skips child/subagent sessions |
| **Pi (`pi`)** | Extension (`extensions/pi/handoff.ts`) | ✅ `agent_end` + `turn_end` 85% cap | ✅ `session_before_compact` | ✅ `before_agent_start` | ✅ Skips `PI_SUBAGENT_CHILD` |
| **Claude Code** | Hooks (`~/.claude/settings.json`) | ✅ `PreCompact` hook | ⚠️ Advisory `systemMessage` | ✅ `SessionStart` `additionalContext` | ✅ Recursion guard |
| **Gemini CLI** | Hooks (`~/.gemini/config/hooks.json`) | ✅ `PreCompact` + `Stop` threshold | ⚠️ Hook capture prior to reset | ✅ `SessionStart` `additionalContext` | ✅ Recursion guard |

---

## Quick Install

### Option A: Install via `skills` CLI (Skill + Scripts)

```bash
npx skills add rheatin/compact-handoff
```

### Option B: Full Multi-Host Setup (Recommended)

Clone the repository and run the idempotent installer to wire the CLI (`~/.local/bin/compact-handoff`), unified config (`~/.config/handoff/config.json`), skill directories, OpenCode/Pi extensions, and Claude Code / Gemini CLI hooks:

```bash
git clone https://github.com/rheatin/compact-handoff.git
cd compact-handoff

# Preview all changes without touching disk
node scripts/install.mjs --dry-run

# Install default hosts (OpenCode, Pi, Claude Code)
node scripts/install.mjs

# Or include Gemini CLI and customize threshold
node scripts/install.mjs --hosts opencode,pi,claude,gemini --percentage 50
```

#### Installer Options

```bash
node scripts/install.mjs [options]
  --hosts <list>          opencode,pi,claude,gemini or "all" (default: opencode,pi,claude)
  --opencode-dir <dir>    Override OpenCode config dir (default: $OPENCODE_CONFIG_DIR or ~/.config/opencode)
  --mode <mode>           percentage | tokens | auto
  --percentage <1-100>    Context percentage trigger (default: 50)
  --tokens <N>            Token count trigger (default: 100000)
  --session-end <on|off>  Capture HANDOFF.md on session exit (default: off)
  --subagent <on|off>     Use explore subagent for OpenCode capture (default: on)
  --link-handoff          Also symlink ~/.local/bin/handoff -> compact-handoff
  --copy                  Copy files instead of symlinking skills/extensions
  --dry-run               Print planned operations without writing files
  --uninstall             Remove compact-handoff links and host hooks cleanly
```

---

## Configuration (`~/.config/handoff/config.json`)

All four hosts read the same configuration file at `~/.config/handoff/config.json` (overridable via `HANDOFF_CONFIG_PATH`):

```json
{
  "trigger": {
    "mode": "percentage",
    "percentage": 50,
    "tokens": 100000
  },
  "model": "current",
  "useSubagent": true,
  "captureOnSessionEnd": false,
  "autoExcludeGit": true
}
```

Updating `trigger` via `compact-handoff config` automatically syncs `compaction.trigger` into `${OPENCODE_CONFIG_DIR:-~/.config/opencode}/opencode.json` (or `.jsonc`) if present.

---

## CLI Reference

```bash
compact-handoff status [dir]
compact-handoff init [dir]
compact-handoff capture [--trigger auto|manual|session-end] [--agent <name>] [--transcript <path>] [dir]
compact-handoff context [dir]
compact-handoff config --show
compact-handoff config [--mode percentage|tokens|auto] [--percentage 50] [--tokens 100000] [--session-end on|off] [--subagent on|off] [--auto-exclude on|off] [--model current]
compact-handoff install [--hosts opencode,pi,claude,gemini] [--dry-run] [--uninstall]
compact-handoff hook <claude|gemini> <precompact|sessionstart|sessionend|stop>
```

---

## Canonical `HANDOFF.md` Structure

```markdown
# Handoff

> Last updated: 2026-11-25T15:30:00.000Z (via opencode · auto)

## Overview

Lightweight HTTP/WebSocket session broker written in TypeScript.

## Current status

**Done**
- Added JWT refresh rotation in `src/auth/tokens.ts`

**In progress**
- Wiring rate-limiter middleware in `src/middleware/rate-limit.ts`

**Next**
- Add integration tests for concurrent refresh bursts in `tests/auth.test.mjs`

## Decision log

- 2026-11-25: Store session state in SQLite WAL mode instead of Redis to avoid extra local infra.

## Gotchas / constraints

- Node `execFileSync` throws `ETIMEDOUT` if stdout exceeds `maxBuffer`; keep diff captures bounded.

## Open questions

- Confirm whether sliding-window TTL should reset on WebSocket reconnect.

## Commands

- `npm test`
```

---

## Design Principles

1. **Dual-Mode Support (Code Changes + Pure Design/Planning Discussions)**: Within a 57 KB combined evidence budget, the transcript budget scales dynamically from **12 KB** (when the 45 KB git diff budget is full) up to **48 KB** when `git diff` is empty. User-intent-first distillation strips code blocks longer than 8 lines, collapses verbose prose, and preserves the initial goal, all user turns, headings/conclusions, touched file paths, and `## Open questions`.
2. **Surgical Markdown Updates**: `## Overview`, `## Commands`, and any custom `##` sections are preserved byte-for-byte. Only `> Last updated`, `## Current status`, the regenerated `## Open questions` snapshot, and append-only deltas in `## Decision log` / `## Gotchas / constraints` are updated.
3. **Bilingual Deduplication**: Jaccard/overlap similarity matching with CJK bigram tokenization prevents duplicate decisions and gotchas across repeated compactions in both English and CJK conversations.
4. **45 KB Fair-Share Diff Budget + Secret Redaction**: Water-filling allocation ensures small changed files aren't starved by a single large generated file, while `.env*`, keys, certificates, and inline API tokens/Bearer headers are omitted or redacted.
5. **Clean Git Working Trees**: Automatically adds `HANDOFF.md` and state files to `.git/info/exclude` (including worktree `git-common-dir`) so tracked `.gitignore` files are never dirtied.
6. **Deterministic Fallback & Backoff**: If an LLM runner fails, times out (15s), or is unavailable (3-minute cooldown backoff), `runStandaloneCapture` seamlessly falls back to deterministic git + discussion-topic/open-question extraction so compaction never stalls.
7. **Zero Runtime Dependencies**: Pure Node.js (`>= 18`) ESM core with zero `npm` runtime dependencies.

---

## Development & Tests

```bash
npm test
```

Runs `node --test tests/*.test.mjs` covering core markdown splicing, secret redaction, 45 KB fair-share diffs, OpenCode extension turn-boundary deferral & backoff, Pi extension lifecycle, idempotent multi-host installation/uninstallation, and Claude/Gemini CLI hook protocols.

---

## Credits & License

- Inspired by [`AONG11a/handoff-md`](https://github.com/AONG11a/handoff-md).
- Licensed under the [MIT License](LICENSE).
