import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const TRANSCRIPT_HEAD_BUDGET_BYTES = 12 * 1024
const PER_MESSAGE_TEXT_MAX_BYTES = 3 * 1024
const FIRST_GOAL_MAX_BYTES = 2 * 1024
const CLIENT_CAPTURE_TIMEOUT_MS = 15_000
const CLIENT_CAPTURE_BACKOFF_MS = 180_000
const BASE_PROMPT_OVERHEAD_TOKENS = 4_000
const MODELS_DEV_PATH = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "opencode",
  "models-dev.json",
)

const STARTUP_MARKER = "[Handoff Context from HANDOFF.md]"
const COMMAND_MARKER = "[Handoff Command Instructions]"
const SUBAGENT_NAMES = new Set(["explore", "impl", "general", "architecture-reviewer"])

type ModelRef = {
  providerID: string
  modelID: string
}

let cachedCorePromise: Promise<any> | null = null

export function resolveHandoffCorePath(): string {
  const candidates: string[] = []
  if (process.env.HANDOFF_CORE_PATH) {
    candidates.push(path.resolve(process.env.HANDOFF_CORE_PATH))
  }

  const selfFile = fileURLToPath(import.meta.url)
  candidates.push(path.resolve(path.dirname(selfFile), "../../scripts/handoff-core.mjs"))
  try {
    const realSelf = fs.realpathSync(selfFile)
    if (realSelf !== selfFile) {
      candidates.push(path.resolve(path.dirname(realSelf), "../../scripts/handoff-core.mjs"))
    }
  } catch {
    // ignore realpath error
  }

  const home = os.homedir()
  const openCodeDir = process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode")
  candidates.push(
    path.join(home, ".agents", "skills", "compact-handoff", "scripts", "handoff-core.mjs"),
    path.join(openCodeDir, "skills", "compact-handoff", "scripts", "handoff-core.mjs"),
    path.join(home, ".claude", "skills", "compact-handoff", "scripts", "handoff-core.mjs"),
  )

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    `Unable to locate handoff-core.mjs (checked: ${candidates.join(", ")})`,
  )
}

function getCore(): Promise<any> {
  if (!cachedCorePromise) {
    const corePath = resolveHandoffCorePath()
    cachedCorePromise = import(pathToFileURL(corePath).href)
  }
  return cachedCorePromise
}

function redactInlineSecrets(text: string): string {
  if (!text) return ""
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
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}\b/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /\b((?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?)[^\s'",;]{8,}(['"]?)/gi,
      "$1[REDACTED]$2",
    )
}

function loadModelsDevCache(): Record<string, any> | null {
  try {
    if (!fs.existsSync(MODELS_DEV_PATH)) return null
    const parsed = JSON.parse(fs.readFileSync(MODELS_DEV_PATH, "utf8"))
    const val = parsed?.val && typeof parsed.val === "object" ? parsed.val : parsed
    return val && typeof val === "object" ? val : null
  } catch {
    return null
  }
}

const MODELS_DEV_CACHE = loadModelsDevCache()

function lookupLimitInCatalog(
  catalog: unknown,
  providerID: string | undefined,
  modelID: string,
): number | null {
  if (!catalog || typeof catalog !== "object") return null

  const scanProviderList = (providers: any[]) => {
    if (providerID) {
      const match = providers.find((p) => p?.id === providerID || p?.providerID === providerID)
      const limit = match?.models?.[modelID]?.limit?.context
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        return limit
      }
    }
    for (const entry of providers) {
      const limit = entry?.models?.[modelID]?.limit?.context
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        return limit
      }
    }
    return null
  }

  if (Array.isArray(catalog)) {
    return scanProviderList(catalog)
  }

  const obj = catalog as Record<string, any>
  if (Array.isArray(obj.all)) {
    const found = scanProviderList(obj.all)
    if (found !== null) return found
  }
  if (Array.isArray(obj.providers)) {
    const found = scanProviderList(obj.providers)
    if (found !== null) return found
  }

  if (providerID) {
    const limit = obj?.[providerID]?.models?.[modelID]?.limit?.context
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return limit
    }
  }

  for (const providerEntry of Object.values(obj)) {
    const limit = providerEntry?.models?.[modelID]?.limit?.context
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return limit
    }
  }

  return null
}

