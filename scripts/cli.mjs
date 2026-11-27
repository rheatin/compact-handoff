#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  computeGitSignal,
  distillTranscriptEntries,
  ensureHandoffFile,
  extractStartupContext,
  loadConfig,
  readCaptureState,
  resolveGitInfo,
  resolveStateFilePath,
  runStandaloneCapture,
  saveConfig,
} from "./handoff-core.mjs";
import { runInstallFromCli } from "./install.mjs";

function printHelp() {
  console.log(`compact-handoff — Cross-host HANDOFF.md manager

Usage:
  compact-handoff status [dir]
  compact-handoff init [dir]
  compact-handoff capture [--trigger <auto|manual|session-end>] [--agent <name>] [--transcript <path>] [dir]
  compact-handoff context [dir]
  compact-handoff config [--mode percentage|tokens|auto] [--percentage <1-100>] [--tokens <N>] [--session-end on|off] [--subagent on|off] [--auto-exclude on|off] [--model <name>] [--show]
  compact-handoff install [--hosts opencode,pi,claude,gemini,omp,copilot,antigravity] [--uninstall] [--dry-run] [--percentage <1-100>] [--tokens <N>]
  compact-handoff hook <claude|gemini|copilot|antigravity> <precompact|sessionstart|sessionend|preinvocation|stop>
`);
}

function parseBoolToggle(val, flagName) {
  const norm = String(val ?? "")
    .trim()
    .toLowerCase();
  if (norm === "on" || norm === "true" || norm === "1" || norm === "yes") {
    return true;
  }
  if (norm === "off" || norm === "false" || norm === "0" || norm === "no") {
    return false;
  }
  throw new Error(`Invalid value for ${flagName}: expected on|off, got "${val}"`);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (key === "show" || key === "help") {
          flags[key] = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          flags[key] = argv[++i];
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    positionals.push(arg);
  }

  return { flags, positionals };
}

const CLI_TRANSCRIPT_MAX_BYTES = 48 * 1024;

function extractTranscriptFromFile(transcriptPath, maxReadBytes = 256 * 1024) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  try {
    if (!fs.existsSync(transcriptPath)) return "";
    const st = fs.statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return "";

    const fd = fs.openSync(transcriptPath, "r");
    const startOffset = Math.max(0, st.size - maxReadBytes);
    const readLen = st.size - startOffset;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, startOffset);
    fs.closeSync(fd);

    let raw = buf.toString("utf8");
    if (startOffset > 0) {
      const firstNewline = raw.indexOf("\n");
      if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
    }

    const trimmed = raw.trim();
    if (!trimmed) return "";

    // Try JSON document (e.g. { messages: [...] })
    if (trimmed.startsWith("{") && trimmed.endsWith("}") && !trimmed.includes("\n{")) {
      try {
        const doc = JSON.parse(trimmed);
        if (Array.isArray(doc.messages)) {
          return distillTranscriptEntries(doc.messages, CLI_TRANSCRIPT_MAX_BYTES);
        }
      } catch {
        // fall through to JSONL parsing
      }
    }

    // Parse JSONL lines (Claude Code / Gemini CLI session logs)
    const entries = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        entries.push(JSON.parse(l));
      } catch {
        entries.push(l);
      }
    }
    return distillTranscriptEntries(entries, CLI_TRANSCRIPT_MAX_BYTES);
  } catch {
    return "";
  }
}

