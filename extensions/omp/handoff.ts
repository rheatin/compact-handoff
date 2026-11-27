// Pre-compaction HANDOFF.md integration for Oh My Pi (omp).
//
// omp loads this module through its Pi-compatible extension layer:
// - startup injection via `before_agent_start`
// - proactive compaction via `ctx.getContextUsage()` + `ctx.compact()`
// - HANDOFF.md capture in `session_before_compact` / `session_shutdown`
// - HANDOFF.md summarizer context via `session.compacting`
//
// `session_before_compact` is intentionally not replaced: omp already has a
// first-class `handoff` compaction method (`/handoff`). This extension keeps the
// cross-host `HANDOFF.md` file authoritative, while omp keeps ownership of its
// compaction entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

const STARTUP_MARKER = "[Handoff Context from HANDOFF.md]";

type JsonObject = Record<string, unknown>;

interface HandoffTrigger {
  mode?: string;
  percentage?: number;
  tokens?: number;
}

interface HandoffConfig {
  captureOnSessionEnd?: boolean;
  trigger?: HandoffTrigger;
}

interface HandoffCore {
  loadConfig: () => HandoffConfig;
  extractStartupContext: (cwd: string) => string | null;
  runStandaloneCapture: (options: JsonObject) => Promise<unknown>;
}

let cachedCorePromise: Promise<HandoffCore> | null = null;

function asRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