export function getModelContextLimit(
  knownModel: unknown,
  providerCatalog?: unknown,
): number {
  const ref = normalizeModelRef(knownModel)
  const rawModelID =
    ref?.modelID ??
    (typeof knownModel === "string"
      ? knownModel.trim()
      : knownModel && typeof knownModel === "object"
        ? String((knownModel as any).modelID ?? (knownModel as any).id ?? (knownModel as any).model ?? "").trim()
        : "")

  if (rawModelID && providerCatalog) {
    const fromProvider = lookupLimitInCatalog(providerCatalog, ref?.providerID, rawModelID)
    if (fromProvider !== null) return fromProvider
  }

  if (rawModelID && MODELS_DEV_CACHE) {
    const fromCache = lookupLimitInCatalog(MODELS_DEV_CACHE, ref?.providerID, rawModelID)
    if (fromCache !== null) return fromCache
  }

  if (knownModel && typeof knownModel === "object") {
    const inlineLimit =
      (knownModel as any)?.limit?.context ?? (knownModel as any)?.contextWindow
    if (typeof inlineLimit === "number" && Number.isFinite(inlineLimit) && inlineLimit > 0) {
      return inlineLimit
    }
  }

  if (/gemini/i.test(rawModelID)) {
    return 1_048_576
  }
  return 200_000
}

function extractTokenCount(tokens: unknown): number | null {
  if (typeof tokens === "number") {
    return Number.isFinite(tokens) && tokens > 0 ? tokens : null
  }
  if (!tokens || typeof tokens !== "object") return null
  const t = tokens as Record<string, any>

  const input =
    Number(t.input ?? t.inputTokens ?? t.promptTokens ?? t.prompt ?? 0) || 0
  const output =
    Number(t.output ?? t.outputTokens ?? t.completionTokens ?? t.completion ?? 0) || 0
  const reasoning = Number(t.reasoning ?? t.reasoningTokens ?? 0) || 0
  const cacheRead = Number(t.cache?.read ?? t.cacheRead ?? t.cachedInputTokens ?? 0) || 0
  const cacheWrite = Number(t.cache?.write ?? t.cacheWrite ?? 0) || 0
  const sum = input + output + reasoning + cacheRead + cacheWrite

  const explicitTotal = Number(t.totalTokens ?? t.total ?? 0) || 0
  const best = Math.max(sum, explicitTotal)
  return Number.isFinite(best) && best > 0 ? best : null
}

function estimateMessageTokens(msg: unknown): number {
  if (!msg) return 0
  if (typeof msg === "string") {
    return Math.ceil(Buffer.byteLength(msg, "utf8") / 4)
  }
  try {
    const serialized = JSON.stringify(msg)
    return serialized ? Math.ceil(Buffer.byteLength(serialized, "utf8") / 4) : 0
  } catch {
    return 0
  }
}

function estimateMessagesTokens(messages: unknown[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateMessageTokens(msg)
  }
  return total
}

export function truncateUtf8Bytes(text: string, maxBytes: number, suffix = "\n... [truncated]"): string {
  if (!text) return ""
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const suffixBytes = Buffer.byteLength(suffix, "utf8")
  const target = Math.max(0, maxBytes - suffixBytes)
  if (target === 0) return suffix.slice(0, maxBytes)

  let buf = Buffer.from(text, "utf8").subarray(0, target)
  while (buf.length > 0 && (buf[buf.length - 1] & 0b11000000) === 0b10000000) {
    buf = buf.subarray(0, buf.length - 1)
  }
  if (buf.length > 0 && buf[buf.length - 1] >= 0b11000000) {
    buf = buf.subarray(0, buf.length - 1)
  }
  return `${buf.toString("utf8")}${suffix}`
}