async function readStdinJson(timeoutMs = 1500) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        resolve({});
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function handleStatus(dirArg) {
  const targetDir = path.resolve(dirArg || process.cwd());
  const handoffPath = path.join(targetDir, "HANDOFF.md");
  const config = loadConfig();
  const gitInfo = resolveGitInfo(targetDir);
  const state = readCaptureState(targetDir);
  const currentSignal = computeGitSignal(targetDir);

  const handoffExists = fs.existsSync(handoffPath);
  let lastUpdated = "missing";
  if (handoffExists) {
    const content = fs.readFileSync(handoffPath, "utf8");
    const m = content.match(/^>[ \t]*Last updated:[ \t]*(.+)$/m);
    lastUpdated = m ? m[1].trim() : "unknown";
  }

  let excludeConfigured = false;
  if (gitInfo) {
    const excludePath = path.join(gitInfo.gitDir, "info", "exclude");
    if (fs.existsSync(excludePath)) {
      const ex = fs.readFileSync(excludePath, "utf8");
      excludeConfigured = ex.includes("HANDOFF.md");
    }
  }

  const report = {
    directory: targetDir,
    handoffFile: {
      path: handoffPath,
      exists: handoffExists,
      lastUpdated,
    },
    git: gitInfo
      ? {
          isGitRepo: true,
          gitDir: gitInfo.gitDir,
          excludeConfigured,
          signalChangedSinceCapture: state?.lastSignal
            ? state.lastSignal !== currentSignal
            : Boolean(currentSignal),
        }
      : { isGitRepo: false },
    state: state
      ? {
          path: resolveStateFilePath(targetDir),
          ...state,
        }
      : null,
    config,
  };

  console.log(JSON.stringify(report, null, 2));
}

function handleInit(dirArg) {
  const targetDir = path.resolve(dirArg || process.cwd());
  const res = ensureHandoffFile(targetDir);
  console.log(
    `${res.created ? "Initialized" : "Verified"} ${res.path}${
      res.exclude.updated
        ? ` (added ${res.exclude.added.join(", ")} to ${res.exclude.excludePath})`
        : res.exclude.excludePath
          ? ` (git exclude already configured at ${res.exclude.excludePath})`
          : ""
    }`,
  );
}

async function handleCapture(flags, dirArg) {
  const targetDir = path.resolve(dirArg || process.cwd());
  const trigger =
    typeof flags.trigger === "string" ? flags.trigger : "manual";
  if (!["auto", "manual", "session-end"].includes(trigger)) {
    throw new Error(
      `Invalid --trigger "${trigger}": expected auto|manual|session-end`,
    );
  }
  const agentName =
    typeof flags.agent === "string" && flags.agent.trim()
      ? flags.agent.trim()
      : "cli";
  const transcriptText =
    typeof flags.transcript === "string"
      ? extractTranscriptFromFile(path.resolve(flags.transcript))
      : "";

  const res = await runStandaloneCapture({
    cwd: targetDir,
    trigger,
    agentName,
    transcriptText,
  });

  console.log(
    JSON.stringify(
      {
        handoffPath: res.handoffPath,
        statePath: res.statePath,
        skipped: res.skipped,
        usedFallback: res.usedFallback,
        head: res.head,
      },
      null,
      2,
    ),
  );
}

function handleContext(dirArg) {
  const targetDir = path.resolve(dirArg || process.cwd());
  const ctx = extractStartupContext(targetDir);
  if (ctx) {
    process.stdout.write(ctx);
  }
}

function handleConfig(flags) {
  const hasMutations =
    flags.mode !== undefined ||
    flags.percentage !== undefined ||
    flags.tokens !== undefined ||
    flags["session-end"] !== undefined ||
    flags.subagent !== undefined ||
    flags["auto-exclude"] !== undefined ||
    flags.model !== undefined;

  if (!hasMutations) {
    const cfg = loadConfig();
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  const partial = {};
  const triggerPatch = {};

  if (flags.mode !== undefined) {
    const mode = String(flags.mode).trim();
    if (!["percentage", "tokens", "auto"].includes(mode)) {
      throw new Error(
        `Invalid --mode "${mode}": expected percentage|tokens|auto`,
      );
    }
    triggerPatch.mode = mode;
  }

  if (flags.percentage !== undefined) {
    const pct = Number(flags.percentage);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      throw new Error(
        `Invalid --percentage "${flags.percentage}": expected 1..100`,
      );
    }
    triggerPatch.percentage = Math.round(pct);
  }

  if (flags.tokens !== undefined) {
    const tok = Number(flags.tokens);
    if (!Number.isFinite(tok) || tok < 1) {
      throw new Error(
        `Invalid --tokens "${flags.tokens}": expected positive integer`,
      );
    }
    triggerPatch.tokens = Math.round(tok);
  }

  if (Object.keys(triggerPatch).length > 0) {
    partial.trigger = triggerPatch;
  }

  if (flags["session-end"] !== undefined) {
    partial.captureOnSessionEnd = parseBoolToggle(
      flags["session-end"],
      "--session-end",
    );
  }

  if (flags.subagent !== undefined) {
    partial.useSubagent = parseBoolToggle(flags.subagent, "--subagent");
  }

  if (flags["auto-exclude"] !== undefined) {
    partial.autoExcludeGit = parseBoolToggle(
      flags["auto-exclude"],
      "--auto-exclude",
    );
  }

  if (flags.model !== undefined && typeof flags.model === "string") {
    partial.model = flags.model.trim();
  }

  const updated = saveConfig(partial);
  console.log(JSON.stringify(updated, null, 2));
}

