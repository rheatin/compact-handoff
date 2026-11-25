import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@mariozechner/pi-coding-agent";

const TRANSCRIPT_HEAD_BUDGET_BYTES = 12 * 1024;
const PER_MESSAGE_TEXT_MAX_BYTES = 3 * 1024;
const FIRST_GOAL_MAX_BYTES = 2 * 1024;
const STARTUP_MARKER = "[Handoff Context from HANDOFF.md]";

const PATH_KEYS = new Set([
  "filePath",
  "file_path",
  "path",
  "target_file",
  "targetFile",
  "notebook_path",
  "destination",
]);

let cachedCorePromise: Promise<any> | null = null;
let cachedCore: any = null;

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
  const openCodeDir =
    process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode");
  candidates.push(
    path.join(
      home,
      ".agents",
      "skills",
      "compact-handoff",
      "scripts",
      "handoff-core.mjs",
    ),
    path.join(
      openCodeDir,
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

function getCore(): Promise<any> {
  if (!cachedCorePromise) {
    const corePath = resolveHandoffCorePath();
    cachedCorePromise = import(pathToFileURL(corePath).href).then((mod) => {
      cachedCore = mod;
      return mod;
    });
  }
  return cachedCorePromise;
}

function redactInlineSecrets(text: string): string {
  if (!text) return "";
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]")
    .replace(
      /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}\b/gi,
      "$1[REDACTED_TOKEN]",
    )
    .replace(
      /\b((?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?)[^\s'",;]{8,}(['"]?)/gi,
      "$1[REDACTED]$2",
    );
}

function isChildOrRecursiveCapture(): boolean {
  return (
    process.env.HANDOFF_CAPTURE_ACTIVE === "1" ||
    process.env.PI_SUBAGENT_CHILD === "1"
  );
}

export function truncateUtf8Bytes(
  text: string,
  maxBytes: number,
  suffix = "\n... [truncated]",
): string {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const target = Math.max(0, maxBytes - suffixBytes);
  if (target === 0) return suffix.slice(0, maxBytes);

  let buf = Buffer.from(text, "utf8").subarray(0, target);
  while (buf.length > 0 && (buf[buf.length - 1] & 0b11000000) === 0b10000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  if (buf.length > 0 && buf[buf.length - 1] >= 0b11000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  return `${buf.toString("utf8")}${suffix}`;
}

function collectTouchedPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (!value || depth > 3 || out.size >= 24) return;
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectTouchedPaths(item, out, depth + 1);
      }
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (PATH_KEYS.has(key) && typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed && !/^https?:\/\//i.test(trimmed)) {
          out.add(trimmed);
        }
      } else if ((key === "files" || key === "paths") && Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === "string" && entry.trim()) {
            out.add(entry.trim());
          } else {
            collectTouchedPaths(entry, out, depth + 1);
          }
        }
      } else if (val && typeof val === "object") {
        collectTouchedPaths(val, out, depth + 1);
      }
    }
  }
}