function normalizeModelRef(model: unknown): ModelRef | null {
  if (!model) return null
  if (typeof model === "string") {
    const trimmed = model.trim()
    const slashIdx = trimmed.indexOf("/")
    if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
      return {
        providerID: trimmed.slice(0, slashIdx),
        modelID: trimmed.slice(slashIdx + 1),
      }
    }
    return null
  }
  if (typeof model === "object") {
    const rec = model as Record<string, unknown>
    const providerID = typeof rec.providerID === "string"
      ? rec.providerID.trim()
      : typeof rec.provider === "string"
        ? rec.provider.trim()
        : ""
    const modelID = typeof rec.modelID === "string"
      ? rec.modelID.trim()
      : typeof rec.model === "string"
        ? rec.model.trim()
        : typeof rec.id === "string"
          ? rec.id.trim()
          : ""
    if (providerID && modelID) {
      return { providerID, modelID }
    }
  }
  return null
}

function extractModelFromHead(head: unknown): ModelRef | null {
  if (!Array.isArray(head)) return null
  for (let i = head.length - 1; i >= 0; i--) {
    const item = head[i]
    const info = item?.info ?? item
    const direct = normalizeModelRef(info?.model ?? item?.model)
    if (direct) return direct
    const fromPair = normalizeModelRef({
      providerID: info?.providerID,
      modelID: info?.modelID,
    })
    if (fromPair) return fromPair
  }
  return null
}

const PATH_KEYS = new Set([
  "filePath",
  "file_path",
  "path",
  "target_file",
  "targetFile",
  "notebook_path",
  "destination",
])

function collectTouchedPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (!value || depth > 3 || out.size >= 24) return
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectTouchedPaths(item, out, depth + 1)
      }
      return
    }
    const obj = value as Record<string, unknown>
    for (const [key, val] of Object.entries(obj)) {
      if (PATH_KEYS.has(key) && typeof val === "string") {
        const trimmed = val.trim()
        if (trimmed && !/^https?:\/\//i.test(trimmed)) {
          out.add(trimmed)
        }
      } else if ((key === "files" || key === "paths") && Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === "string" && entry.trim()) {
            out.add(entry.trim())
          } else {
            collectTouchedPaths(entry, out, depth + 1)
          }
        }
      } else if (val && typeof val === "object") {
        collectTouchedPaths(val, out, depth + 1)
      }
    }
  }
}

function formatHeadEntry(entry: any): string | null {
  if (!entry || typeof entry !== "object") return null
  const info = entry.info && typeof entry.info === "object" ? entry.info : entry
  const role = String(info.role ?? entry.role ?? "message").trim().toLowerCase()
  if (role === "system") return null

  const textChunks: string[] = []
  const touchedPaths = new Set<string>()

  const parts = Array.isArray(entry.parts)
    ? entry.parts
    : Array.isArray(info.parts)
      ? info.parts
      : Array.isArray(entry.content)
        ? entry.content
        : Array.isArray(info.content)
          ? info.content
          : null

  if (parts) {
    for (const part of parts) {
      if (!part) continue
      if (typeof part === "string") {
        const trimmed = part.trim()
        if (trimmed && !trimmed.startsWith(STARTUP_MARKER) && !trimmed.startsWith(COMMAND_MARKER)) {
          textChunks.push(trimmed)
        }
        continue
      }
      if (typeof part !== "object") continue

      const pType = String(part.type ?? "").toLowerCase()
      if (pType === "text" || (!pType && typeof part.text === "string")) {
        const txt = typeof part.text === "string" ? part.text.trim() : ""
        if (txt && !txt.startsWith(STARTUP_MARKER) && !txt.startsWith(COMMAND_MARKER)) {
          textChunks.push(txt)
        }
        continue
      }

      if (
        pType === "tool" ||
        pType === "tool-invocation" ||
        pType === "tool_use" ||
        pType === "tool-call"
      ) {
        collectTouchedPaths(part.state?.input, touchedPaths)
        collectTouchedPaths(part.input, touchedPaths)
        collectTouchedPaths(part.args, touchedPaths)
        collectTouchedPaths(part.toolInvocation?.args, touchedPaths)
      }
    }
  } else {
    const rawText =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.text === "string"
          ? entry.text
          : typeof info.content === "string"
            ? info.content
            : typeof info.text === "string"
              ? info.text
              : ""
    const trimmed = rawText.trim()
    if (trimmed && !trimmed.startsWith(STARTUP_MARKER) && !trimmed.startsWith(COMMAND_MARKER)) {
      textChunks.push(trimmed)
    }
  }

  if (Array.isArray(entry.toolCalls)) {
    collectTouchedPaths(entry.toolCalls, touchedPaths)
  }

  const bodyText = truncateUtf8Bytes(
    redactInlineSecrets(textChunks.join("\n").trim()),
    PER_MESSAGE_TEXT_MAX_BYTES,
  )
  const filesNote = touchedPaths.size > 0
    ? `[files touched: ${[...touchedPaths].join(", ")}]`
    : ""

  if (!bodyText && !filesNote) return null
  const combined = [bodyText, filesNote].filter(Boolean).join("\n")
  return `[${role}]: ${combined}`
}

