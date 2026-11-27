# compact-handoff

**English** | [English README](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

**面向编程 Agent 的上下文压缩前（Pre-Compaction）`HANDOFF.md` 生成器与压缩摘要替代器。**

`compact-handoff` 帮助长时间运行的工程会话在触发上下文窗口上限或跨工具切换时，避免丢失架构决策、上下文动机与已踩过的坑。

> **定位说明**：`compact-handoff` **不是**多 Agent 编排器或任务路由器。它不会派生 Agent 集群，而是维护单一、精确的 `<project-root>/HANDOFF.md` 状态文件，使其在上下文压缩后依然完整可用，并在 **OpenCode**、**Pi**、**Oh My Pi (`omp`)**、**Claude Code**、**Gemini CLI**、**GitHub Copilot CLI** 与 **Google Antigravity** 之间无缝接力。

---

## 工作原理

```
  上下文用量检测（默认：50% 窗口比例或自定义 Token 阈值）
         │
         ├── 处于 Turn 内工具循环且 < 85% ──▶ 推迟压缩（绝不在回答中途打断）
         │
         ├── 到达 Turn 边界 (>= 50%) 或触发紧急上限 (>= 85%)
         │        │
         │        ▼
         │   [压缩前捕获 (Pre-Compaction Capture)]
         │     • 动态对话预算：满 45 KB Git Diff 时保底 12 KB；无 Diff 的纯讨论
         │       规划场景下自动扩展至最高 48 KB
         │     • 用户意图优先蒸馏：剥离超过 8 行的代码块，保留初始目标、全部用户
         │       轮次、结论标题与待确认问题
         │     • 自动跳过敏感路径并脱敏内联 Token / 密钥
         │     • 双模式 JSON 提取器（代码实现模式 + 设计讨论模式，失败时自动降级
         │       为支持讨论提取的确定性回退）
         │        │
         │        ▼
         │   [外科手术式更新 HANDOFF.md]
         │     • 原样保留 Overview、Commands 与所有自定义 ## 章节
         │     • 重新生成 Current status (Done / In progress / Next) 与
         │       Open questions 当前快照
         │     • 追加并去重带日期的 Decision log 与 Gotchas（支持英文 + 中日韩双语）
         │        │
         │        ▼
         │   [压缩摘要替换 (Compaction Replacement)]
         │     • 用 buildCompactSummaryFromHandoff() 替换通用压缩摘要
         │     • 提示词仅注入最近 15 条滚动窗口（含 Open questions）；
         │       磁盘 HANDOFF.md 保留 100% 完整历史
         │
         └── 在任意宿主中开启新会话 / 继续任务
                  │
                  ▼
             [启动时滚动窗口注入]
               • 仅在首轮注入 Overview、Current status、最近 10 条 Decision、
                 最近 15 条 Gotchas、Open questions 与 Commands
```

---

## 支持的宿主

| 宿主 | 集成方式 | 自动压缩前捕获 | 压缩摘要替换 | 启动注入 | 子 Agent 隔离 |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **OpenCode** | 插件 (`extensions/opencode/handoff.ts`) | ✅ Turn 边界 + 85% 上限 | ✅ `experimental.session.compaction.provide` | ✅ `chat.message` | ✅ 自动跳过子会话 |
| **Pi (`pi`)** | 插件 (`extensions/pi/handoff.ts`) | ✅ `agent_end` + `turn_end` 85% 上限 | ✅ `session_before_compact` | ✅ `before_agent_start` | ✅ 跳过 `PI_SUBAGENT_CHILD` |
| **Oh My Pi (`omp`)** | 插件 (`extensions/omp/handoff.ts`) | ✅ `session_before_compact` + `agent_end`/`turn_end` 上限 | ⚠️ 通过 `session.compacting` 注入 HANDOFF 窗口；压缩摘要仍由 omp 的 `/handoff` 拥有 | ✅ `before_agent_start` | ✅ 跳过 `ctx.agent.kind === "sub"` |
| **Claude Code** | Hooks (`~/.claude/settings.json`) | ✅ `PreCompact` hook | ⚠️ `systemMessage` 提示 | ✅ `SessionStart` `additionalContext` | ✅ 递归守卫 |
| **Gemini CLI** | Hooks (`~/.gemini/config/hooks.json`) | ✅ `PreCompact` + `Stop` 阈值 | ⚠️ 重置前 Hook 捕获 | ✅ `SessionStart` `additionalContext` | ✅ 递归守卫 |
| **GitHub Copilot CLI** | Hooks (`~/.copilot/hooks/compact-handoff.json`) | ✅ `preCompact` hook | ⚠️ 仅提示（该 Hook 为通知型） | ✅ `sessionStart` `additionalContext` | ✅ 递归守卫 |
| **Google Antigravity** | Hooks (`~/.gemini/config/hooks.json`) | ✅ `PreInvocation` + `Stop` 阈值 | ⚠️ 仅提示（重置前捕获） | ✅ `SessionStart` `injectSteps` | ✅ 递归守卫 |

---

## 快速安装

### 方式一：通过 `skills` CLI 安装（Skill + 脚本）

```bash
npx skills add rheatin/compact-handoff
```

### 方式二：完整多宿主安装（推荐）

克隆仓库并运行幂等安装脚本，自动配置 CLI（`~/.local/bin/compact-handoff`）、统一配置（`~/.config/handoff/config.json`）、Skill 目录、OpenCode / Pi / omp 插件，以及 Claude Code / Gemini CLI / Copilot CLI / Antigravity Hooks：

```bash
git clone https://github.com/rheatin/compact-handoff.git
cd compact-handoff

# 预览所有变更，不写入磁盘
node scripts/install.mjs --dry-run

# 安装默认宿主（OpenCode, Pi, Claude Code）
node scripts/install.mjs

# 安装全部受支持宿主并自定义阈值
node scripts/install.mjs --hosts all --percentage 50

# 仅安装本机正在使用的宿主
node scripts/install.mjs --hosts omp,copilot,antigravity
```

#### 常用安装选项

```bash
node scripts/install.mjs [options]
  --hosts <list>          opencode,pi,claude,gemini,omp,copilot,antigravity 或 "all"（默认：opencode,pi,claude）
  --opencode-dir <dir>    指定 OpenCode 配置目录（默认：$OPENCODE_CONFIG_DIR 或 ~/.config/opencode）
  --mode <mode>           percentage | tokens | auto
  --percentage <1-100>    上下文比例触发阈值（默认：50）
  --tokens <N>            Token 数量触发阈值（默认：100000）
  --session-end <on|off>  会话结束时是否捕获 HANDOFF.md（默认：off）
  --subagent <on|off>     OpenCode 捕获是否启用 explore 子 Agent（默认：on）
  --link-handoff          额外创建 ~/.local/bin/handoff 软链接
  --copy                  复制文件而非创建软链接
  --dry-run               仅预览计划操作
  --uninstall             干净卸载链接与各宿主 Hook
```

---

## 统一配置 (`~/.config/handoff/config.json`)

四个宿主共享同一份配置（可通过 `HANDOFF_CONFIG_PATH` 覆盖路径）：

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

通过 `compact-handoff config` 更新触发器时，若存在 `${OPENCODE_CONFIG_DIR:-~/.config/opencode}/opencode.json`（或 `.jsonc`），会自动同步其中的 `compaction.trigger`。

---

## 常用 CLI 命令

```bash
compact-handoff status [dir]
compact-handoff init [dir]
compact-handoff capture [--trigger auto|manual|session-end] [--agent <name>] [--transcript <path>] [dir]
compact-handoff context [dir]
compact-handoff config --show
compact-handoff config [--mode percentage|tokens|auto] [--percentage 50] [--tokens 100000] [--session-end on|off] [--subagent on|off] [--auto-exclude on|off] [--model current]
compact-handoff install [--hosts opencode,pi,claude,gemini,omp,copilot,antigravity] [--dry-run] [--uninstall]
compact-handoff hook <claude|gemini|copilot|antigravity> <precompact|sessionstart|sessionend|preinvocation|stop>
```

---

## 标准 `HANDOFF.md` 结构

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

## 核心设计原则

1. **双模式支持（代码变更 + 纯设计/规划讨论）**：在 57 KB 联合证据预算内，当 45 KB Git Diff 满额时保留 12 KB 对话底线；当 `git diff` 为空（纯设计/规划/调研讨论）时，对话预算自动扩展至 **48 KB**，并通过用户意图优先蒸馏剥离超过 8 行的代码块、折叠冗长散文，完整保留初始目标、所有用户轮次、结论与 `## Open questions`。
2. **外科手术式 Markdown 更新**：`## Overview`、`## Commands` 及自定义 `##` 章节逐字节原样保留，仅刷新 `> Last updated`、`## Current status` 与 `## Open questions` 当前快照，并在 `## Decision log` 与 `## Gotchas / constraints` 中仅做去重追加。
3. **中英双语去重**：结合英文词元 Jaccard 相似度与 CJK 二元语法（bigram）分词，避免多次压缩后产生重复决策与重复踩坑记录。
4. **45 KB 公平 Diff 预算与密钥脱敏**：采用注水算法（water-filling）分配各文件 Diff 额度，防止单个大型生成文件挤占小文件上下文；自动跳过 `.env*`、密钥/证书文件并脱敏内联 Token。
5. **不污染 Git 工作区**：自动将 `HANDOFF.md` 与状态文件写入 `.git/info/exclude`（兼容 git worktree 的 `git-common-dir`），绝不修改受版本控制的 `.gitignore`。
6. **确定性降级与冷却退避**：当 LLM 调用失败、超时（15 秒）或处于 3 分钟冷却期时，`runStandaloneCapture` 会自动回退到基于 Git 状态与讨论主题/待确认问题的确定性提取，确保压缩流程永不阻塞。
7. **零运行时依赖**：纯 Node.js（`>= 18`）ESM 核心实现，无任何第三方 `npm` 运行时依赖。

---

## 测试

```bash
npm test
```

## 致谢与协议

- 灵感来自 [`AONG11a/handoff-md`](https://github.com/AONG11a/handoff-md)。
- 基于 [MIT License](LICENSE) 开源。