const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_048_576;

function resolveHookWorkspaceDir(payload) {
  const fromWorkspacePaths =
    Array.isArray(payload?.workspacePaths) &&
    typeof payload.workspacePaths[0] === "string" &&
    payload.workspacePaths[0].trim()
      ? payload.workspacePaths[0].trim()
      : null;

  return path.resolve(
    payload?.cwd ||
      fromWorkspacePaths ||
      payload?.workspacePath ||
      payload?.workspace_dir ||
      payload?.project_dir ||
      process.cwd(),
  );
}

function resolveHookTranscriptPath(payload, cwd, host) {
  const direct = payload?.transcriptPath || payload?.transcript_path || null;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  if (host === "gemini") {
    const candidates = [
      path.join(cwd, ".gemini", "transcript.jsonl"),
      path.join(cwd, ".gemini", "cli", "transcript.jsonl"),
    ];
    const convId =
      typeof payload?.conversationId === "string" && payload.conversationId.trim()
        ? payload.conversationId.trim()
        : typeof payload?.session_id === "string" && payload.session_id.trim()
          ? payload.session_id.trim()
          : null;
    if (convId) {
      candidates.push(
        path.join(os.homedir(), ".gemini", "conversations", `${convId}.jsonl`),
        path.join(os.homedir(), ".gemini", "conversations", `${convId}.json`),
      );
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore inaccessible candidate
      }
    }
  }

  return null;
}

function extractInlinePayloadTranscript(payload) {
  if (typeof payload?.transcript === "string" && payload.transcript.trim()) {
    const raw = payload.transcript.trim();
    if (/^\[[a-z0-9_-]+\]:/im.test(raw)) {
      const entries = raw
        .split(/\n\n(?=\[[a-z0-9_-]+\]:)/i)
        .map((chunk) => {
          const m = chunk.match(/^\[([a-z0-9_-]+)\]:\s*([\s\S]*)$/i);
          return m ? { role: m[1].toLowerCase(), content: m[2].trim() } : chunk;
        });
      return distillTranscriptEntries(entries, CLI_TRANSCRIPT_MAX_BYTES);
    }
    return distillTranscriptEntries([raw], CLI_TRANSCRIPT_MAX_BYTES);
  }
  if (Array.isArray(payload?.messages)) {
    return distillTranscriptEntries(payload.messages, CLI_TRANSCRIPT_MAX_BYTES);
  }
  return "";
}

function extractTokensFromTranscriptTail(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const st = fs.statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return 0;

    const maxTail = 64 * 1024;
    const fd = fs.openSync(transcriptPath, "r");
    const startOffset = Math.max(0, st.size - maxTail);
    const readLen = st.size - startOffset;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, startOffset);
    fs.closeSync(fd);

    const lines = buf
      .toString("utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const usage = entry?.usage || entry?.usageMetadata || entry?.contextUsage;
        const reported =
          usage?.totalTokens ??
          usage?.totalTokenCount ??
          usage?.promptTokenCount ??
          usage?.inputTokens ??
          usage?.tokens ??
          entry?.totalTokens ??
          entry?.tokens;
        if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
          return reported;
        }
      } catch {
        // ignore non-JSON line
      }
    }

    return Math.ceil(st.size / 4);
  } catch {
    return null;
  }
}