export function resolveHandoffCorePath(): string {
  const candidates: string[] = [];
  if (process.env.HANDOFF_CORE_PATH) {
    candidates.push(path.resolve(process.env.HANDOFF_CORE_PATH));
  }

  const selfFile = fileURLToPath(import.meta.url);
  candidates.push(
    path.resolve(path.dirname(selfFile), "../../scripts/handoff-core.mjs"),
  );
  try {
    const realSelf = fs.realpathSync(selfFile);
    if (realSelf !== selfFile) {
      candidates.push(
        path.resolve(path.dirname(realSelf), "../../scripts/handoff-core.mjs"),
      );
    }
  } catch {
    // ignore realpath error
  }

  const home = os.homedir();
  candidates.push(
    path.join(
      home,
      ".omp",
      "agent",
      "skills",
      "compact-handoff",
      "scripts",
      "handoff-core.mjs",
    ),
    path.join(
      home,
      ".agents",
      "skills",
      "compact-handoff",
      "scripts",
      "handoff-core.mjs",
    ),
    path.join(
      home,
      ".config",
      "opencode",
      "skills",
      "compact-handoff",
      "scripts",
      "handoff-core.mjs",
    ),
    path.join(
      home,
      ".claude",
      "skills",
      "compact-handoff",
      "scripts",
      "handoff-core.mjs",
    ),
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate handoff-core.mjs (checked: ${candidates.join(", ")})`,
  );
}

async function getCore(): Promise<HandoffCore> {
  if (!cachedCorePromise) {
    const corePath = resolveHandoffCorePath();
    cachedCorePromise = import(pathToFileURL(corePath).href).then((mod) => {
      const exports = asRecord(mod) ?? {};
      const loadConfig = exports.loadConfig;
      const extractStartupContext = exports.extractStartupContext;
      const runStandaloneCapture = exports.runStandaloneCapture;
      if (
        !isFunction(loadConfig) ||
        !isFunction(extractStartupContext) ||
        !isFunction(runStandaloneCapture)
      ) {
        throw new Error(`handoff-core.mjs is missing expected exports: ${corePath}`);
      }
      return {
        loadConfig: () => loadConfig() as HandoffConfig,
        extractStartupContext: (cwd: string) => {
          const value = extractStartupContext(cwd);
          return typeof value === "string" ? value : null;
        },
        runStandaloneCapture: (options: JsonObject) =>
          runStandaloneCapture(options) as Promise<unknown>,
      };
    });
  }
  return cachedCorePromise;
}

function isSubagent(ctx: ExtensionContext | undefined): boolean {
  if (process.env.HANDOFF_CAPTURE_ACTIVE === "1") return true;
  if (process.env.PI_SUBAGENT_CHILD === "1") return true;
  return ctx?.agent?.kind === "sub";
}

function computeUsagePercentage(usage: unknown): number | null {
  const record = asRecord(usage);
  if (!record) return null;
  const percent = record.percent;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    return percent;
  }
  const tokens = record.tokens;
  const contextWindow = record.contextWindow;
  if (
    typeof tokens === "number" &&
    Number.isFinite(tokens) &&
    typeof contextWindow === "number" &&
    contextWindow > 0
  ) {
    return (tokens / contextWindow) * 100;
  }
  return null;
}

export function shouldTriggerCompaction(
  usage: unknown,
  config: HandoffConfig,
): boolean {
  const record = asRecord(usage);
  if (!record) return false;
  const mode = config.trigger?.mode;

  if (mode === "percentage") {
    const pct = computeUsagePercentage(record);
    return pct !== null && pct >= (config.trigger?.percentage ?? 50);
  }

  if (mode === "tokens") {
    const tokens = record.tokens;
    return (
      typeof tokens === "number" &&
      Number.isFinite(tokens) &&
      tokens >= (config.trigger?.tokens ?? 100000)
    );
  }

  return false;
}

export function shouldTriggerEmergencyCompaction(
  usage: unknown,
  config: HandoffConfig,
): boolean {
  const record = asRecord(usage);
  if (!record) return false;
  const mode = config.trigger?.mode;
  const pct = computeUsagePercentage(record);

  if (mode === "tokens") {
    const tokens = record.tokens;
    const emergencyTokens = Math.ceil((config.trigger?.tokens ?? 100000) * 1.4);
    const overTokenCap =
      typeof tokens === "number" &&
      Number.isFinite(tokens) &&
      tokens >= emergencyTokens;
    const overPctCap = pct !== null && pct >= 85;
    return overTokenCap || overPctCap;
  }

  const emergencyPct = Math.min(
    98,
    Math.max(85, config.trigger?.percentage ?? 60),
  );
  return pct !== null && pct >= emergencyPct;
}

function createOmpLlmRunner(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): ((prompt: string) => Promise<string>) | undefined {
  const runEphemeralTurn = ctx.runEphemeralTurn;
  if (typeof runEphemeralTurn !== "function") return undefined;

  return async (prompt: string): Promise<string> => {
    const prevCaptureEnv = process.env.HANDOFF_CAPTURE_ACTIVE;
    process.env.HANDOFF_CAPTURE_ACTIVE = "1";
    try {
      const result = await runEphemeralTurn.call(ctx, {
        promptText: prompt,
        tools: false,
        ...(signal ? { signal } : {}),
      });
      const text = String(result?.replyText ?? "").trim();
      if (!text) {
        throw new Error("Empty LLM output from omp side turn");
      }
      return text;
    } finally {
      if (prevCaptureEnv === undefined) {
        delete process.env.HANDOFF_CAPTURE_ACTIVE;
      } else {
        process.env.HANDOFF_CAPTURE_ACTIVE = prevCaptureEnv;
      }
    }
  };
}

function sessionEntries(ctx: ExtensionContext): unknown[] {
  const sessionManager = ctx.sessionManager;
  try {
    if (typeof sessionManager?.getBranch === "function") {
      const branch = sessionManager.getBranch();
      if (Array.isArray(branch)) return branch;
    }
    if (typeof sessionManager?.getEntries === "function") {
      const entries = sessionManager.getEntries();
      if (Array.isArray(entries)) return entries;
    }
  } catch {
    // ignore session manager errors
  }
  return [];
}

function eventReason(event: unknown): string {
  const record = asRecord(event);
  const reason = record?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : "auto";
}

function eventSignal(event: unknown): AbortSignal | undefined {
  const record = asRecord(event);
  const signal = record?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export default function (pi: ExtensionAPI): void {
  let startupContextInjected = false;
  let compactionCooldown = false;
  let compactionInProgress = false;

  const resetSessionState = () => {
    startupContextInjected = false;
    compactionCooldown = false;
    compactionInProgress = false;
  };

  pi.on("session_start", () => {
    resetSessionState();
  });

  pi.on("session_switch", () => {
    resetSessionState();
  });

  pi.on("session_clear", () => {
    startupContextInjected = false;
  });

  pi.on("turn_start", () => {
    if (!compactionInProgress) {
      compactionCooldown = false;
    }
  });

  // 1. Startup context injection on the first turn of a session.
  pi.on(
    "before_agent_start",
    async (
      _event: BeforeAgentStartEvent,
      ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | void> => {
      if (isSubagent(ctx)) return;

      if (!compactionInProgress) {
        compactionCooldown = false;
      }

      if (startupContextInjected) return;
      startupContextInjected = true;

      const core = await getCore();
      const targetDir = path.resolve(ctx.cwd || process.cwd());
      const startupContext = core.extractStartupContext(targetDir);
      if (!startupContext || !startupContext.trim()) {
        return;
      }

      return {
        message: {
          customType: "handoff-context",
          content: `${STARTUP_MARKER}\n\n${startupContext.trim()}`,
          display: false,
        },
      };
    },
  );

  // 2. Proactive threshold check (turn-boundary deferral + 85% emergency cap).
  const checkThresholdAndCompact = async (
    _event: unknown,
    ctx: ExtensionContext,
  ) => {
    if (isSubagent(ctx)) return;
    if (compactionCooldown || compactionInProgress) return;

    const core = await getCore();
    const config = core.loadConfig();
    const usage = ctx.getContextUsage();
    if (!shouldTriggerCompaction(usage, config)) {
      return;
    }

    compactionCooldown = true;
    await ctx.compact();
  };

  const checkEmergencyThresholdAndCompact = async (
    _event: unknown,
    ctx: ExtensionContext,
  ) => {
    if (isSubagent(ctx)) return;
    if (compactionCooldown || compactionInProgress) return;

    const core = await getCore();
    const config = core.loadConfig();
    const usage = ctx.getContextUsage();
    if (!shouldTriggerEmergencyCompaction(usage, config)) {
      return;
    }

    compactionCooldown = true;
    await ctx.compact();
  };

  pi.on("turn_end", checkEmergencyThresholdAndCompact);
  pi.on("agent_end", checkThresholdAndCompact);

  // 3. Capture HANDOFF.md before omp compacts, then feed it to the summarizer.
  pi.on("session_before_compact", async (event, ctx) => {
    if (isSubagent(ctx)) return;

    compactionInProgress = true;
    compactionCooldown = true;

    try {
      const core = await getCore();
      const targetDir = path.resolve(ctx.cwd || process.cwd());
      const config = core.loadConfig();
      const llmRunner = createOmpLlmRunner(ctx, eventSignal(event));

      await core.runStandaloneCapture({
        cwd: targetDir,
        trigger: eventReason(event),
        agentName: "omp",
        transcriptEntries: sessionEntries(ctx),
        llmRunner,
        config,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[handoff] omp session_before_compact capture failed; continuing with omp compaction: ${detail}`,
      );
    } finally {
      compactionInProgress = false;
    }
  });

  // 4. Add the bounded HANDOFF.md window to omp's summarizer context.
  pi.on("session.compacting", async (_event, ctx) => {
    if (isSubagent(ctx)) return;

    try {
      const core = await getCore();
      const targetDir = path.resolve(ctx.cwd || process.cwd());
      const startupContext = core.extractStartupContext(targetDir);
      if (!startupContext || !startupContext.trim()) return;
      return { context: [startupContext.trim()] };
    } catch {
      return;
    }
  });

  // 5. Optional session_shutdown capture.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (isSubagent(ctx)) return;

    try {
      const core = await getCore();
      const config = core.loadConfig();
      if (!config.captureOnSessionEnd) {
        return;
      }

      const targetDir = path.resolve(ctx.cwd || process.cwd());
      await core.runStandaloneCapture({
        cwd: targetDir,
        trigger: "session-end",
        agentName: "omp",
        transcriptEntries: sessionEntries(ctx),
        llmRunner: createOmpLlmRunner(ctx),
        config,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[handoff] omp session_shutdown capture failed: ${detail}`);
    }
  });
}