function formatTranscriptEntry(rawEntry: any): string | null {
  if (!rawEntry || typeof rawEntry !== "object") return null;

  const entry =
    rawEntry.type === "message" &&
    rawEntry.message &&
    typeof rawEntry.message === "object"
      ? rawEntry.message
      : rawEntry;

  if (
    entry.customType === "handoff-context" ||
    rawEntry.customType === "handoff-context"
  ) {
    return null;
  }

  const rawType = String(rawEntry.type ?? "").toLowerCase();
  if (
    rawType &&
    rawType !== "message" &&
    rawType !== "custom_message" &&
    !entry.role
  ) {
    return null;
  }

  const role = String(
    entry.role ?? (rawType === "custom_message" ? "custom" : "message"),
  )
    .trim()
    .toLowerCase();

  if (role === "system") return null;
  if (role === "toolresult" && !entry.isError) return null;

  const textChunks: string[] = [];
  const touchedPaths = new Set<string>();

  const blocks = Array.isArray(entry.content)
    ? entry.content
    : Array.isArray(entry.parts)
      ? entry.parts
      : null;

  if (blocks) {
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block === "string") {
        const trimmed = block.trim();
        if (trimmed && !trimmed.startsWith(STARTUP_MARKER)) {
          textChunks.push(trimmed);
        }
        continue;
      }
      if (typeof block !== "object") continue;

      const bType = String(block.type ?? "").toLowerCase();
      if (bType === "text" || (!bType && typeof block.text === "string")) {
        const txt = typeof block.text === "string" ? block.text.trim() : "";
        if (txt && !txt.startsWith(STARTUP_MARKER)) {
          textChunks.push(txt);
        }
        continue;
      }

      if (
        bType === "toolcall" ||
        bType === "tool_call" ||
        bType === "tool-call" ||
        bType === "tool_use" ||
        bType === "tool" ||
        bType === "tool-invocation"
      ) {
        collectTouchedPaths(block.arguments, touchedPaths);
        collectTouchedPaths(block.args, touchedPaths);
        collectTouchedPaths(block.input, touchedPaths);
        collectTouchedPaths(block.state?.input, touchedPaths);
      }
    }
  } else {
    const rawText =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.text === "string"
          ? entry.text
          : "";
    const trimmed = rawText.trim();
    if (trimmed && !trimmed.startsWith(STARTUP_MARKER)) {
      textChunks.push(trimmed);
    }
  }

  if (Array.isArray(entry.toolCalls)) {
    collectTouchedPaths(entry.toolCalls, touchedPaths);
  }

  const bodyText = truncateUtf8Bytes(
    redactInlineSecrets(textChunks.join("\n").trim()),
    PER_MESSAGE_TEXT_MAX_BYTES,
  );
  const filesNote =
    touchedPaths.size > 0
      ? `[files touched: ${[...touchedPaths].join(", ")}]`
      : "";

  if (!bodyText && !filesNote) return null;
  const combined = [bodyText, filesNote].filter(Boolean).join("\n");
  return `[${role}]: ${combined}`;
}

export function extractBoundedTranscript(
  entries: unknown,
  maxBytes = TRANSCRIPT_HEAD_BUDGET_BYTES,
): string {
  if (!Array.isArray(entries) || entries.length === 0 || maxBytes <= 0) {
    return "";
  }
  if (typeof cachedCore?.distillTranscriptEntries === "function") {
    return cachedCore.distillTranscriptEntries(entries, maxBytes);
  }

  const formatted: string[] = [];
  for (const item of entries) {
    const line = formatTranscriptEntry(item);
    if (line) formatted.push(line);
  }
  if (formatted.length === 0) return "";

  const full = formatted.join("\n\n");
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }

  const firstUserIdx = formatted.findIndex((m) => m.startsWith("[user]:"));
  const pinnedFirst =
    firstUserIdx === 0
      ? truncateUtf8Bytes(
          formatted[0],
          Math.min(FIRST_GOAL_MAX_BYTES, Math.floor(maxBytes / 3)),
        )
      : "";
  const marker = "... [earlier messages omitted]";
  const reservedBytes = pinnedFirst
    ? Buffer.byteLength(pinnedFirst, "utf8") +
      Buffer.byteLength(marker, "utf8") +
      4
    : 0;
  let tailBudget = Math.max(0, maxBytes - reservedBytes);

  const tailReversed: string[] = [];
  const stopIdx = pinnedFirst ? 1 : 0;
  for (let i = formatted.length - 1; i >= stopIdx; i--) {
    const candidate = formatted[i];
    const sep = tailReversed.length > 0 ? 2 : 0;
    const bytes = Buffer.byteLength(candidate, "utf8") + sep;
    if (bytes <= tailBudget) {
      tailReversed.push(candidate);
      tailBudget -= bytes;
    } else if (tailReversed.length === 0) {
      tailReversed.push(truncateUtf8Bytes(candidate, tailBudget));
      break;
    } else {
      break;
    }
  }

  const tail = tailReversed.reverse();
  const assembled = pinnedFirst
    ? [pinnedFirst, marker, ...tail].join("\n\n")
    : tail.join("\n\n");
  return truncateUtf8Bytes(assembled, maxBytes);
}