function doesGeminiMeetThreshold(payload, transcriptPath, transcriptText, config) {
  if (payload?.terminationReason === "MAX_TOKEN_BUDGET_EXCEEDED") {
    return true;
  }

  const contextUsage =
    (payload?.contextUsage && typeof payload.contextUsage === "object"
      ? payload.contextUsage
      : null) ||
    (payload?.usage && typeof payload.usage === "object" ? payload.usage : null);

  const rawWindow =
    contextUsage?.contextWindow ??
    payload?.contextWindow ??
    payload?.context_window ??
    payload?.maxContextTokens ??
    DEFAULT_GEMINI_CONTEXT_WINDOW;
  const contextWindow =
    typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0
      ? rawWindow
      : DEFAULT_GEMINI_CONTEXT_WINDOW;

  const explicitPercent =
    contextUsage?.percent ?? payload?.percent ?? payload?.contextPercent ?? null;

  const explicitTokens =
    contextUsage?.tokens ??
    contextUsage?.totalTokens ??
    contextUsage?.promptTokenCount ??
    contextUsage?.inputTokens ??
    payload?.tokens ??
    payload?.totalTokens ??
    payload?.inputTokens ??
    null;

  let estimatedTokens =
    typeof explicitTokens === "number" && Number.isFinite(explicitTokens)
      ? explicitTokens
      : extractTokensFromTranscriptTail(transcriptPath);

  if (estimatedTokens === null && transcriptText) {
    estimatedTokens = Math.ceil(Buffer.byteLength(transcriptText, "utf8") / 4);
  }

  if (config?.trigger?.mode === "tokens") {
    return (
      typeof estimatedTokens === "number" &&
      Number.isFinite(estimatedTokens) &&
      estimatedTokens >= config.trigger.tokens
    );
  }

  if (config?.trigger?.mode === "percentage") {
    const pct =
      typeof explicitPercent === "number" && Number.isFinite(explicitPercent)
        ? explicitPercent
        : typeof estimatedTokens === "number" &&
            Number.isFinite(estimatedTokens) &&
            contextWindow > 0
          ? (estimatedTokens / contextWindow) * 100
          : null;
    return pct !== null && pct >= config.trigger.percentage;
  }

  return false;
}

const HOOK_HOSTS = new Set(["claude", "gemini", "copilot", "antigravity"]);
const HOOK_AGENT_NAMES = {
  claude: "claude-code",
  gemini: "gemini-cli",
  copilot: "copilot-cli",
  antigravity: "antigravity",
};

// Antigravity fires PreInvocation before every model call and Copilot can fire
// preCompact repeatedly. Keep threshold-driven captures from rewriting the same
// HANDOFF.md on every hook tick.
const THRESHOLD_CAPTURE_COOLDOWN_MS = 120_000;

function recentThresholdCapture(cwd) {
  const state = readCaptureState(cwd);
  if (!state?.lastCapturedAt) return false;
  const capturedAt = Date.parse(state.lastCapturedAt);
  return (
    Number.isFinite(capturedAt) &&
    Date.now() - capturedAt < THRESHOLD_CAPTURE_COOLDOWN_MS
  );
}