export function extractBoundedTranscript(
  head: unknown,
  maxBytes = TRANSCRIPT_HEAD_BUDGET_BYTES,
): string {
  if (!Array.isArray(head) || head.length === 0 || maxBytes <= 0) return ""

  const formatted: string[] = []
  for (const item of head) {
    const line = formatHeadEntry(item)
    if (line) formatted.push(line)
  }
  if (formatted.length === 0) return ""

  const full = formatted.join("\n\n")
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full
  }

  const firstUserIdx = formatted.findIndex((m) => m.startsWith("[user]:"))
  const pinnedFirst = firstUserIdx === 0
    ? truncateUtf8Bytes(formatted[0], Math.min(FIRST_GOAL_MAX_BYTES, Math.floor(maxBytes / 3)))
    : ""
  const marker = "... [earlier messages omitted]"
  const reservedBytes = pinnedFirst
    ? Buffer.byteLength(pinnedFirst, "utf8") + Buffer.byteLength(marker, "utf8") + 4
    : 0
  let tailBudget = Math.max(0, maxBytes - reservedBytes)

  const tailReversed: string[] = []
  const stopIdx = pinnedFirst ? 1 : 0
  for (let i = formatted.length - 1; i >= stopIdx; i--) {
    const candidate = formatted[i]
    const sep = tailReversed.length > 0 ? 2 : 0
    const bytes = Buffer.byteLength(candidate, "utf8") + sep
    if (bytes <= tailBudget) {
      tailReversed.push(candidate)
      tailBudget -= bytes
    } else if (tailReversed.length === 0) {
      tailReversed.push(truncateUtf8Bytes(candidate, tailBudget))
      break
    } else {
      break
    }
  }

  const tail = tailReversed.reverse()
  const assembled = pinnedFirst
    ? [pinnedFirst, marker, ...tail].join("\n\n")
    : tail.join("\n\n")
  return truncateUtf8Bytes(assembled, maxBytes)
}

function createSyntheticTextPart(
  text: string,
  input: any,
  output: any,
): Record<string, any> {
  const existingParts = Array.isArray(output?.parts) ? output.parts : []
  const refPart = existingParts[existingParts.length - 1] ?? existingParts[0]
  const sessionID = refPart?.sessionID ?? output?.message?.sessionID ?? input?.sessionID
  const messageID = refPart?.messageID ?? output?.message?.id ?? input?.messageID
  const includeIds = Boolean(refPart?.id || (sessionID && messageID))

  return {
    ...(includeIds
      ? {
          id: `prt_z${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`,
        }
      : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(messageID ? { messageID } : {}),
    type: "text",
    text,
    synthetic: true,
  }
}

function extractTextFromPromptResponse(res: any): string {
  const payload = res?.data ?? res
  if (!payload) return ""
  if (typeof payload === "string") return payload.trim()
  if (typeof payload.text === "string") return payload.text.trim()
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
      .trim()
  }
  return ""
}