async function loadCompleteSimple(): Promise<
  ((model: any, context: any, options?: any) => Promise<any>) | null
> {
  const moduleCandidates = [
    "@mariozechner/pi-ai/compat",
    "@mariozechner/pi-ai",
  ];
  if (process.env.PI_AI_COMPAT_PATH) {
    moduleCandidates.push(
      pathToFileURL(path.resolve(process.env.PI_AI_COMPAT_PATH)).href,
    );
  }

  for (const specifier of moduleCandidates) {
    try {
      const mod: any = await import(specifier);
      if (typeof mod?.completeSimple === "function") {
        return mod.completeSimple;
      }
    } catch {
      // Try next candidate
    }
  }

  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@mariozechner/pi-ai/compat");
    const mod: any = await import(pathToFileURL(resolved).href);
    if (typeof mod?.completeSimple === "function") {
      return mod.completeSimple;
    }
  } catch {
    // Package not resolvable from extension location
  }

  return null;
}

function extractAssistantText(response: any): string {
  if (!response) return "";
  if (typeof response === "string") return response.trim();
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "Pi model completion failed");
  }
  if (Array.isArray(response.content)) {
    return response.content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }
  if (typeof response.text === "string") {
    return response.text.trim();
  }
  return "";
}

function resolveCaptureModel(ctx: ExtensionContext, config: any): any {
  const currentModel = ctx?.model;
  if (
    config?.model &&
    typeof config.model === "string" &&
    config.model !== "current" &&
    typeof ctx?.modelRegistry?.find === "function"
  ) {
    const trimmed = config.model.trim();
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
      const found = ctx.modelRegistry.find(
        trimmed.slice(0, slashIdx),
        trimmed.slice(slashIdx + 1),
      );
      if (found) return found;
    }
  }
  return currentModel;
}

function createPiLlmRunner(
  ctx: ExtensionContext,
  config: any,
  signal?: AbortSignal,
): ((prompt: string) => Promise<string>) | undefined {
  const activeModel = resolveCaptureModel(ctx, config);
  if (!activeModel) {
    return undefined;
  }

  return async (prompt: string): Promise<string> => {
    const prevCaptureEnv = process.env.HANDOFF_CAPTURE_ACTIVE;
    process.env.HANDOFF_CAPTURE_ACTIVE = "1";

    try {
      const registry: any = ctx?.modelRegistry;
      let apiKey: string | undefined;
      let headers: Record<string, string> | undefined;
      let env: Record<string, string> | undefined;

      if (typeof registry?.getApiKey === "function") {
        apiKey = await registry.getApiKey(activeModel);
      } else if (typeof registry?.getApiKeyAndHeaders === "function") {
        const resolved = await registry.getApiKeyAndHeaders(activeModel);
        if (resolved?.ok) {
          apiKey = resolved.apiKey;
          headers = resolved.headers;
          env = resolved.env;
        }
      } else if (
        typeof registry?.getApiKeyForProvider === "function" &&
        activeModel.provider
      ) {
        apiKey = await registry.getApiKeyForProvider(activeModel.provider);
      }

      const llmContext = {
        systemPrompt:
          "You are a JSON state extractor for HANDOFF.md. Return ONLY a single valid JSON object matching the requested schema, with no markdown code fences and no extra commentary.",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: prompt }],
            timestamp: Date.now(),
          },
        ],
      };

      const requestOptions: Record<string, unknown> = {
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        ...(env ? { env } : {}),
        ...(signal ? { signal } : {}),
      };

      let response: any;
      if (typeof registry?.completeSimple === "function") {
        response = await registry.completeSimple(
          activeModel,
          llmContext,
          requestOptions,
        );
      } else if (typeof registry?.streamSimple === "function") {
        const stream = registry.streamSimple(
          activeModel,
          llmContext,
          requestOptions,
        );
        response =
          typeof stream?.result === "function"
            ? await stream.result()
            : await stream;
      } else {
        const completeSimple = await loadCompleteSimple();
        if (!completeSimple) {
          throw new Error("@mariozechner/pi-ai completeSimple unavailable");
        }
        response = await completeSimple(activeModel, llmContext, requestOptions);
      }

      const text = extractAssistantText(response);
      if (!text) {
        throw new Error("Empty LLM output from Pi active model");
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

function computeUsagePercentage(usage: any): number | null {
  if (!usage || typeof usage !== "object") return null;
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
    return usage.percent;
  }
  if (
    typeof usage.tokens === "number" &&
    Number.isFinite(usage.tokens) &&
    typeof usage.contextWindow === "number" &&
    usage.contextWindow > 0
  ) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return null;
}

