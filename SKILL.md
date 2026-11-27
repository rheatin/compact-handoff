---
name: compact-handoff
description: Pre-compaction HANDOFF.md generator and cross-host session continuity across opencode, pi, omp, claude-code, gemini-cli, copilot-cli, and antigravity. Automatically captures HANDOFF.md before context compaction, replaces compaction summaries, and supports manual /handoff updates or cross-host resume.
argument-hint: "[next session focus | resume | status | config]"
---

# Compact Handoff (`HANDOFF.md`)

Maintain seamless session continuity in `<project-root>/HANDOFF.md` across local coding agents:
- **`opencode`** (and OpenCode-compatible forks via `OPENCODE_CONFIG_DIR`)
- **`pi`** (`@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai`)
- **`omp`** (`@oh-my-pi/pi-coding-agent`; `~/.omp/agent/extensions/handoff.ts`)
- **`claude-code`** (`~/.claude/settings.json`)
- **`gemini-cli`** (`~/.gemini/config/hooks.json` or `~/.gemini/settings.json`)
- **`copilot-cli`** (`~/.copilot/hooks/compact-handoff.json`)
- **`antigravity`** (`~/.gemini/config/hooks.json`)

Unified configuration lives at `~/.config/handoff/config.json`, the canonical template at `templates/HANDOFF.md`, and the CLI entry point at `scripts/cli.mjs` (`compact-handoff`).

## Automatic Pre-Compaction & Lifecycle Behavior

- **Pre-compaction trigger**: By default (`50%` of context window, or the configured token threshold in `~/.config/handoff/config.json`), `HANDOFF.md` in the project root is automatically updated at turn boundaries right before compaction (with an `85%` emergency safety cap mid-turn) and used as the compaction summary so in-flight state, decisions, and dead ends survive context resets.
- **Dual-mode capture & dynamic transcript budget**:
  - **Code & implementation mode**: When uncommitted or newly committed git diffs exist, `handoff-core` uses a 45 KB fair-share diff budget and dynamically allocates `57 KB - diffBytes` (at least **12 KB**) for the distilled transcript.
  - **Pure discussion / planning mode**: When `git diff` is empty (design, architecture, or research sessions), the transcript budget expands up to **48 KB** and applies user-intent-first distillation—preserving the initial goal, all user turns across the session, headings/decisions/questions, and touched file paths while stripping code blocks longer than 8 lines.
- **Startup injection**: When a new session starts in a workspace with an active `HANDOFF.md` (`> Last updated` != `never`), `compact-handoff context` surfaces a bounded rolling window of `> Last updated`, `## Overview`, `## Current status`, `## Decision log`, `## Gotchas / constraints`, `## Open questions` (when unresolved items exist), and `## Commands`.
- **Clean git working tree**: `HANDOFF.md`, `.claude/handoff.state.json`, `.opencode/handoff.state.json`, and `.gemini/handoff.state.json` are automatically added to `<git-dir>/info/exclude` (when `autoExcludeGit: true`), never dirtying tracked `.gitignore`. Capture metadata is stored in `<git-dir>/info/handoff.state.json`.

## Plan & Alignment Checkpoints

When a long design, architecture, or research discussion reaches key conclusions—or before transitioning from planning to implementation across hosts (`opencode`, `pi`, `omp`, `claude-code`, `gemini-cli`, `copilot-cli`, `antigravity`)—create a handoff checkpoint even if no files have been edited yet:

- **When to checkpoint**: After agreeing on an architectural plan, resolving major tradeoffs, completing codebase research (`path:line` findings), or before handing off to another host/session to execute.
- **How to capture**: Run `/handoff` (or `compact-handoff capture --trigger manual --agent <name>`). Because `git diff` is empty, `compact-handoff` automatically enters Discussion Mode with up to a **48 KB** distilled transcript budget.
- **What to record**:
  - `**Done**`: Settled conclusions, researched modules with `path:line` or symbol references, and aligned design choices.
  - `**In progress**`: Topics still being evaluated or refined.
  - `**Next**`: The agreed next alignment decision or the first concrete implementation step.
  - `## Decision log`: All agreed design choices and rejected alternatives (`Chose X over Y because Z`).
  - `## Open questions`: Unresolved tradeoffs or items awaiting user confirmation (cleared once settled).

## Manual `/handoff` Workflows

Determine intent from the user's invocation and arguments:

### 1. Capture / Update `<project-root>/HANDOFF.md` (Default)
When invoked to save or hand off the current session:

1. **Initialize & exclude**: Run `compact-handoff init` (or `node scripts/cli.mjs init`) in the project root. This creates `<project-root>/HANDOFF.md` from `templates/HANDOFF.md` if absent and configures `<git-dir>/info/exclude`.
2. **Read existing `HANDOFF.md` & git state**: Read `<project-root>/HANDOFF.md`, `git status --short`, and `git log --oneline -n 5`.
3. **Update the canonical sections surgically**:
   - Header: Update `> Last updated: <ISO-8601 timestamp> (via <agent-name> · manual)` where `<agent-name>` identifies your runtime (`opencode`, `pi`, `omp`, `claude-code`, `gemini-cli`, `copilot-cli`, or `antigravity`).
   - `## Overview`: Preserve existing content byte-for-byte. Only populate it (1–2 concise sentences) if it is still empty/comment-only.
   - `## Current status`: Regenerate `**Done**`, `**In progress**`, and `**Next**` with concise, path-specific bullets. If the user passed arguments describing what the next session will focus on, tailor `**Next**` accordingly.
   - `## Decision log`: Append-only, prefixed with `- YYYY-MM-DD: <decision + rationale + rejected alternatives>`. Deduplicate against existing entries; never delete prior decisions.
   - `## Gotchas / constraints`: Append-only non-obvious traps, environment quirks, failed approaches, and dead ends ("Tried X, failed because Y"). Deduplicate against existing entries.
   - `## Open questions`: Regenerate on each capture as a current snapshot of unresolved questions, open tradeoffs, or items awaiting user confirmation (use `- (none)` once all items are resolved).
   - `## Commands`: Preserve existing content byte-for-byte (only populate verified build/test/lint commands if currently empty/comment-only). Preserve any custom `##` sections verbatim.
4. **Language & secret safety**:
   - Preserve the human language used in the conversation / existing `HANDOFF.md`.
   - Reference specs, plans, ADRs, commits, or PRs by path/URL rather than duplicating them.
   - Redact all secrets, API keys, tokens, passwords, and PII.

### 2. Resume Work Across Hosts (`/handoff resume` or picking up an existing `HANDOFF.md`)
When asked to resume, continue, or pick up work from another host (`opencode`, `pi`, `omp`, `claude-code`, `gemini-cli`, `copilot-cli`, or `antigravity`):

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
compact-handoff install [--hosts opencode,pi,claude,gemini,omp,copilot,antigravity] [--dry-run]
```