const HandoffOpenCodeExtension = {
  id: "handoff",

  async server(ctx: any = {}) {
    const core = await getCore()
    const {
      buildCompactSummaryFromHandoff,
      extractStartupContext,
      loadConfig,
      runStandaloneCapture,
    } = core

    const baseDirectory = path.resolve(ctx?.directory || ctx?.worktree || process.cwd())
    const seenSessions = new Set<string>()
    const sessionModels = new Map<string, unknown>()
    const activeCaptureSessions = new Set<string>()
    const newUserTurnPending = new Set<string>()
    const sessionStepTokens = new Map<string, { tokens: number; messageCount: number }>()
    const lastMessageCount = new Map<string, number>()
    const subagentSessions = new Set<string>()
    const checkedParentSessions = new Set<string>()
    let clientCaptureBackoffUntil = 0
    let cachedProviderCatalog: unknown = null
    let providerCatalogFetched = false

    const logWarn = (message: string, err?: unknown) => {
      const detail = err instanceof Error ? err.message : err ? String(err) : ""
      const fullMsg = detail ? `[handoff] ${message}: ${detail}` : `[handoff] ${message}`
      try {
        ctx?.client?.app?.log?.({
          body: { service: "handoff", level: "warn", message: fullMsg },
        })
      } catch {
        // ignore client logger error
      }
      console.warn(fullMsg)
    }

    const resolveProviderCatalog = async (): Promise<unknown> => {
      if (providerCatalogFetched) return cachedProviderCatalog
      providerCatalogFetched = true
      if (typeof ctx?.client?.provider?.list !== "function") {
        return null
      }
      try {
        const res = await Promise.race([
          ctx.client.provider.list(),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ])
        cachedProviderCatalog = (res as any)?.data ?? res ?? null
      } catch {
        cachedProviderCatalog = null
      }
      return cachedProviderCatalog
    }

    const hasSessionClient = Boolean(
      ctx?.client?.session &&
      typeof ctx.client.session.create === "function" &&
      typeof ctx.client.session.prompt === "function",
    )

    const isSubagentSession = async (
      sessionID: string | undefined,
      targetDir: string,
      agentHint?: string,
    ): Promise<boolean> => {
      if (!sessionID) return false
      if (activeCaptureSessions.has(sessionID) || subagentSessions.has(sessionID)) {
        return true
      }
      if (agentHint && SUBAGENT_NAMES.has(agentHint.trim().toLowerCase())) {
        subagentSessions.add(sessionID)
        return true
      }
      if (
        sessionID !== "__default__" &&
        !checkedParentSessions.has(sessionID) &&
        typeof ctx?.client?.session?.get === "function"
      ) {
        try {
          const res = await ctx.client.session.get({
            path: { id: sessionID },
            query: { directory: targetDir },
          })
          const data = res?.data ?? res
          checkedParentSessions.add(sessionID)
          if (typeof data?.parentID === "string" && data.parentID.trim()) {
            subagentSessions.add(sessionID)
            return true
          }
        } catch {
          // ignore transient session lookup error
        }
      }
      return false
    }

    const createClientLlmRunner = (
      targetDir: string,
      parentSessionID: string | undefined,
      sessionModel: unknown,
      config: any,
    ) => {
      if (!hasSessionClient) return undefined

      return async (prompt: string): Promise<string> => {
        if (Date.now() < clientCaptureBackoffUntil) {
          throw new Error("Handoff client capture in backoff cooldown; using fallback")
        }

        const prevCaptureEnv = process.env.HANDOFF_CAPTURE_ACTIVE
        process.env.HANDOFF_CAPTURE_ACTIVE = "1"
        let childSessionID: string | null = null
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined

        const runPrompt = async (): Promise<string> => {
          const created = await ctx.client.session.create({
            body: {
              ...(parentSessionID ? { parentID: parentSessionID } : {}),
              title: "handoff capture",
            },
            query: { directory: targetDir },
          })
          const createdData = created?.data ?? created
          const id = typeof createdData?.id === "string" ? createdData.id : ""
          if (!id) {
            throw new Error("Failed to create ephemeral handoff capture session")
          }

          childSessionID = id
          activeCaptureSessions.add(id)
          seenSessions.add(id)

          const configuredModel =
            config?.model && config.model !== "current"
              ? normalizeModelRef(config.model)
              : null
          const activeModel = normalizeModelRef(sessionModel)
          const selectedModel = configuredModel ?? activeModel

          const promptBody: Record<string, any> = {
            ...(config?.useSubagent ? { agent: "explore" } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            system:
              "You are a JSON state extractor for HANDOFF.md. Return ONLY a single valid JSON object matching the requested schema, with no markdown code fences and no extra commentary.",
            tools: {
              bash: false,
              read: false,
              edit: false,
              write: false,
              glob: false,
              grep: false,
              task: false,
            },
            parts: [{ type: "text", text: prompt }],
          }

          const response = await ctx.client.session.prompt({
            path: { id },
            query: { directory: targetDir },
            body: promptBody,
          })

          const text = extractTextFromPromptResponse(response)
          if (!text) {
            throw new Error("Empty response from OpenCode client capture session")
          }
          return text
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Handoff capture timed out after ${CLIENT_CAPTURE_TIMEOUT_MS}ms`))
          }, CLIENT_CAPTURE_TIMEOUT_MS)
        })

        try {
          return await Promise.race([runPrompt(), timeoutPromise])
        } catch (err) {
          clientCaptureBackoffUntil = Date.now() + CLIENT_CAPTURE_BACKOFF_MS
          if (childSessionID && typeof ctx?.client?.session?.abort === "function") {
            try {
              await Promise.race([
                ctx.client.session.abort({
                  path: { id: childSessionID },
                  query: { directory: targetDir },
                }),
                new Promise((resolve) => setTimeout(resolve, 1000)),
              ])
            } catch {
              // ignore abort errors on ephemeral session
            }
          }
          throw err
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle)
          }
          if (childSessionID && typeof ctx?.client?.session?.delete === "function") {
            try {
              await Promise.race([
                ctx.client.session.delete({
                  path: { id: childSessionID },
                  query: { directory: targetDir },
                }),
                new Promise((resolve) => setTimeout(resolve, 1000)),
              ])
            } catch {
              // ignore cleanup errors on ephemeral session
            }
          }
          if (childSessionID) {
            activeCaptureSessions.delete(childSessionID)
          }
          if (prevCaptureEnv === undefined) {
            delete process.env.HANDOFF_CAPTURE_ACTIVE
          } else {
            process.env.HANDOFF_CAPTURE_ACTIVE = prevCaptureEnv
          }
        }
      }
    }

    return {
      compaction: {
        owner: "extension",
        label: "Handoff",
        description: "Updates HANDOFF.md and compacts at turn boundaries (emergency cap at 85%).",
      },

      "chat.message": async (input: any, output: any) => {
        try {
          const sessionID =
            typeof input?.sessionID === "string" && input.sessionID.trim()
              ? input.sessionID.trim()
              : typeof output?.message?.sessionID === "string" && output.message.sessionID.trim()
                ? output.message.sessionID.trim()
                : "__default__"

          if (input?.model !== undefined && input?.model !== null) {
            sessionModels.set(sessionID, input.model)
          }

          const targetDir = path.resolve(input?.directory || baseDirectory)
          const agentHint =
            typeof input?.agent === "string"
              ? input.agent
              : typeof output?.message?.agent === "string"
                ? output.message.agent
                : undefined

          if (
            process.env.HANDOFF_CAPTURE_ACTIVE === "1" ||
            (await isSubagentSession(sessionID, targetDir, agentHint))
          ) {
            return
          }

          newUserTurnPending.add(sessionID)

          if (seenSessions.has(sessionID)) {
            return
          }
          seenSessions.add(sessionID)

          const startupContext = extractStartupContext(targetDir)
          if (!startupContext || !startupContext.trim()) {
            return
          }

          if (output && typeof output === "object") {
            if (!Array.isArray(output.parts)) {
              output.parts = []
            }
            const noteText = `${STARTUP_MARKER}\n\n${startupContext.trim()}`
            output.parts.push(createSyntheticTextPart(noteText, input, output))
          }
        } catch (err) {
          logWarn("chat.message startup context injection failed", err)
        }
      },

      "experimental.chat.step.end": async (input: any) => {
        try {
          const sessionID =
            typeof input?.sessionID === "string" && input.sessionID.trim()
              ? input.sessionID.trim()
              : undefined
          if (!sessionID) return
          const tokenCount = extractTokenCount(input?.tokens)
          if (tokenCount !== null && tokenCount > 0) {
            sessionStepTokens.set(sessionID, {
              tokens: tokenCount,
              messageCount: lastMessageCount.get(sessionID) ?? 0,
            })
          }
        } catch (err) {
          logWarn("experimental.chat.step.end failed", err)
        }
      },

      "experimental.chat.messages.transform": async (input: any, output: any) => {
        try {
          if (
            !output ||
            typeof output !== "object" ||
            input?.purpose === "compaction" ||
            input?.compactionAvailable !== true ||
            output.pendingCompaction
          ) {
            return
          }

          const messages = Array.isArray(output.messages) ? output.messages : []
          const firstMsgInfo = messages[0]?.info ?? messages[0]
          const lastMsgInfo = messages[messages.length - 1]?.info ?? messages[messages.length - 1]
          const sessionID =
            typeof input?.sessionID === "string" && input.sessionID.trim()
              ? input.sessionID.trim()
              : typeof lastMsgInfo?.sessionID === "string" && lastMsgInfo.sessionID.trim()
                ? lastMsgInfo.sessionID.trim()
                : typeof firstMsgInfo?.sessionID === "string" && firstMsgInfo.sessionID.trim()
                  ? firstMsgInfo.sessionID.trim()
                  : "__default__"

          if (input?.model !== undefined && input?.model !== null) {
            sessionModels.set(sessionID, input.model)
          }

          const targetDir = path.resolve(input?.directory || baseDirectory)
          if (
            process.env.HANDOFF_CAPTURE_ACTIVE === "1" ||
            activeCaptureSessions.has(sessionID) ||
            (await isSubagentSession(sessionID, targetDir))
          ) {
            return
          }

          const isTurnBoundary = newUserTurnPending.delete(sessionID)
          const knownModel =
            sessionModels.get(sessionID) ??
            input?.model ??
            extractModelFromHead(messages)
          const providerCatalog = await resolveProviderCatalog()
          const contextWindow = getModelContextLimit(knownModel, providerCatalog)

          const stepEntry = sessionStepTokens.get(sessionID)
          lastMessageCount.set(sessionID, messages.length)

          let usedTokens: number
          if (stepEntry && messages.length >= stepEntry.messageCount) {
            usedTokens =
              stepEntry.tokens +
              estimateMessagesTokens(messages.slice(stepEntry.messageCount))
          } else {
            usedTokens =
              estimateMessagesTokens(messages) + BASE_PROMPT_OVERHEAD_TOKENS
          }

          const config = loadConfig()
          let shouldCompact = false

          if (isTurnBoundary) {
            if (config.trigger?.mode === "tokens") {
              shouldCompact = usedTokens >= config.trigger.tokens
            } else {
              const pct = config.trigger?.percentage ?? 60
              shouldCompact = usedTokens >= (pct / 100) * contextWindow
            }
          } else {
            const emergencyRatio = Math.min(
              0.98,
              Math.max(0.85, (config.trigger?.percentage ?? 60) / 100 + 0.15),
            )
            shouldCompact = usedTokens >= emergencyRatio * contextWindow
          }

          if (shouldCompact) {
            output.pendingCompaction = { auto: true }
          }
        } catch (err) {
          logWarn("experimental.chat.messages.transform failed", err)
        }
      },

      "experimental.session.compaction.provide": async (input: any, output: any) => {
        try {
          if (!output || typeof output !== "object" || output.summary) {
            return
          }

          const sessionID =
            typeof input?.sessionID === "string" && input.sessionID.trim()
              ? input.sessionID.trim()
              : undefined

          const targetDir = path.resolve(input?.directory || baseDirectory)

          if (
            process.env.HANDOFF_CAPTURE_ACTIVE === "1" ||
            (sessionID && (await isSubagentSession(sessionID, targetDir)))
          ) {
            return
          }

          if (sessionID) {
            activeCaptureSessions.add(sessionID)
          }

          try {
            const config = loadConfig()
            const transcriptText = extractBoundedTranscript(
              input?.head,
              TRANSCRIPT_HEAD_BUDGET_BYTES,
            )
            const knownModel =
              (sessionID ? sessionModels.get(sessionID) : undefined) ??
              input?.model ??
              extractModelFromHead(input?.head)

            const trigger =
              typeof input?.reason === "string" && input.reason.trim()
                ? input.reason.trim()
                : "auto"

            const llmRunner = createClientLlmRunner(
              targetDir,
              sessionID,
              knownModel,
              config,
            )

            const captureResult = await runStandaloneCapture({
              cwd: targetDir,
              trigger,
              agentName: "opencode",
              transcriptText,
              llmRunner,
              config,
            })

            const handoffPath =
              captureResult?.handoffPath || path.join(targetDir, "HANDOFF.md")
            const handoffContent = fs.existsSync(handoffPath)
              ? fs.readFileSync(handoffPath, "utf8").trim()
              : String(captureResult?.updatedContent ?? "").trim()

            if (!handoffContent) {
              return
            }

            if (sessionID) {
              sessionStepTokens.delete(sessionID)
              lastMessageCount.delete(sessionID)
            }

            output.summary = {
              modelText: buildCompactSummaryFromHandoff(handoffPath, handoffContent),
              displayText: "HANDOFF.md updated & context compacted",
              metadata: {
                handoffUpdatedAt: new Date().toISOString(),
                reason: input?.reason ?? "auto",
              },
            }
          } finally {
            if (sessionID) {
              activeCaptureSessions.delete(sessionID)
            }
          }
        } catch (err) {
          logWarn("compaction capture failed; falling back to built-in summarizer", err)
        }
      },

      "session.end": async (input: any) => {
        try {
          const sessionID =
            typeof input?.sessionID === "string" && input.sessionID.trim()
              ? input.sessionID.trim()
              : undefined

          if (
            process.env.HANDOFF_CAPTURE_ACTIVE === "1" ||
            (sessionID && activeCaptureSessions.has(sessionID))
          ) {
            return
          }

          const knownModel = sessionID ? sessionModels.get(sessionID) : undefined
          const targetDir = path.resolve(input?.directory || baseDirectory)
          const isSubagent = sessionID ? await isSubagentSession(sessionID, targetDir) : false

          if (sessionID) {
            sessionModels.delete(sessionID)
            seenSessions.delete(sessionID)
            newUserTurnPending.delete(sessionID)
            sessionStepTokens.delete(sessionID)
            lastMessageCount.delete(sessionID)
            subagentSessions.delete(sessionID)
            checkedParentSessions.delete(sessionID)
          }

          if (isSubagent) {
            return
          }

          const config = loadConfig()
          if (!config.captureOnSessionEnd) {
            return
          }

          const llmRunner = createClientLlmRunner(
            targetDir,
            sessionID,
            knownModel,
            config,
          )

          await runStandaloneCapture({
            cwd: targetDir,
            trigger: "session-end",
            agentName: "opencode",
            llmRunner,
            config,
          })
        } catch (err) {
          logWarn("session.end capture failed", err)
        }
      },

      "command.execute.before": async (input: any, output?: any) => {
        try {
          const rawCommand = typeof input?.command === "string" ? input.command.trim() : ""
          const commandName = rawCommand.replace(/^\//, "")
          if (commandName !== "handoff") {
            return
          }

          const targetDir = path.resolve(input?.directory || baseDirectory)
          const handoffPath = path.join(targetDir, "HANDOFF.md")
          const rawArgs = typeof input?.arguments === "string" ? input.arguments.trim() : ""

          const instructionLines = [
            COMMAND_MARKER,
            `Invoke and follow the \`compact-handoff\` skill workflow to update or resume \`${handoffPath}\` in \`${targetDir}\` (using agent name \`opencode\`).`,
            rawArgs
              ? `Apply the user's \`/handoff\` arguments: ${rawArgs}`
              : "No extra arguments were passed; perform the default handoff capture/update workflow for the current session.",
          ]

          if (output && typeof output === "object") {
            if (!Array.isArray(output.parts)) {
              output.parts = []
            }
            output.parts.push(
              createSyntheticTextPart(instructionLines.join("\n"), input, output),
            )
          }
        } catch (err) {
          logWarn("command.execute.before(/handoff) failed", err)
        }
      },
    }
  },
}

export default HandoffOpenCodeExtension