function shouldTriggerCompaction(usage: any, config: any): boolean {
  if (!usage || typeof usage !== "object") return false;
  const mode = config?.trigger?.mode;

  if (mode === "percentage") {
    const pct = computeUsagePercentage(usage);
    return pct !== null && pct >= config.trigger.percentage;
  }

  if (mode === "tokens") {
    return (
      typeof usage.tokens === "number" &&
      Number.isFinite(usage.tokens) &&
      usage.tokens >= config.trigger.tokens
    );
  }

  return false;
}

function shouldTriggerEmergencyCompaction(usage: any, config: any): boolean {
  if (!usage || typeof usage !== "object") return false;
  const mode = config?.trigger?.mode;
  const pct = computeUsagePercentage(usage);

  if (mode === "tokens") {
    const emergencyTokens = Math.ceil((config.trigger.tokens ?? 100000) * 1.4);
    const overTokenCap =
      typeof usage.tokens === "number" &&
      Number.isFinite(usage.tokens) &&
      usage.tokens >= emergencyTokens;
    const overPctCap = pct !== null && pct >= 85;
    return overTokenCap || overPctCap;
  }

  const emergencyPct = Math.min(
    98,
    Math.max(85, config?.trigger?.percentage ?? 60),
  );
  return pct !== null && pct >= emergencyPct;
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

  // Compatibility with any host/version emitting session_switch
  (pi as any).on("session_switch", () => {
    resetSessionState();
  });

  pi.on("turn_start", () => {
    if (!compactionInProgress) {
      compactionCooldown = false;
    }
  });

  // 1. Startup context injection on the first turn of a session
  pi.on(
    "before_agent_start",
    async (
      _event: BeforeAgentStartEvent,
      ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | void> => {
      if (isChildOrRecursiveCapture()) return;

      if (!compactionInProgress) {
        compactionCooldown = false;
      }

      if (startupContextInjected) return;
      startupContextInjected = true;

      const { extractStartupContext } = await getCore();
      const targetDir = path.resolve(ctx?.cwd || process.cwd());
      const startupContext = extractStartupContext(targetDir);
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

  // 2. Proactive context threshold check (turn-boundary deferral + 85% emergency cap)
  const checkThresholdAndCompact = async (_event: unknown, ctx: ExtensionContext) => {
    if (isChildOrRecursiveCapture()) return;
    if (compactionCooldown || compactionInProgress) return;
    if (
      typeof ctx?.getContextUsage !== "function" ||
      typeof ctx?.compact !== "function"
    ) {
      return;
    }

    const { loadConfig } = await getCore();
    const config = loadConfig();
    const usage = ctx.getContextUsage();
    if (!shouldTriggerCompaction(usage, config)) {
      return;
    }

    compactionCooldown = true;
    ctx.compact();
  };

  const checkEmergencyThresholdAndCompact = async (
    _event: unknown,
    ctx: ExtensionContext,
  ) => {
    if (isChildOrRecursiveCapture()) return;
    if (compactionCooldown || compactionInProgress) return;
    if (
      typeof ctx?.getContextUsage !== "function" ||
      typeof ctx?.compact !== "function"
    ) {
      return;
    }

    const { loadConfig } = await getCore();
    const config = loadConfig();
    const usage = ctx.getContextUsage();
    if (!shouldTriggerEmergencyCompaction(usage, config)) {
      return;
    }

    compactionCooldown = true;
    ctx.compact();
  };

  pi.on("turn_end", checkEmergencyThresholdAndCompact);
  pi.on("agent_end", checkThresholdAndCompact);

  pi.on("session_compact_failed", () => {
    compactionInProgress = false;
    compactionCooldown = false;
  });

  // 3. Pre-compact interception & HANDOFF.md replacement summary
  pi.on(
    "session_before_compact",
    async (
      event: SessionBeforeCompactEvent,
      ctx: ExtensionContext,
    ): Promise<SessionBeforeCompactResult | void> => {
      if (isChildOrRecursiveCapture()) return;
      if (event?.signal?.aborted) return;

      compactionInProgress = true;
      compactionCooldown = true;

      try {
        const {
          buildCompactSummaryFromHandoff,
          loadConfig,
          runStandaloneCapture,
        } = await getCore();
        const targetDir = path.resolve(ctx?.cwd || process.cwd());
        const config = loadConfig();

        const prepMessages = [
          ...(Array.isArray(event?.preparation?.messagesToSummarize)
            ? event.preparation.messagesToSummarize
            : []),
          ...(Array.isArray(event?.preparation?.turnPrefixMessages)
            ? event.preparation.turnPrefixMessages
            : []),
        ];
        const rawSource =
          prepMessages.length > 0
            ? prepMessages
            : Array.isArray(event?.branchEntries)
              ? event.branchEntries
              : [];

        const trigger =
          typeof event?.reason === "string" && event.reason.trim()
            ? event.reason.trim()
            : "auto";

        const llmRunner = createPiLlmRunner(ctx, config, event?.signal);

        const captureResult = await runStandaloneCapture({
          cwd: targetDir,
          trigger,
          agentName: "pi",
          transcriptEntries: rawSource,
          llmRunner,
          config,
        });

        if (event?.signal?.aborted) return;

        const handoffPath =
          captureResult?.handoffPath || path.join(targetDir, "HANDOFF.md");
        const handoffContent = fs.existsSync(handoffPath)
          ? fs.readFileSync(handoffPath, "utf8").trim()
          : String(captureResult?.updatedContent ?? "").trim();

        if (!handoffContent || !event?.preparation) {
          return;
        }

        return {
          compaction: {
            summary: buildCompactSummaryFromHandoff(handoffPath, handoffContent),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[handoff] Pi session_before_compact failed; falling back to default compaction: ${detail}`,
        );
        return;
      } finally {
        compactionInProgress = false;
      }
    },
  );

  // 4. Optional session_shutdown capture
  pi.on("session_shutdown", async (_event, ctx) => {
    if (isChildOrRecursiveCapture()) return;

    try {
      const { loadConfig, runStandaloneCapture } = await getCore();
      const config = loadConfig();
      if (!config.captureOnSessionEnd) {
        return;
      }

      const targetDir = path.resolve(ctx?.cwd || process.cwd());
      const branchEntries =
        typeof ctx?.sessionManager?.getBranch === "function"
          ? ctx.sessionManager.getBranch()
          : typeof ctx?.sessionManager?.getEntries === "function"
            ? ctx.sessionManager.getEntries()
            : [];
      const llmRunner = createPiLlmRunner(ctx, config);

      await runStandaloneCapture({
        cwd: targetDir,
        trigger: "session-end",
        agentName: "pi",
        transcriptEntries: Array.isArray(branchEntries) ? branchEntries : [],
        llmRunner,
        config,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[handoff] Pi session_shutdown capture failed: ${detail}`);
    }
  });
}