function formatSessionStartOutput(host, context) {
  if (!context) return {};
  if (host === "copilot") {
    return { additionalContext: context };
  }
  if (host === "antigravity") {
    return {
      injectSteps: [{ systemMessage: { systemMessage: context } }],
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
}

async function handleHook(hostRaw, eventRaw) {
  try {
    if (process.env.HANDOFF_CAPTURE_ACTIVE === "1") {
      process.stdout.write("{}\n");
      process.exit(0);
    }

    const host = String(hostRaw || "")
      .trim()
      .toLowerCase();
    const event = String(eventRaw || "")
      .trim()
      .toLowerCase();

    if (!HOOK_HOSTS.has(host)) {
      process.stdout.write("{}\n");
      process.exit(0);
    }

    const payload = await readStdinJson();
    const cwd = resolveHookWorkspaceDir(payload);
    const agentName = HOOK_AGENT_NAMES[host];
    const transcriptPath = resolveHookTranscriptPath(payload, cwd, host);

    if (event === "sessionstart") {
      const ctx = extractStartupContext(cwd);
      process.stdout.write(
        `${JSON.stringify(formatSessionStartOutput(host, ctx))}\n`,
      );
      process.exit(0);
    }

    if (event === "precompact") {
      if (host === "antigravity") {
        process.stdout.write("{}\n");
        process.exit(0);
      }

      const transcriptText =
        extractTranscriptFromFile(transcriptPath) ||
        extractInlinePayloadTranscript(payload);
      const trigger = payload?.trigger === "manual" ? "manual" : "auto";
      await runStandaloneCapture({
        cwd,
        trigger,
        agentName,
        transcriptText,
      });

      if (host === "copilot") {
        process.stdout.write("{}\n");
        process.exit(0);
      }

      const ctx = extractStartupContext(cwd);
      const out = {
        continue: true,
        suppressOutput: true,
        ...(ctx
          ? { systemMessage: "HANDOFF.md updated prior to compaction." }
          : {}),
      };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(0);
    }

    if (event === "preinvocation") {
      if (host !== "antigravity") {
        process.stdout.write("{}\n");
        process.exit(0);
      }

      const config = loadConfig();
      const transcriptText =
        extractTranscriptFromFile(transcriptPath) ||
        extractInlinePayloadTranscript(payload);
      const thresholdMet = doesGeminiMeetThreshold(
        payload,
        transcriptPath,
        transcriptText,
        config,
      );

      if (thresholdMet && !recentThresholdCapture(cwd)) {
        await runStandaloneCapture({
          cwd,
          trigger: "auto",
          agentName,
          transcriptText,
          config,
        });
      }
      process.stdout.write("{}\n");
      process.exit(0);
    }

    if (event === "sessionend" || event === "stop") {
      if (payload.stop_hook_active || payload.stopHookActive) {
        process.stdout.write("{}\n");
        process.exit(0);
      }

      const config = loadConfig();
      const transcriptText =
        extractTranscriptFromFile(transcriptPath) ||
        extractInlinePayloadTranscript(payload);
      const thresholdHost =
        (host === "gemini" || host === "antigravity") && event === "stop";

      if (thresholdHost) {
        const thresholdMet = doesGeminiMeetThreshold(
          payload,
          transcriptPath,
          transcriptText,
          config,
        );
        if (!thresholdMet && !config.captureOnSessionEnd) {
          process.stdout.write("{}\n");
          process.exit(0);
        }

        if (!thresholdMet || !recentThresholdCapture(cwd)) {
          await runStandaloneCapture({
            cwd,
            trigger: thresholdMet ? "auto" : "session-end",
            agentName,
            transcriptText,
            skipIfUnchanged: !thresholdMet,
            config,
          });
        }
        process.stdout.write(
          `${JSON.stringify(
            host === "gemini"
              ? { continue: true, suppressOutput: true }
              : {},
          )}\n`,
        );
        process.exit(0);
      }

      if (!config.captureOnSessionEnd) {
        process.stdout.write("{}\n");
        process.exit(0);
      }
      await runStandaloneCapture({
        cwd,
        trigger: "session-end",
        agentName,
        transcriptText,
        skipIfUnchanged: true,
        config,
      });
      process.stdout.write(
        `${JSON.stringify(
          host === "copilot" ? {} : { continue: true, suppressOutput: true },
        )}\n`,
      );
      process.exit(0);
    }

    process.stdout.write("{}\n");
    process.exit(0);
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const subcommand = rawArgs[0];

  if (subcommand === "hook") {
    await handleHook(rawArgs[1], rawArgs[2]);
    return;
  }

  if (subcommand === "install") {
    await runInstallFromCli(rawArgs.slice(1));
    return;
  }

  const { flags, positionals } = parseArgs(rawArgs);
  if (flags.help || !subcommand) {
    printHelp();
    process.exit(0);
  }

  const cmd = positionals[0];
  const rest = positionals.slice(1);

  switch (cmd) {
    case "status":
      handleStatus(rest[0]);
      break;
    case "init":
      handleInit(rest[0]);
      break;
    case "capture":
      await handleCapture(flags, rest[0]);
      break;
    case "context":
      handleContext(rest[0]);
      break;
    case "config":
      handleConfig(flags);
      break;
    default:
      throw new Error(
        `Unknown subcommand "${cmd}". Run "compact-handoff --help" for usage (config at ${DEFAULT_CONFIG_PATH}).`,
      );
  }
}

main().catch((err) => {
  console.error(`compact-handoff error: ${err?.message || err}`);
  process.exit(1);
});
