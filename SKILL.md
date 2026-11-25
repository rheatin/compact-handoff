---
name: compact-handoff
description: Pre-compaction HANDOFF.md generator and cross-host session continuity across opencode, pi, claude-code, and gemini-cli. Automatically captures HANDOFF.md before context compaction, replaces compaction summaries, and supports manual /handoff updates or cross-host resume.
argument-hint: "[next session focus | resume | status | config]"
---

# Compact Handoff (`HANDOFF.md`)

Maintain seamless session continuity in `<project-root>/HANDOFF.md` across local coding agents:
- **`opencode`** (and OpenCode-compatible forks via `OPENCODE_CONFIG_DIR`)
- **`pi`** (`@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai`)
- **`claude-code`** (`~/.claude/settings.json`)
- **`gemini-cli`** (`~/.gemini/config/hooks.json` or `~/.gemini/settings.json`)

Unified configuration lives at `~/.config/handoff/config.json`, the canonical template at `templates/HANDOFF.md`, and the CLI entry point at `scripts/cli.mjs` (`compact-handoff`).

## Automatic Pre-Compaction & Lifecycle Behavior

- **Pre-compaction trigger**: By default (`50%` of context window, or the configured token threshold in `~/.config/handoff/config.json`), `HANDOFF.md` in the project root is automatically updated at turn boundaries right before compaction (with an `85%` emergency safety cap mid-turn) and used as the compaction summary so in-flight state, decisions, and dead ends survive context resets.
- **Startup injection**: When a new session starts in a workspace with an active `HANDOFF.md` (`> Last updated` != `never`), `compact-handoff context` surfaces a bounded rolling window of `> Last updated`, `## Overview`, `## Current status`, `## Decision log`, `## Gotchas / constraints`, and `## Commands`.
- **Clean git working tree**: `HANDOFF.md`, `.claude/handoff.state.json`, `.opencode/handoff.state.json`, and `.gemini/handoff.state.json` are automatically added to `<git-dir>/info/exclude` (when `autoExcludeGit: true`), never dirtying tracked `.gitignore`. Capture metadata is stored in `<git-dir>/info/handoff.state.json`.

## Manual `/handoff` Workflows

Determine intent from the user's invocation and arguments:

### 1. Capture / Update `<project-root>/HANDOFF.md` (Default)
When invoked to save or hand off the current session:

1. **Initialize & exclude**: Run `compact-handoff init` (or `node scripts/cli.mjs init`) in the project root. This creates `<project-root>/HANDOFF.md` from `templates/HANDOFF.md` if absent and configures `<git-dir>/info/exclude`.
2. **Read existing `HANDOFF.md` & git state**: Read `<project-root>/HANDOFF.md`, `git status --short`, and `git log --oneline -n 5`.
3. **Update the 5 canonical sections surgically**:
   - Header: Update `> Last updated: <ISO-8601 timestamp> (via <agent-name> · manual)` where `<agent-name>` identifies your runtime (`opencode`, `pi`, `claude-code`, or `gemini-cli`).
   - `## Overview`: Preserve existing content byte-for-byte. Only populate it (1–2 concise sentences) if it is still empty/comment-only.
   - `## Current status`: Regenerate `**Done**`, `**In progress**`, and `**Next**` with concise, path-specific bullets. If the user passed arguments describing what the next session will focus on, tailor `**Next**` accordingly.
   - `## Decision log`: Append-only, prefixed with `- YYYY-MM-DD: <decision + rationale + rejected alternatives>`. Deduplicate against existing entries; never delete prior decisions.
   - `## Gotchas / constraints`: Append-only non-obvious traps, environment quirks, failed approaches, and dead ends ("Tried X, failed because Y"). Deduplicate against existing entries.
   - `## Commands`: Preserve existing content byte-for-byte (only populate verified build/test/lint commands if currently empty/comment-only). Preserve any custom `##` sections verbatim.
4. **Language & secret safety**:
   - Preserve the human language used in the conversation / existing `HANDOFF.md`.
   - Reference specs, plans, ADRs, commits, or PRs by path/URL rather than duplicating them.
   - Redact all secrets, API keys, tokens, passwords, and PII.

### 2. Resume Work Across Hosts (`/handoff resume` or picking up an existing `HANDOFF.md`)
When asked to resume, continue, or pick up work from another host (`opencode`, `pi`, `claude-code`, or `gemini-cli`):

1. Read `<project-root>/HANDOFF.md` and run `git status --short` + `git log --oneline -n 5` to verify whether commits or uncommitted edits occurred since `> Last updated`.
2. Respect prior choices in `## Decision log` and avoid repeating dead ends listed in `## Gotchas / constraints`.
3. Summarize the current state briefly (3–5 lines) and proceed directly with `**In progress**` / `**Next**`.

### 3. CLI & Configuration Management
Use `compact-handoff` (or `node scripts/cli.mjs`) when checking status, configuring thresholds, installing host integrations, or running standalone captures:

```bash
compact-handoff status [dir]
compact-handoff init [dir]
compact-handoff capture [--trigger manual|auto|session-end] [--agent <name>] [dir]
compact-handoff context [dir]
compact-handoff config --show
compact-handoff config [--mode percentage|tokens] [--percentage <1-100>] [--tokens <N>] [--session-end on|off] [--subagent on|off]
compact-handoff install [--hosts opencode,pi,claude,gemini] [--dry-run]
```
