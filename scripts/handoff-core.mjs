import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "handoff",
  "config.json",
);
export const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "templates",
  "HANDOFF.md",
);

export const DIFF_BUDGET_BYTES = 45 * 1024; // 45 KB fair-share diff budget
export const COMBINED_EVIDENCE_BUDGET_BYTES = 57 * 1024; // 45 KB diff + 12 KB baseline
export const TRANSCRIPT_MIN_BUDGET_BYTES = 12 * 1024; // 12 KB floor when diff is full
export const TRANSCRIPT_MAX_BUDGET_BYTES = 48 * 1024; // 48 KB max when diff is empty/minimal
const UNTRACKED_FILE_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_MAX_BYTES = TRANSCRIPT_MAX_BUDGET_BYTES;

export const DEFAULT_CONFIG = Object.freeze({
  trigger: Object.freeze({
    mode: "percentage",
    percentage: 50,
    tokens: 100000,
  }),
  model: "current",
  useSubagent: true,
  captureOnSessionEnd: false,
  autoExcludeGit: true,
});

export const DEFAULT_TEMPLATE = `# Handoff

> Last updated: never

## Overview

<!-- One or two sentences describing what this project is. Preserved across automatic updates. -->

## Current status

**Done**
- (none yet)

**In progress**
- (none yet)

**Next**
- (none yet)

## Decision log

<!-- Append-only dated decisions with rationale. Preserved and deduplicated across updates. -->

## Gotchas / constraints

<!-- Append-only non-obvious traps, dead ends, and constraints. Preserved and deduplicated across updates. -->

## Open questions

<!-- Regenerated on each capture with unresolved questions, open tradeoffs, or items awaiting confirmation. -->

## Commands

<!-- Build, test, and verification commands. Preserved across automatic updates. -->
`;

const GIT_EXCLUDE_ENTRIES = [
  "HANDOFF.md",
  ".claude/handoff.state.json",
  ".opencode/handoff.state.json",
  ".gemini/handoff.state.json",
];

const NOISE_BASENAMES = new Set([
  "HANDOFF.md",
  "handoff.state.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "Podfile.lock",
  ".DS_Store",
]);

const NOISE_DIR_PREFIXES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  ".claude/",
  ".opencode/",
  ".gemini/",
  ".pi/",
];

const BINARY_OR_NOISE_EXTS = new Set([
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".wasm",
  ".pyc",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".sqlite",
  ".sqlite3",
  ".db",
]);

const SAFE_ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "into",
  "over",
  "via",
  "when",
  "while",
  "so",
  "if",
  "than",
  "then",
]);

// ---------------------------------------------------------------------------
// File & JSONC Utilities
// ---------------------------------------------------------------------------

export function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

export function stripJsonc(raw) {
  let out = "";
  let inString = false;
  let escaped = false;
  let hasComments = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      hasComments = true;
      i += 2;
      while (i < raw.length && raw[i] !== "\n") i++;
      if (i < raw.length) out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      hasComments = true;
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        if (raw[i] === "\n") out += "\n";
        i++;
      }
      i += 1;
      continue;
    }

    out += ch;
  }

  // Strip trailing commas outside strings
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") {
        continue;
      }
    }
    cleaned += ch;
  }

  return { cleaned, hasComments };
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeConfig(raw = {}) {
  const rawTrigger =
    raw && typeof raw.trigger === "object" && raw.trigger !== null
      ? raw.trigger
      : {};
  const mode = ["percentage", "tokens", "auto"].includes(rawTrigger.mode)
    ? rawTrigger.mode
    : DEFAULT_CONFIG.trigger.mode;
  const percentage = clampInt(
    rawTrigger.percentage,
    1,
    100,
    DEFAULT_CONFIG.trigger.percentage,
  );
  const tokens = clampInt(
    rawTrigger.tokens,
    1,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_CONFIG.trigger.tokens,
  );

  return {
    trigger: {
      mode,
      percentage,
      tokens,
    },
    model:
      typeof raw?.model === "string" && raw.model.trim()
        ? raw.model.trim()
        : DEFAULT_CONFIG.model,
    useSubagent:
      typeof raw?.useSubagent === "boolean"
        ? raw.useSubagent
        : DEFAULT_CONFIG.useSubagent,
    captureOnSessionEnd:
      typeof raw?.captureOnSessionEnd === "boolean"
        ? raw.captureOnSessionEnd
        : DEFAULT_CONFIG.captureOnSessionEnd,
    autoExcludeGit:
      typeof raw?.autoExcludeGit === "boolean"
        ? raw.autoExcludeGit
        : DEFAULT_CONFIG.autoExcludeGit,
  };
}

export function resolveOpenCodeConfigDir(overrideDir = null) {
  const raw =
    overrideDir ||
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "opencode");
  return path.resolve(raw);
}

export function resolveOpenCodeConfigPath(options = {}) {
  if (options.openCodeConfigPath) {
    return path.resolve(options.openCodeConfigPath);
  }
  if (process.env.HANDOFF_OPENCODE_CONFIG_PATH) {
    return path.resolve(process.env.HANDOFF_OPENCODE_CONFIG_PATH);
  }
  const dir = resolveOpenCodeConfigDir(options.openCodeDir);
  const jsoncPath = path.join(dir, "opencode.jsonc");
  const jsonPath = path.join(dir, "opencode.json");
  if (fs.existsSync(jsoncPath)) return jsoncPath;
  if (fs.existsSync(jsonPath)) return jsonPath;
  return jsonPath;
}

export function mapOpenCodeTrigger(trigger) {
  if (trigger.mode === "tokens") {
    return {
      mode: "tokens",
      value: clampInt(trigger.tokens, 1, Number.MAX_SAFE_INTEGER, 100000),
    };
  }
  if (trigger.mode === "auto") {
    return { mode: "auto" };
  }
  return {
    mode: "percentage",
    value: clampInt(trigger.percentage, 1, 100, 50),
  };
}

export function syncOpenCodeCompactionTrigger(trigger, openCodeConfigPath) {
  if (!openCodeConfigPath || !fs.existsSync(openCodeConfigPath)) {
    return false;
  }
  try {
    const raw = fs.readFileSync(openCodeConfigPath, "utf8");
    const { cleaned } = stripJsonc(raw);
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const existingCompaction =
      parsed.compaction &&
      typeof parsed.compaction === "object" &&
      !Array.isArray(parsed.compaction)
        ? parsed.compaction
        : {};
    parsed.compaction = {
      ...existingCompaction,
      trigger: mapOpenCodeTrigger(trigger),
    };
    atomicWriteFileSync(
      openCodeConfigPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(options = {}) {
  const configPath =
    options.configPath ||
    process.env.HANDOFF_CONFIG_PATH ||
    DEFAULT_CONFIG_PATH;
  try {
    if (!fs.existsSync(configPath)) {
      return normalizeConfig({});
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const { cleaned } = stripJsonc(raw);
    return normalizeConfig(JSON.parse(cleaned));
  } catch {
    return normalizeConfig({});
  }
}

export function saveConfig(partial = {}, options = {}) {
  const configPath =
    options.configPath ||
    process.env.HANDOFF_CONFIG_PATH ||
    DEFAULT_CONFIG_PATH;
  const openCodeConfigPath = resolveOpenCodeConfigPath(options);

  const hadFile = fs.existsSync(configPath);
  const current = loadConfig({ configPath });
  const merged = normalizeConfig({
    ...current,
    ...(partial || {}),
    trigger: {
      ...current.trigger,
      ...(partial?.trigger || {}),
    },
  });

  const triggerChanged =
    partial?.trigger !== undefined &&
    (!hadFile ||
      current.trigger.mode !== merged.trigger.mode ||
      current.trigger.percentage !== merged.trigger.percentage ||
      current.trigger.tokens !== merged.trigger.tokens);

  atomicWriteFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);

  if (triggerChanged) {
    syncOpenCodeCompactionTrigger(merged.trigger, openCodeConfigPath);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Git & Secret / Noise Filtering
// ---------------------------------------------------------------------------

function runGit(cwd, args, maxBuffer = 10 * 1024 * 1024) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      maxBuffer,
    });
  } catch {
    return null;
  }
}

export function resolveGitInfo(cwd) {
  const target = path.resolve(cwd || process.cwd());
  const rawGitDir = runGit(target, ["rev-parse", "--git-dir"]);
  if (rawGitDir === null) return null;
  const gitDir = path.resolve(target, rawGitDir.trim());
  const rawCommonDir = runGit(target, ["rev-parse", "--git-common-dir"]);
  const commonDir = rawCommonDir
    ? path.resolve(target, rawCommonDir.trim())
    : gitDir;
  const rawTopLevel = runGit(target, ["rev-parse", "--show-toplevel"]);
  const rootDir = rawTopLevel ? path.resolve(rawTopLevel.trim()) : target;
  return { gitDir, commonDir, rootDir };
}

export function isSecretPath(relPath) {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = path.posix.basename(norm);
  const lowerBase = base.toLowerCase();
  const lowerNorm = norm.toLowerCase();

  if (SAFE_ENV_EXAMPLES.has(lowerBase) || lowerBase.endsWith(".example")) {
    return false;
  }
  if (lowerBase === ".env" || lowerBase.startsWith(".env.")) return true;
  if (
    lowerBase.endsWith(".pem") ||
    lowerBase.endsWith(".key") ||
    lowerBase.endsWith(".p12") ||
    lowerBase.endsWith(".pfx") ||
    lowerBase.endsWith(".jks") ||
    lowerBase.endsWith(".keystore")
  ) {
    return true;
  }
  if (
    /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i.test(base) ||
    lowerBase === "credentials.json" ||
    lowerBase === "auth.json" ||
    lowerBase === ".npmrc" ||
    lowerBase === ".pypirc" ||
    lowerBase === ".netrc" ||
    lowerNorm.endsWith(".aws/credentials") ||
    /service[-_]?account.*\.json$/i.test(base) ||
    /secret.*\.(json|ya?ml|toml|ini|txt)$/i.test(base)
  ) {
    return true;
  }
  return false;
}

export function isNoisePath(relPath) {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = path.posix.basename(norm);
  if (NOISE_BASENAMES.has(base)) return true;
  if (norm === "HANDOFF.md" || norm.endsWith("/HANDOFF.md")) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;

  for (const prefix of NOISE_DIR_PREFIXES) {
    if (norm.startsWith(prefix) || norm.includes(`/${prefix}`)) return true;
  }

  const ext = path.posix.extname(base).toLowerCase();
  if (BINARY_OR_NOISE_EXTS.has(ext)) return true;
  return false;
}

export function redactSecrets(text) {
  if (!text || typeof text !== "string") return "";
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

function unquoteGitPath(rawPath) {
  let p = rawPath.trim();
  if (p.includes(" -> ")) {
    p = p.split(" -> ").pop().trim();
  }
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
      p = p.slice(1, -1);
    }
  }
  return p;
}

function parsePorcelainLines(rawPorcelain) {
  if (!rawPorcelain) return [];
  const entries = [];
  for (const line of rawPorcelain.replace(/\r\n/g, "\n").split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const filePath = unquoteGitPath(line.slice(3));
    if (!filePath) continue;
    entries.push({ xy, filePath, raw: line });
  }
  return entries;
}

export function ensureGitExclude(cwd, options = {}) {
  const config = options.config || loadConfig(options);
  if (!config.autoExcludeGit) {
    return { updated: false, excludePath: null, added: [] };
  }

  const gitInfo = resolveGitInfo(cwd);
  if (!gitInfo) {
    return { updated: false, excludePath: null, added: [] };
  }

  const targetDirs =
    gitInfo.commonDir !== gitInfo.gitDir
      ? [gitInfo.gitDir, gitInfo.commonDir]
      : [gitInfo.gitDir];

  let primaryExcludePath = null;
  let anyUpdated = false;
  const allAdded = new Set();

  for (const dir of targetDirs) {
    const infoDir = path.join(dir, "info");
    const excludePath = path.join(infoDir, "exclude");
    if (!primaryExcludePath) primaryExcludePath = excludePath;

    fs.mkdirSync(infoDir, { recursive: true });
    const existing = fs.existsSync(excludePath)
      ? fs.readFileSync(excludePath, "utf8")
      : "";
    const existingLines = new Set(
      existing
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );

    const missing = GIT_EXCLUDE_ENTRIES.filter((entry) => !existingLines.has(entry));
    if (missing.length === 0) continue;

    let updated = existing;
    if (updated.length > 0 && !updated.endsWith("\n")) {
      updated += "\n";
    }
    if (!updated.includes("# compact-handoff")) {
      updated += `${updated.length > 0 ? "\n" : ""}# compact-handoff\n`;
    }
    updated += `${missing.join("\n")}\n`;

    atomicWriteFileSync(excludePath, updated);
    anyUpdated = true;
    for (const item of missing) allAdded.add(item);
  }

  return {
    updated: anyUpdated,
    excludePath: primaryExcludePath,
    added: [...allAdded],
  };
}

export function ensureHandoffFile(cwd, options = {}) {
  const targetDir = path.resolve(cwd || process.cwd());
  const handoffPath = path.join(targetDir, "HANDOFF.md");
  let created = false;

  if (!fs.existsSync(handoffPath)) {
    let templateContent = DEFAULT_TEMPLATE;
    try {
      if (fs.existsSync(TEMPLATE_PATH)) {
        templateContent = fs.readFileSync(TEMPLATE_PATH, "utf8");
      }
    } catch {
      // fall back to embedded template
    }
    atomicWriteFileSync(handoffPath, templateContent);
    created = true;
  }

  const exclude = ensureGitExclude(targetDir, options);
  return { path: handoffPath, created, exclude };
}

export function computeGitSignal(cwd) {
  const gitInfo = resolveGitInfo(cwd);
  if (!gitInfo) return null;

  const workDir = gitInfo.rootDir;
  const head = (runGit(workDir, ["rev-parse", "HEAD"]) || "UNBORN").trim();
  const rawPorcelain = runGit(workDir, ["status", "--porcelain=v1", "-uall"]) || "";
  const statusEntries = parsePorcelainLines(rawPorcelain).filter(
    ({ filePath }) => !isNoisePath(filePath),
  );

  const statusPart = statusEntries
    .map(({ xy, filePath }) => `${xy} ${filePath}`)
    .sort()
    .join("\n");

  const diffTargetArgs =
    head === "UNBORN" ? ["diff", "--cached", "--numstat"] : ["diff", "HEAD", "--numstat"];
  const rawNumstat = runGit(workDir, diffTargetArgs) || "";
  const numstatPart = rawNumstat
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const parts = line.split("\t");
      const filePath = unquoteGitPath(parts[parts.length - 1] || "");
      return filePath && !isNoisePath(filePath) && !isSecretPath(filePath);
    })
    .sort()
    .join("\n");

  const untrackedStats = [];
  for (const { xy, filePath } of statusEntries) {
    if (xy === "??" && !isSecretPath(filePath)) {
      try {
        const st = fs.statSync(path.join(workDir, filePath));
        if (st.isFile()) {
          untrackedStats.push(`${filePath}:${st.size}:${Math.trunc(st.mtimeMs)}`);
        }
      } catch {
        // ignore transient file
      }
    }
  }
  untrackedStats.sort();

  const payload = [head, statusPart, numstatPart, untrackedStats.join("\n")].join(
    "\n---\n",
  );
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function truncateUtf8ToBytes(str, maxBytes, suffix = "\n... [diff truncated]") {
  const totalBytes = Buffer.byteLength(str, "utf8");
  if (totalBytes <= maxBytes) return str;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const target = Math.max(0, maxBytes - suffixBytes);
  if (target === 0) return suffix.slice(0, maxBytes);

  let buf = Buffer.from(str, "utf8").subarray(0, target);
  // Avoid splitting a multi-byte UTF-8 sequence at the tail
  while (buf.length > 0 && (buf[buf.length - 1] & 0b11000000) === 0b10000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  if (buf.length > 0 && buf[buf.length - 1] >= 0b11000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  let text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline > text.length * 0.6) {
    text = text.slice(0, lastNewline);
  }
  return `${text}${suffix}`;
}

function allocateFairShareDiffs(fileDiffs, budgetBytes = DIFF_BUDGET_BYTES) {
  if (fileDiffs.length === 0 || budgetBytes <= 0) return "";

  const indexed = fileDiffs.map((item, idx) => ({
    ...item,
    idx,
    bytes: Buffer.byteLength(item.diff, "utf8"),
    allocated: "",
  }));

  // Water-filling fair-share: sort smallest-first so small diffs leave surplus for larger files
  const bySize = [...indexed].sort((a, b) => a.bytes - b.bytes);
  let remainingBudget = budgetBytes;
  let remainingFiles = bySize.length;

  for (const entry of bySize) {
    const separatorAllowance = remainingFiles > 1 ? 2 : 0;
    const share = Math.max(0, Math.floor(remainingBudget / remainingFiles) - separatorAllowance);
    entry.allocated = truncateUtf8ToBytes(entry.diff, share);
    const used = Buffer.byteLength(entry.allocated, "utf8") + separatorAllowance;
    remainingBudget = Math.max(0, remainingBudget - used);
    remainingFiles -= 1;
  }

  // Restore deterministic path order
  const combined = indexed
    .sort((a, b) => a.filePath.localeCompare(b.filePath))
    .map((e) => e.allocated)
    .filter(Boolean)
    .join("\n\n");

  return truncateUtf8ToBytes(combined, budgetBytes);
}

function isLikelyBinaryBuffer(buf) {
  const checkLen = Math.min(buf.length, 4096);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function buildUntrackedPseudoDiff(workDir, relPath) {
  const fullPath = path.join(workDir, relPath);
  try {
    const st = fs.statSync(fullPath);
    if (!st.isFile()) return null;
    const fd = fs.openSync(fullPath, "r");
    const readLen = Math.min(st.size, UNTRACKED_FILE_MAX_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);

    if (isLikelyBinaryBuffer(buf)) return null;
    const content = redactSecrets(buf.toString("utf8"));
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const body = lines.map((l) => `+${l}`).join("\n");
    const extra =
      st.size > UNTRACKED_FILE_MAX_BYTES ? "\n+... [untracked file truncated]" : "";
    return `diff --git a/${relPath} b/${relPath}\nnew file\n--- /dev/null\n+++ b/${relPath}\n${body}${extra}`;
  } catch {
    return null;
  }
}

export function gatherGitContext(cwd, lastHead = null) {
  const gitInfo = resolveGitInfo(cwd);
  if (!gitInfo) {
    return {
      isGitRepo: false,
      branch: null,
      head: null,
      status: "",
      recentCommits: "",
      commitsSinceLastCapture: "",
      diffStat: "",
      diff: "",
      untrackedFiles: [],
      text: "(not a git repository)",
      toString() {
        return this.text;
      },
    };
  }

  const workDir = gitInfo.rootDir;
  const branch = (
    runGit(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD"
  ).trim();
  const rawHead = runGit(workDir, ["rev-parse", "HEAD"]);
  const head = rawHead ? rawHead.trim() : null;

  const rawPorcelain = runGit(workDir, ["status", "--porcelain=v1", "-uall"]) || "";
  const statusEntries = parsePorcelainLines(rawPorcelain).filter(
    ({ filePath }) => !isNoisePath(filePath),
  );
  const statusLines = statusEntries.map(({ xy, filePath }) =>
    isSecretPath(filePath)
      ? `${xy} ${filePath} [secret file - diff omitted]`
      : `${xy} ${filePath}`,
  );
  const status = statusLines.join("\n");

  const recentCommits = head
    ? redactSecrets(
        (runGit(workDir, ["log", "--oneline", "--no-decorate", "-n", "10"]) || "").trim(),
      )
    : "";

  let commitsSinceLastCapture = "";
  let validLastHead = false;
  if (head && lastHead && lastHead !== head && /^[0-9a-f]{7,40}$/i.test(lastHead)) {
    const exists = runGit(workDir, ["cat-file", "-t", lastHead]);
    if (exists && exists.trim() === "commit") {
      validLastHead = true;
      commitsSinceLastCapture = redactSecrets(
        (
          runGit(workDir, [
            "log",
            "--oneline",
            "--no-decorate",
            `${lastHead}..HEAD`,
            "-n",
            "30",
          ]) || ""
        ).trim(),
      );
    }
  }

  const workingTrackedFiles = (
    head
      ? runGit(workDir, ["diff", "HEAD", "--name-only"])
      : runGit(workDir, ["diff", "--cached", "--name-only"])
  )
    ?.replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => unquoteGitPath(s))
    .filter(Boolean) || [];

  const untrackedFiles = statusEntries
    .filter(({ xy }) => xy === "??")
    .map(({ filePath }) => filePath);

  const eligibleTracked = workingTrackedFiles.filter(
    (f) => !isNoisePath(f) && !isSecretPath(f),
  );
  const eligibleUntracked = untrackedFiles.filter(
    (f) => !isNoisePath(f) && !isSecretPath(f),
  );

  const fileDiffs = [];
  let diffModeLabel = "working-tree";

  if (eligibleTracked.length > 0 || eligibleUntracked.length > 0) {
    for (const relPath of eligibleTracked) {
      const diffArgs = head
        ? ["diff", "HEAD", "--no-ext-diff", "--", relPath]
        : ["diff", "--cached", "--no-ext-diff", "--", relPath];
      const rawDiff = runGit(workDir, diffArgs);
      if (rawDiff && rawDiff.trim()) {
        fileDiffs.push({ filePath: relPath, diff: redactSecrets(rawDiff.trim()) });
      }
    }
    for (const relPath of eligibleUntracked) {
      const pseudo = buildUntrackedPseudoDiff(workDir, relPath);
      if (pseudo) {
        fileDiffs.push({ filePath: relPath, diff: pseudo });
      }
    }
  } else if (validLastHead) {
    diffModeLabel = `${lastHead.slice(0, 8)}..HEAD`;
    const committedFiles = (
      runGit(workDir, ["diff", `${lastHead}..HEAD`, "--name-only"]) || ""
    )
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((s) => unquoteGitPath(s))
      .filter((f) => f && !isNoisePath(f) && !isSecretPath(f));

    for (const relPath of committedFiles) {
      const rawDiff = runGit(workDir, [
        "diff",
        `${lastHead}..HEAD`,
        "--no-ext-diff",
        "--",
        relPath,
      ]);
      if (rawDiff && rawDiff.trim()) {
        fileDiffs.push({ filePath: relPath, diff: redactSecrets(rawDiff.trim()) });
      }
    }
  }

  const diffStatRaw = head
    ? runGit(workDir, ["diff", "HEAD", "--stat"]) || ""
    : runGit(workDir, ["diff", "--cached", "--stat"]) || "";
  const diffStat = redactSecrets(diffStatRaw.trim());
  const diff = allocateFairShareDiffs(fileDiffs, DIFF_BUDGET_BYTES);

  const sections = [
    `Branch: ${branch}`,
    `HEAD: ${head || "(unborn)"}`,
  ];
  if (commitsSinceLastCapture) {
    sections.push(`Commits since last capture:\n${commitsSinceLastCapture}`);
  } else if (recentCommits) {
    sections.push(`Recent commits:\n${recentCommits}`);
  }
  sections.push(`Working tree status:\n${status || "(clean)"}`);
  if (diffStat) {
    sections.push(`Diff stat:\n${diffStat}`);
  }
  if (diff) {
    sections.push(`Diff (${diffModeLabel}, <=45KB fair-share):\n${diff}`);
  }

  const text = sections.join("\n\n");
  return {
    isGitRepo: true,
    branch,
    head,
    status,
    recentCommits,
    commitsSinceLastCapture,
    diffStat,
    diff,
    untrackedFiles,
    text,
    toString() {
      return this.text;
    },
  };
}

// ---------------------------------------------------------------------------
// Dynamic Transcript Budget & User-Intent-First Distillation
// ---------------------------------------------------------------------------

const TRANSCRIPT_STARTUP_MARKER = "[Handoff Context from HANDOFF.md]";
const TRANSCRIPT_COMMAND_MARKER = "[Handoff Command Instructions]";
const TRANSCRIPT_USER_MSG_MAX_BYTES = 4 * 1024;
const TRANSCRIPT_ASSISTANT_MSG_MAX_BYTES = 4 * 1024;
const TRANSCRIPT_FIRST_USER_MAX_BYTES = 2 * 1024;
const TRANSCRIPT_MIDDLE_USER_SHORT_BYTES = 300;
const TRANSCRIPT_PROSE_COLLAPSE_BYTES = 240;

const TRANSCRIPT_PATH_KEYS = new Set([
  "filePath",
  "file_path",
  "path",
  "target_file",
  "targetFile",
  "notebook_path",
  "destination",
]);

function truncateUtf8Text(text, maxBytes, suffix = "\n... [truncated]") {
  if (!text) return "";
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const target = Math.max(0, maxBytes - suffixBytes);
  if (target === 0) {
    let rawBuf = Buffer.from(suffix, "utf8").subarray(0, maxBytes);
    while (rawBuf.length > 0 && (rawBuf[rawBuf.length - 1] & 0b11000000) === 0b10000000) {
      rawBuf = rawBuf.subarray(0, rawBuf.length - 1);
    }
    if (rawBuf.length > 0 && rawBuf[rawBuf.length - 1] >= 0b11000000) {
      rawBuf = rawBuf.subarray(0, rawBuf.length - 1);
    }
    return rawBuf.toString("utf8");
  }

  let buf = Buffer.from(text, "utf8").subarray(0, target);
  while (buf.length > 0 && (buf[buf.length - 1] & 0b11000000) === 0b10000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  if (buf.length > 0 && buf[buf.length - 1] >= 0b11000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  return `${buf.toString("utf8")}${suffix}`;
}

export function calculateTranscriptBudget(gitContext) {
  let diffBytes = 0;
  if (gitContext && typeof gitContext === "object") {
    if (typeof gitContext.diff === "string" && gitContext.diff) {
      diffBytes = Buffer.byteLength(gitContext.diff, "utf8");
    }
  }
  const available = COMBINED_EVIDENCE_BUDGET_BYTES - diffBytes;
  return Math.max(
    TRANSCRIPT_MIN_BUDGET_BYTES,
    Math.min(TRANSCRIPT_MAX_BUDGET_BYTES, available),
  );
}

function collectTranscriptTouchedPaths(value, out, depth = 0) {
  if (!value || depth > 3 || out.size >= 24) return;
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectTranscriptTouchedPaths(item, out, depth + 1);
      }
      return;
    }
    for (const [key, val] of Object.entries(value)) {
      if (TRANSCRIPT_PATH_KEYS.has(key) && typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed && !/^https?:\/\//i.test(trimmed)) {
          out.add(trimmed);
        }
      } else if ((key === "files" || key === "paths") && Array.isArray(val)) {
        for (const entry of val) {
          if (typeof entry === "string" && entry.trim()) {
            out.add(entry.trim());
          } else {
            collectTranscriptTouchedPaths(entry, out, depth + 1);
          }
        }
      } else if (val && typeof val === "object") {
        collectTranscriptTouchedPaths(val, out, depth + 1);
      }
    }
  }
}

function stripLongCodeBlocks(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";
  let fenceOpenLine = "";
  let fenceBody = [];

  for (const line of lines) {
    if (!inFence) {
      const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        inFence = true;
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        fenceLang = (openMatch[2] || "").trim().split(/\s+/)[0] || "text";
        fenceOpenLine = line;
        fenceBody = [];
        continue;
      }
      out.push(line);
    } else {
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        if (fenceBody.length > 8) {
          out.push(`[code block omitted: ${fenceLang}, ${fenceBody.length} lines]`);
        } else {
          out.push(fenceOpenLine, ...fenceBody, line);
        }
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        fenceLang = "";
        fenceOpenLine = "";
        fenceBody = [];
      } else {
        fenceBody.push(line);
      }
    }
  }

  if (inFence) {
    if (fenceBody.length > 8) {
      out.push(`[code block omitted: ${fenceLang}, ${fenceBody.length} lines]`);
    } else {
      out.push(fenceOpenLine, ...fenceBody);
    }
  }

  return out.join("\n");
}

function collapseProseParagraph(proseLines) {
  const collapsed = proseLines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  if (Buffer.byteLength(collapsed, "utf8") <= TRANSCRIPT_PROSE_COLLAPSE_BYTES) {
    return collapsed;
  }
  const trailingQuestionMatch = collapsed.match(/([^.!?。！？\n]{4,180}[?？])\s*$/);
  if (trailingQuestionMatch) {
    const q = trailingQuestionMatch[1].trim();
    const qBytes = Buffer.byteLength(q, "utf8");
    const headBudget = Math.max(40, TRANSCRIPT_PROSE_COLLAPSE_BYTES - qBytes - 6);
    const head = truncateUtf8Text(collapsed.slice(0, collapsed.length - q.length).trim(), headBudget, "...");
    return `${head} ${q}`;
  }
  return truncateUtf8Text(collapsed, TRANSCRIPT_PROSE_COLLAPSE_BYTES, "...");
}

function distillAssistantText(text) {
  if (!text) return "";
  const withoutLongCode = stripLongCodeBlocks(text);
  const lines = withoutLongCode.split("\n");
  const out = [];
  let proseBuf = [];
  let inShortFence = false;
  let shortFenceChar = "";
  let shortFenceLen = 0;
  let lastWasList = false;

  const flushProse = () => {
    if (proseBuf.length === 0) return;
    const collapsed = collapseProseParagraph(proseBuf);
    if (collapsed) out.push(collapsed);
    proseBuf = [];
  };

  for (const line of lines) {
    if (inShortFence) {
      out.push(line);
      const closeRe = new RegExp(`^\\s*${shortFenceChar}{${shortFenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        inShortFence = false;
        shortFenceChar = "";
        shortFenceLen = 0;
      }
      continue;
    }

    const fenceOpen = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceOpen) {
      flushProse();
      lastWasList = false;
      inShortFence = true;
      shortFenceChar = fenceOpen[1][0];
      shortFenceLen = fenceOpen[1].length;
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushProse();
      lastWasList = false;
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      continue;
    }

    const isHeading = /^#{1,6}\s+\S/.test(trimmed);
    const isList = /^(?:[-*+]|\d+\.)\s+\S/.test(trimmed);
    const isListContinuation = lastWasList && /^\s{2,}\S/.test(line);
    const hasBold = /\*\*[^*\n]+\*\*/.test(trimmed);
    const isQuestion = /[?？]\s*$/.test(trimmed);
    const isOmittedMarker = /^\[code block omitted:/.test(trimmed);
    const isFilesTouched = /^\[files touched:/.test(trimmed);

    if (
      isHeading ||
      isList ||
      isListContinuation ||
      hasBold ||
      isQuestion ||
      isOmittedMarker ||
      isFilesTouched
    ) {
      flushProse();
      out.push(isHeading || isOmittedMarker || isFilesTouched ? trimmed : line.trimEnd());
      lastWasList = isList || isListContinuation;
      continue;
    }

    lastWasList = false;
    proseBuf.push(trimmed);
  }

  flushProse();
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTranscriptEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    const trimmed = rawEntry.trim();
    if (
      !trimmed ||
      trimmed.startsWith(TRANSCRIPT_STARTUP_MARKER) ||
      trimmed.startsWith(TRANSCRIPT_COMMAND_MARKER)
    ) {
      return null;
    }
    return {
      role: "entry",
      text: `[entry]: ${truncateUtf8Text(redactSecrets(trimmed), TRANSCRIPT_ASSISTANT_MSG_MAX_BYTES)}`,
    };
  }
  if (!rawEntry || typeof rawEntry !== "object") return null;

  const hasMessageObj =
    rawEntry.message && typeof rawEntry.message === "object";
  const entry = hasMessageObj ? rawEntry.message : rawEntry;
  const info =
    entry.info && typeof entry.info === "object"
      ? entry.info
      : rawEntry.info && typeof rawEntry.info === "object"
        ? rawEntry.info
        : null;

  if (
    entry.customType === "handoff-context" ||
    rawEntry.customType === "handoff-context"
  ) {
    return null;
  }

  const rawType = String(rawEntry.type ?? "").trim().toLowerCase();
  if (
    [
      "system",
      "summary",
      "file-history-snapshot",
      "compaction",
      "branch_summary",
      "thinking_level_change",
      "model_change",
      "session",
      "progress",
    ].includes(rawType)
  ) {
    return null;
  }
  if (
    rawType &&
    !["message", "custom_message", "user", "assistant", "model", "entry"].includes(rawType) &&
    !entry.role &&
    !info?.role
  ) {
    return null;
  }

  let role = String(
    info?.role ??
      entry.role ??
      (rawType === "custom_message" ? "custom" : rawType || "message"),
  )
    .trim()
    .toLowerCase();

  if (role === "model") role = "assistant";
  if (role === "system") return null;
  if (role === "toolresult" && !entry.isError) return null;

  const textChunks = [];
  const touchedPaths = new Set();

  const blocks = Array.isArray(entry.parts)
    ? entry.parts
    : Array.isArray(info?.parts)
      ? info.parts
      : Array.isArray(entry.content)
        ? entry.content
        : Array.isArray(info?.content)
          ? info.content
          : null;

  if (blocks) {
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block === "string") {
        const trimmed = block.trim();
        if (
          trimmed &&
          !trimmed.startsWith(TRANSCRIPT_STARTUP_MARKER) &&
          !trimmed.startsWith(TRANSCRIPT_COMMAND_MARKER)
        ) {
          textChunks.push(trimmed);
        }
        continue;
      }
      if (typeof block !== "object") continue;

      const bType = String(block.type ?? "").toLowerCase();
      if (bType === "text" || (!bType && typeof block.text === "string")) {
        const txt = typeof block.text === "string" ? block.text.trim() : "";
        if (
          txt &&
          !txt.startsWith(TRANSCRIPT_STARTUP_MARKER) &&
          !txt.startsWith(TRANSCRIPT_COMMAND_MARKER)
        ) {
          textChunks.push(txt);
        }
        continue;
      }

      if (
        bType === "tool" ||
        bType === "tool-invocation" ||
        bType === "tool_use" ||
        bType === "tool-call" ||
        bType === "toolcall" ||
        bType === "tool_call"
      ) {
        collectTranscriptTouchedPaths(block.state?.input, touchedPaths);
        collectTranscriptTouchedPaths(block.input, touchedPaths);
        collectTranscriptTouchedPaths(block.args, touchedPaths);
        collectTranscriptTouchedPaths(block.arguments, touchedPaths);
        collectTranscriptTouchedPaths(block.toolInvocation?.args, touchedPaths);
      }
    }
  } else {
    const rawText =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.text === "string"
          ? entry.text
          : typeof info?.content === "string"
            ? info.content
            : typeof info?.text === "string"
              ? info.text
              : "";
    const trimmed = rawText.trim();
    if (
      trimmed &&
      !trimmed.startsWith(TRANSCRIPT_STARTUP_MARKER) &&
      !trimmed.startsWith(TRANSCRIPT_COMMAND_MARKER)
    ) {
      textChunks.push(trimmed);
    }
  }

  if (Array.isArray(entry.toolCalls)) {
    collectTranscriptTouchedPaths(entry.toolCalls, touchedPaths);
  }

  const rawBody = redactSecrets(textChunks.join("\n").trim());
  const bodyText =
    role === "user"
      ? truncateUtf8Text(rawBody, TRANSCRIPT_USER_MSG_MAX_BYTES)
      : truncateUtf8Text(
          distillAssistantText(rawBody),
          TRANSCRIPT_ASSISTANT_MSG_MAX_BYTES,
        );

  const filesNote =
    touchedPaths.size > 0
      ? `[files touched: ${[...touchedPaths].join(", ")}]`
      : "";

  if (!bodyText && !filesNote) return null;
  const combined = [bodyText, filesNote].filter(Boolean).join("\n");
  return {
    role,
    text: `[${role}]: ${combined}`,
  };
}

function packDistilledItems(items, maxBytes) {
  if (!Array.isArray(items) || items.length === 0 || maxBytes <= 0) return "";

  const full = items.map((item) => item.text).join("\n\n");
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }

  const marker = "... [earlier messages omitted]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const firstUserIdx = items.findIndex((item) => item.role === "user");
  const chosenText = new Map();

  if (firstUserIdx !== -1) {
    const pinnedCap = Math.min(
      TRANSCRIPT_FIRST_USER_MAX_BYTES,
      Math.max(128, Math.floor(maxBytes / 3)),
    );
    chosenText.set(firstUserIdx, truncateUtf8Text(items[firstUserIdx].text, pinnedCap));
  }

  const startIdx = firstUserIdx !== -1 ? firstUserIdx + 1 : 0;
  const pinnedBytes =
    firstUserIdx !== -1
      ? Buffer.byteLength(chosenText.get(firstUserIdx), "utf8") + 2
      : 0;
  const remainingAfterPinned = Math.max(0, maxBytes - pinnedBytes);

  // Reserve marker overhead for gaps between pinned first / middle / tail
  const maxMarkerReserve = Math.min(remainingAfterPinned, (markerBytes + 4) * 2);
  const usableBudget = Math.max(0, remainingAfterPinned - maxMarkerReserve);
  const tailBudgetTarget = Math.floor(usableBudget * 0.55);

  let tailBytesUsed = 0;
  let tailStartIdx = items.length;
  for (let i = items.length - 1; i >= startIdx; i--) {
    const candidate = items[i].text;
    const sep = tailStartIdx < items.length ? 2 : 0;
    const cost = Buffer.byteLength(candidate, "utf8") + sep;
    if (tailBytesUsed + cost <= tailBudgetTarget) {
      chosenText.set(i, candidate);
      tailBytesUsed += cost;
      tailStartIdx = i;
    } else if (tailStartIdx === items.length && usableBudget > 0) {
      const cap = Math.max(0, Math.min(usableBudget, tailBudgetTarget || usableBudget));
      if (cap > 0) {
        chosenText.set(i, truncateUtf8Text(candidate, cap));
        tailBytesUsed += Buffer.byteLength(chosenText.get(i), "utf8");
        tailStartIdx = i;
      }
      break;
    } else {
      break;
    }
  }

  let middleBudget = Math.max(0, usableBudget - tailBytesUsed);
  const middleUserIndices = [];
  for (let i = startIdx; i < tailStartIdx; i++) {
    if (items[i].role === "user") {
      middleUserIndices.push(i);
    }
  }

  if (middleUserIndices.length > 0 && middleBudget > 0) {
    const fullMiddleCost = middleUserIndices.reduce(
      (sum, idx, pos) =>
        sum + Buffer.byteLength(items[idx].text, "utf8") + (pos > 0 ? 2 : 0),
      0,
    );

    if (fullMiddleCost <= middleBudget) {
      for (const idx of middleUserIndices) {
        chosenText.set(idx, items[idx].text);
      }
      middleBudget -= fullMiddleCost + 2;
    } else {
      const shortened = middleUserIndices.map((idx) => ({
        idx,
        text: truncateUtf8Text(
          items[idx].text,
          TRANSCRIPT_MIDDLE_USER_SHORT_BYTES,
          "...",
        ),
      }));
      const shortenedCost = shortened.reduce(
        (sum, entry, pos) =>
          sum + Buffer.byteLength(entry.text, "utf8") + (pos > 0 ? 2 : 0),
        0,
      );

      if (shortenedCost <= middleBudget) {
        for (const entry of shortened) {
          chosenText.set(entry.idx, entry.text);
        }
        middleBudget -= shortenedCost + 2;
      } else {
        // Sample evenly across middle user turns to preserve intent trajectory
        let used = 0;
        const picked = [];
        const step = Math.max(
          1,
          Math.ceil(shortenedCost / Math.max(1, middleBudget)),
        );
        for (let k = 0; k < shortened.length; k += step) {
          const entry = shortened[k];
          const sep = picked.length > 0 ? 2 : 0;
          const cost = Buffer.byteLength(entry.text, "utf8") + sep;
          if (used + cost <= middleBudget) {
            picked.push(entry);
            used += cost;
          }
        }
        // Fill any remaining middle budget with unpicked user turns
        if (used < middleBudget) {
          const pickedSet = new Set(picked.map((p) => p.idx));
          for (const entry of shortened) {
            if (pickedSet.has(entry.idx)) continue;
            const sep = picked.length > 0 ? 2 : 0;
            const cost = Buffer.byteLength(entry.text, "utf8") + sep;
            if (used + cost <= middleBudget) {
              picked.push(entry);
              pickedSet.add(entry.idx);
              used += cost;
            }
          }
        }
        for (const entry of picked) {
          chosenText.set(entry.idx, entry.text);
        }
        if (picked.length > 0) {
          middleBudget = Math.max(0, middleBudget - used - 2);
        }
      }
    }
  }

  // Fill any remaining budget from the most recent unselected turns backward
  for (let i = tailStartIdx - 1; i >= startIdx && middleBudget > 0; i--) {
    if (chosenText.has(i)) continue;
    const candidate = items[i].text;
    const cost = Buffer.byteLength(candidate, "utf8") + 2;
    if (cost <= middleBudget) {
      chosenText.set(i, candidate);
      middleBudget -= cost;
    }
  }

  const orderedIndices = [...chosenText.keys()].sort((a, b) => a - b);
  const segments = [];
  for (let k = 0; k < orderedIndices.length; k++) {
    const idx = orderedIndices[k];
    if (k === 0 && idx > 0) {
      segments.push(marker);
    } else if (k > 0 && idx > orderedIndices[k - 1] + 1) {
      segments.push(marker);
    }
    segments.push(chosenText.get(idx));
  }

  const assembled = segments.join("\n\n");
  return truncateUtf8Text(assembled, maxBytes);
}

function repackDistilledTranscript(transcriptText, maxBytes) {
  if (!transcriptText || Buffer.byteLength(transcriptText, "utf8") <= maxBytes) {
    return transcriptText || "";
  }
  const chunks = transcriptText
    .split(/\n\n(?=\[(?:user|assistant|model|custom|entry|message)\]:)/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length >= 2) {
    const items = chunks.map((chunk) => {
      const m = chunk.match(/^\[([a-z0-9_-]+)\]:/i);
      const role = m ? m[1].toLowerCase() : "message";
      return { role: role === "model" ? "assistant" : role, text: chunk };
    });
    return packDistilledItems(items, maxBytes);
  }
  return truncateUtf8Text(transcriptText, maxBytes, "\n... [transcript truncated]");
}

export function distillTranscriptEntries(
  entries,
  maxBytes = TRANSCRIPT_MAX_BUDGET_BYTES,
) {
  if (!Array.isArray(entries) || entries.length === 0 || maxBytes <= 0) {
    return "";
  }
  const items = [];
  for (const raw of entries) {
    const norm = normalizeTranscriptEntry(raw);
    if (norm) items.push(norm);
  }
  return packDistilledItems(items, maxBytes);
}

// ---------------------------------------------------------------------------
// Prompt Construction & LLM Output Parsing
// ---------------------------------------------------------------------------

export function detectDiscussionMode(gitContext) {
  if (!gitContext) return true;
  if (typeof gitContext === "string") {
    const trimmed = gitContext.trim();
    if (!trimmed || trimmed.includes("(not a git repository)")) return true;
    return (
      trimmed.includes("Working tree status:\n(clean)") &&
      !trimmed.includes("Diff (")
    );
  }
  return (
    !gitContext.status &&
    !gitContext.diff &&
    (!gitContext.untrackedFiles || gitContext.untrackedFiles.length === 0)
  );
}

export function buildCapturePrompt({
  existingHandoff = "",
  gitContext = "",
  transcriptText = "",
  agentName = "agent",
} = {}) {
  const gitSection =
    typeof gitContext === "string"
      ? gitContext
      : gitContext?.text || "(no git context)";
  const isDiscussionMode = detectDiscussionMode(gitContext);
  const transcriptBudget =
    gitContext && typeof gitContext === "object"
      ? calculateTranscriptBudget(gitContext)
      : TRANSCRIPT_MAX_BYTES;

  const safeHandoff = redactSecrets(existingHandoff || "(none)");
  const safeTranscript = transcriptText
    ? repackDistilledTranscript(redactSecrets(transcriptText), transcriptBudget)
    : "(no transcript available)";

  const modeGuidance = isDiscussionMode
    ? `Mode: Design / Planning / Research Discussion Mode (zero uncommitted or new git changes detected).
Focus on extracting high-signal planning, architecture, and research state from the session transcript:
- current_status.done: Aligned design conclusions, researched files/modules (cite \`path:line\` or symbol names), and settled questions.
- current_status.in_progress: Topics still under active discussion, design exploration, or investigation.
- current_status.next: Concrete next alignment decision or first implementation step to execute.
- new_decisions: Every agreed design choice, constraint, user preference, and rejected alternatives with rationale ("Chose X over Y because Z").
- new_gotchas: Architectural constraints, invariants, or edge cases uncovered during research.
- open_questions: Unresolved questions, open tradeoffs, or items awaiting user confirmation (return [] if all resolved).`
    : `Mode: Code & Implementation Mode.
Focus on extracting code progress, architectural decisions, and remaining verification steps:
- current_status.done: Completed changes, verified checks, and settled items.
- current_status.in_progress: Active/unfinished work in progress.
- current_status.next: Single concrete, actionable next step for the next agent to execute.
- new_decisions: New design choices with rationale and rejected alternatives ("Chose X over Y because Z").
- new_gotchas: Non-obvious traps, dead ends, failed approaches, or environment constraints discovered.
- open_questions: Any unresolved questions, open tradeoffs, or items awaiting user confirmation (return [] if none).`;

  return `You are updating a project's cross-agent HANDOFF.md document for session continuity (capturing from agent: ${agentName}).

${modeGuidance}

Analyze the existing HANDOFF.md, git repository state, and session transcript below, then return ONLY a single valid JSON object matching this exact schema (no prose outside JSON, no markdown code fences):

{
  "current_status": {
    "done": ["Completed item 1", "Completed item 2"],
    "in_progress": ["Active/unfinished item 1"],
    "next": "Single concrete, actionable next step for the next agent to execute"
  },
  "new_decisions": [
    "Decision summary including rationale and any rejected alternatives (do NOT prefix with date)"
  ],
  "new_gotchas": [
    "Non-obvious trap, dead end, failed approach, or environment constraint discovered"
  ],
  "open_questions": [
    "Unresolved question, open tradeoff, or item awaiting user confirmation"
  ]
}

Strict rules:
1. Language preservation: Use the exact same human language as the conversation transcript or existing HANDOFF.md (e.g., keep Chinese if Chinese, English if English).
2. Concise, specific bullets: Keep each bullet to 1-2 crisp sentences citing exact file paths, functions, or commands where relevant.
3. Current status: Carry forward still-relevant items from the existing HANDOFF.md, promote completed items from in_progress to done, and ensure "next" is a non-empty string naming the immediate next task.
4. Decisions & gotchas (append-only deltas): Return ONLY new decisions and new gotchas not already listed in existing Decision log or Gotchas / constraints. Record dead ends and rejected approaches ("Tried X, failed/rejected because Y") so the next agent does not repeat mistakes. Do NOT prefix dates on new_decisions.
5. Open questions (current snapshot): Return ONLY currently unresolved questions/tradeoffs/confirmations. Omit resolved questions so the section stays clean.
6. Secret safety: Never output API keys, tokens, passwords, or private credentials.

<existing_handoff>
${safeHandoff}
</existing_handoff>

<git_context>
${gitSection}
</git_context>

<session_transcript>
${safeTranscript}
</session_transcript>`;
}

function extractBalancedJsonObjects(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return candidates;
}

function cleanBulletItem(item) {
  if (typeof item !== "string") return "";
  return item
    .trim()
    .replace(/^[-*+]\s+/, "")
    .trim();
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(cleanBulletItem)
    .filter((s) => s.length > 0 && !/^\(none(\s+yet)?\)$/i.test(s));
}

export function parseLLMResult(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("Empty LLM response");
  }

  const attempts = [rawText.trim()];

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(rawText)) !== null) {
    if (fenceMatch[1]?.trim()) {
      attempts.push(fenceMatch[1].trim());
    }
  }

  for (const candidate of extractBalancedJsonObjects(rawText)) {
    attempts.push(candidate);
  }

  let parsed = null;
  let lastParseErr = null;
  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj;
        if (obj.current_status) break;
      }
    } catch (err) {
      lastParseErr = err;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Failed to parse JSON from LLM output${lastParseErr ? `: ${lastParseErr.message}` : ""}`,
    );
  }

  const cs = parsed.current_status;
  if (!cs || typeof cs !== "object" || Array.isArray(cs)) {
    throw new Error("Invalid LLM result: missing current_status object");
  }

  let nextStr = "";
  if (typeof cs.next === "string") {
    nextStr = cleanBulletItem(cs.next);
  } else if (Array.isArray(cs.next)) {
    nextStr = normalizeStringArray(cs.next).join("; ");
  }

  if (!nextStr) {
    throw new Error(
      "Invalid LLM result: current_status.next must be a non-empty string",
    );
  }

  return {
    current_status: {
      done: normalizeStringArray(cs.done),
      in_progress: normalizeStringArray(cs.in_progress),
      next: nextStr,
    },
    new_decisions: normalizeStringArray(parsed.new_decisions),
    new_gotchas: normalizeStringArray(parsed.new_gotchas),
    open_questions: normalizeStringArray(parsed.open_questions),
  };
}

// ---------------------------------------------------------------------------
// Deduplication & Surgical Markdown Splicer
// ---------------------------------------------------------------------------

function normalizeBulletForComparison(text) {
  if (typeof text !== "string") return "";
  return text
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s*:\s*/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeBullet(normalized) {
  if (!normalized) return new Set();
  const tokens = new Set();
  for (const part of normalized.split(" ")) {
    if (!part) continue;
    // Handle CJK sequences without spaces using character bigrams
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part)) {
      if (part.length === 1) {
        tokens.add(part);
      } else {
        for (let i = 0; i < part.length - 1; i++) {
          tokens.add(part.slice(i, i + 2));
        }
      }
      continue;
    }
    if (part.length < 2 || STOP_WORDS.has(part)) continue;
    tokens.add(part);
  }
  return tokens;
}

export function similarBullets(a, b) {
  const normA = normalizeBulletForComparison(a);
  const normB = normalizeBulletForComparison(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const setA = tokenizeBullet(normA);
  const setB = tokenizeBullet(normB);
  const minSize = Math.min(setA.size, setB.size);
  if (minSize === 0) return false;

  let overlap = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  for (const tok of smaller) {
    if (larger.has(tok)) overlap++;
  }

  return overlap / minSize >= 0.6;
}

function scanH2Sections(content) {
  const sections = [];
  let inFence = false;
  let fenceMarker = "";
  let inHtmlComment = false;

  let lineStart = 0;
  while (lineStart < content.length) {
    let lineEnd = content.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = content.length;
    else lineEnd += 1;

    const rawLine = content.slice(lineStart, lineEnd);
    const trimmedLine = rawLine.replace(/\r?\n$/, "");

    if (!inHtmlComment) {
      const fenceMatch = trimmedLine.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
          fenceMarker = "";
        }
        lineStart = lineEnd;
        continue;
      }
    }

    if (!inFence) {
      if (!inHtmlComment && /^##[ \t]+(.+?)[ \t]*$/.test(trimmedLine)) {
        const heading = trimmedLine.replace(/^##[ \t]+/, "").trim();
        sections.push({
          heading,
          norm: heading.toLowerCase().replace(/\s+/g, " "),
          start: lineStart,
          end: content.length,
        });
      }

      let scanIdx = 0;
      while (scanIdx < trimmedLine.length) {
        if (!inHtmlComment) {
          const openIdx = trimmedLine.indexOf("<!--", scanIdx);
          if (openIdx === -1) break;
          inHtmlComment = true;
          scanIdx = openIdx + 4;
        } else {
          const closeIdx = trimmedLine.indexOf("-->", scanIdx);
          if (closeIdx === -1) break;
          inHtmlComment = false;
          scanIdx = closeIdx + 3;
        }
      }
    }

    lineStart = lineEnd;
  }

  for (let i = 0; i < sections.length - 1; i++) {
    sections[i].end = sections[i + 1].start;
  }

  return sections;
}

function extractExistingBullets(sectionSlice) {
  const withoutComments = sectionSlice.replace(/<!--[\s\S]*?-->/g, "");
  const bullets = [];
  for (const line of withoutComments.replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[1].trim();
    if (/^\(none(\s+yet)?\)$/i.test(text)) continue;
    bullets.push(text);
  }
  return bullets;
}

function renderCurrentStatusSection(currentStatus, eol, isLastSection) {
  const doneLines =
    currentStatus.done.length > 0
      ? currentStatus.done.map((item) => `- ${item}`)
      : ["- (none)"];
  const inProgressLines =
    currentStatus.in_progress.length > 0
      ? currentStatus.in_progress.map((item) => `- ${item}`)
      : ["- (none)"];
  const nextLine = `- ${currentStatus.next}`;

  const body = [
    "## Current status",
    "",
    "**Done**",
    ...doneLines,
    "",
    "**In progress**",
    ...inProgressLines,
    "",
    "**Next**",
    nextLine,
  ].join(eol);

  return isLastSection ? `${body}${eol}` : `${body}${eol}${eol}`;
}

function renderOpenQuestionsSection(openQuestions, eol, isLastSection) {
  const lines =
    openQuestions && openQuestions.length > 0
      ? openQuestions.map((item) => `- ${item}`)
      : ["- (none)"];

  const body = ["## Open questions", "", ...lines].join(eol);
  return isLastSection ? `${body}${eol}` : `${body}${eol}${eol}`;
}

function appendDeduplicatedBullets(
  sectionSlice,
  incomingItems,
  { datePrefix = null, eol = "\n", isLastSection = false } = {},
) {
  if (!incomingItems || incomingItems.length === 0) {
    return sectionSlice;
  }

  const existingBullets = extractExistingBullets(sectionSlice);
  const allSeen = [...existingBullets];
  const formattedToAdd = [];

  for (const rawItem of incomingItems) {
    let clean = cleanBulletItem(rawItem);
    if (datePrefix) {
      clean = clean.replace(/^\d{4}-\d{2}-\d{2}\s*:\s*/, "").trim();
    }
    if (!clean) continue;
    if (allSeen.some((prev) => similarBullets(prev, clean))) {
      continue;
    }
    allSeen.push(clean);
    formattedToAdd.push(datePrefix ? `- ${datePrefix}: ${clean}` : `- ${clean}`);
  }

  if (formattedToAdd.length === 0) {
    return sectionSlice;
  }

  let trimmed = sectionSlice
    .replace(/^[ \t]*[-*+][ \t]+\(none(?:\s+yet)?\)[ \t]*\r?\n?/gim, "")
    .replace(/\s+$/, "");

  const lastLine = trimmed.split(/\r?\n/).pop() || "";
  const endsWithBullet = /^\s*[-*+]\s+/.test(lastLine);
  const joiner = endsWithBullet ? eol : `${eol}${eol}`;
  const tail = isLastSection ? eol : `${eol}${eol}`;

  return `${trimmed}${joiner}${formattedToAdd.join(eol)}${tail}`;
}

export function applyUpdate(existingContent, parsedResult, meta = {}) {
  const baseContent =
    typeof existingContent === "string" && existingContent.trim()
      ? existingContent
      : DEFAULT_TEMPLATE;
  const validated =
    parsedResult?.current_status && typeof parsedResult.current_status.next === "string"
      ? {
          current_status: {
            done: normalizeStringArray(parsedResult.current_status.done),
            in_progress: normalizeStringArray(parsedResult.current_status.in_progress),
            next: cleanBulletItem(parsedResult.current_status.next),
          },
          new_decisions: normalizeStringArray(parsedResult.new_decisions),
          new_gotchas: normalizeStringArray(parsedResult.new_gotchas),
          open_questions: normalizeStringArray(parsedResult.open_questions),
        }
      : parseLLMResult(JSON.stringify(parsedResult));

  const eol = baseContent.includes("\r\n") ? "\r\n" : "\n";
  const timestamp = meta.timestamp || new Date().toISOString();
  const dateObj = new Date(timestamp);
  const datePrefix = Number.isNaN(dateObj.getTime())
    ? new Date().toISOString().slice(0, 10)
    : dateObj.toISOString().slice(0, 10);
  const agentName = meta.agentName || meta.agent || "handoff";
  const trigger = meta.trigger || "manual";
  const updatedLine = `> Last updated: ${timestamp} (via ${agentName} · ${trigger})`;

  const sections = scanH2Sections(baseContent);
  const firstSectionStart =
    sections.length > 0 ? sections[0].start : baseContent.length;
  let preamble = baseContent.slice(0, firstSectionStart);

  if (/^>[ \t]*Last updated:.*$/m.test(preamble)) {
    preamble = preamble.replace(/^>[ \t]*Last updated:.*$/m, updatedLine);
  } else if (/^#[ \t]+.+$/m.test(preamble)) {
    preamble = preamble.replace(
      /^(#[ \t]+.+?)(\r?\n)/m,
      `$1$2${eol}${updatedLine}$2`,
    );
  } else {
    preamble = `# Handoff${eol}${eol}${updatedLine}${eol}${eol}${preamble}`;
  }

  let sawCurrentStatus = false;
  let sawDecisions = false;
  let sawGotchas = false;
  let sawOpenQuestions = false;

  const renderedSections = sections.map((sec, idx) => {
    const rawSlice = baseContent.slice(sec.start, sec.end);
    const isLast = idx === sections.length - 1;

    if (sec.norm === "current status") {
      sawCurrentStatus = true;
      return renderCurrentStatusSection(validated.current_status, eol, isLast);
    }
    if (sec.norm === "decision log") {
      sawDecisions = true;
      return appendDeduplicatedBullets(rawSlice, validated.new_decisions, {
        datePrefix,
        eol,
        isLastSection: isLast,
      });
    }
    if (
      sec.norm === "gotchas / constraints" ||
      sec.norm === "gotchas/constraints" ||
      sec.norm === "gotchas"
    ) {
      sawGotchas = true;
      return appendDeduplicatedBullets(rawSlice, validated.new_gotchas, {
        datePrefix: null,
        eol,
        isLastSection: isLast,
      });
    }
    if (sec.norm === "open questions" || sec.norm === "open question") {
      sawOpenQuestions = true;
      return renderOpenQuestionsSection(validated.open_questions, eol, isLast);
    }
    // Preserve ## Overview, ## Commands, and any custom sections byte-for-byte
    return rawSlice;
  });

  const missingBlocks = [];
  if (!sawCurrentStatus) {
    missingBlocks.push(
      renderCurrentStatusSection(validated.current_status, eol, false),
    );
  }
  if (!sawDecisions) {
    missingBlocks.push(
      appendDeduplicatedBullets(
        `## Decision log${eol}${eol}`,
        validated.new_decisions,
        { datePrefix, eol, isLastSection: false },
      ),
    );
  }
  if (!sawGotchas) {
    missingBlocks.push(
      appendDeduplicatedBullets(
        `## Gotchas / constraints${eol}${eol}`,
        validated.new_gotchas,
        { datePrefix: null, eol, isLastSection: false },
      ),
    );
  }
  if (!sawOpenQuestions && validated.open_questions.length > 0) {
    missingBlocks.push(
      renderOpenQuestionsSection(validated.open_questions, eol, false),
    );
  }

  if (missingBlocks.length > 0) {
    const commandsIdx = sections.findIndex((s) => s.norm === "commands");
    if (commandsIdx !== -1) {
      renderedSections.splice(commandsIdx, 0, ...missingBlocks);
    } else {
      if (
        renderedSections.length > 0 &&
        !renderedSections[renderedSections.length - 1].endsWith(`${eol}${eol}`)
      ) {
        renderedSections[renderedSections.length - 1] =
          `${renderedSections[renderedSections.length - 1].replace(/\s+$/, "")}${eol}${eol}`;
      }
      renderedSections.push(...missingBlocks);
      renderedSections[renderedSections.length - 1] =
        `${renderedSections[renderedSections.length - 1].replace(/\s+$/, "")}${eol}`;
    }
  }

  return `${preamble}${renderedSections.join("")}`;
}

// ---------------------------------------------------------------------------
// Startup Context & Rolling-Window Formatter
// ---------------------------------------------------------------------------

function stripHtmlComments(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasNonEmptySectionBody(cleanedSection) {
  if (!cleanedSection) return false;
  return cleanedSection
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !/^[-*+]\s+\(none(?:\s+yet)?\)$/i.test(trimmed);
    });
}

function extractBulletLines(cleanedSection) {
  const lines = cleanedSection.replace(/\r\n/g, "\n").split("\n").slice(1);
  const bullets = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (m) {
      const text = m[1].trim();
      if (text && !/^\(none(\s+yet)?\)$/i.test(text)) {
        bullets.push(`- ${text}`);
      }
      continue;
    }
    if (bullets.length > 0 && /^\s{2,}\S/.test(line)) {
      bullets[bullets.length - 1] += `\n${line.trimEnd()}`;
    }
  }
  return bullets;
}

function formatBoundedCurrentStatus(cleanedStatus, handoffPath, maxStatusBullets) {
  const lines = cleanedStatus.replace(/\r\n/g, "\n").split("\n");
  const hasBuckets = lines.some((l) => /^\*\*(Done|In progress|Next)\*\*/i.test(l.trim()));
  if (!hasBuckets) {
    return cleanedStatus;
  }

  let bucket = null;
  const doneBullets = [];
  const inProgressBullets = [];
  const nextBullets = [];
  let sawDone = false;
  let sawInProgress = false;
  let sawNext = false;

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (/^\*\*Done\*\*/i.test(trimmed)) {
      bucket = "done";
      sawDone = true;
      continue;
    }
    if (/^\*\*In progress\*\*/i.test(trimmed)) {
      bucket = "in_progress";
      sawInProgress = true;
      continue;
    }
    if (/^\*\*Next\*\*/i.test(trimmed)) {
      bucket = "next";
      sawNext = true;
      continue;
    }
    const m = trimmed.match(/^[-*+]\s+(.+)$/);
    if (m && bucket) {
      const val = m[1].trim();
      if (bucket === "done") doneBullets.push(val);
      else if (bucket === "in_progress") inProgressBullets.push(val);
      else if (bucket === "next") nextBullets.push(val);
    }
  }

  const realDone = doneBullets.filter((b) => !/^\(none(?:\s+yet)?\)$/i.test(b));
  const out = ["## Current status"];

  if (sawDone || realDone.length > 0) {
    out.push("", "**Done**");
    if (realDone.length === 0) {
      out.push("- (none)");
    } else if (realDone.length > maxStatusBullets) {
      const omitted = realDone.length - maxStatusBullets;
      out.push(
        `- (... ${omitted} older entries omitted; read ${handoffPath} for full history)`,
      );
      for (const item of realDone.slice(-maxStatusBullets)) {
        out.push(`- ${item}`);
      }
    } else {
      for (const item of realDone) {
        out.push(`- ${item}`);
      }
    }
  }

  if (sawInProgress || inProgressBullets.length > 0) {
    out.push("", "**In progress**");
    if (inProgressBullets.length === 0) {
      out.push("- (none)");
    } else {
      for (const item of inProgressBullets) {
        out.push(`- ${item}`);
      }
    }
  }

  if (sawNext || nextBullets.length > 0) {
    out.push("", "**Next**");
    if (nextBullets.length === 0) {
      out.push("- (none)");
    } else {
      for (const item of nextBullets) {
        out.push(`- ${item}`);
      }
    }
  }

  return out.join("\n");
}

function formatRollingWindowSection(
  heading,
  rawSlice,
  handoffPath,
  maxItems,
  { includeWhenEmpty = false } = {},
) {
  if (!rawSlice) {
    return includeWhenEmpty ? `${heading}\n\n- (none)` : null;
  }
  const cleaned = stripHtmlComments(rawSlice);
  const bullets = extractBulletLines(cleaned);
  if (bullets.length > 0) {
    if (bullets.length > maxItems) {
      const omitted = bullets.length - maxItems;
      const kept = bullets.slice(-maxItems);
      return [
        heading,
        "",
        `- (... ${omitted} older entries omitted; read ${handoffPath} for full history)`,
        ...kept,
      ].join("\n");
    }
    return [heading, "", ...bullets].join("\n");
  }
  if (hasNonEmptySectionBody(cleaned)) {
    return cleaned;
  }
  return includeWhenEmpty ? `${heading}\n\n- (none)` : null;
}

function formatBoundedHandoff(
  handoffPath,
  handoffContent,
  {
    maxDecisions = 15,
    maxGotchas = 15,
    maxOpenQuestions = 15,
    maxStatusBullets = 15,
    header = `# Handoff (${handoffPath})`,
    intro = null,
    includeEmptyGotchas = false,
    footer = `Use this state to continue work. Read ${handoffPath} directly if you need earlier decision history.`,
  } = {},
) {
  if (typeof handoffContent !== "string" || !handoffContent.trim()) {
    return "";
  }

  const content = handoffContent.replace(/\r\n/g, "\n");
  const lastUpdatedMatch = content.match(/^>[ \t]*Last updated:[ \t]*(.+)$/m);
  const lastUpdatedVal = lastUpdatedMatch ? lastUpdatedMatch[1].trim() : null;

  const sections = scanH2Sections(content);
  const overviewSec = sections.find((s) => s.norm === "overview");
  const currentStatusSec = sections.find((s) => s.norm === "current status");
  const decisionsSec = sections.find((s) => s.norm === "decision log");
  const gotchasSec = sections.find(
    (s) =>
      s.norm === "gotchas / constraints" ||
      s.norm === "gotchas/constraints" ||
      s.norm === "gotchas",
  );
  const openQuestionsSec = sections.find(
    (s) => s.norm === "open questions" || s.norm === "open question",
  );
  const commandsSec = sections.find((s) => s.norm === "commands");

  const parts = [header];
  if (intro) {
    parts.push("", intro);
  }
  if (lastUpdatedVal) {
    parts.push("", `> Last updated: ${lastUpdatedVal}`);
  }

  if (overviewSec) {
    const cleanedOverview = stripHtmlComments(
      content.slice(overviewSec.start, overviewSec.end),
    );
    if (hasNonEmptySectionBody(cleanedOverview)) {
      parts.push("", cleanedOverview);
    }
  }

  if (currentStatusSec) {
    const cleanedStatus = stripHtmlComments(
      content.slice(currentStatusSec.start, currentStatusSec.end),
    );
    if (cleanedStatus) {
      parts.push(
        "",
        formatBoundedCurrentStatus(cleanedStatus, handoffPath, maxStatusBullets),
      );
    }
  }

  if (decisionsSec) {
    const decisionsBlock = formatRollingWindowSection(
      "## Decision log",
      content.slice(decisionsSec.start, decisionsSec.end),
      handoffPath,
      maxDecisions,
    );
    if (decisionsBlock) {
      parts.push("", decisionsBlock);
    }
  }

  const gotchasBlock = formatRollingWindowSection(
    "## Gotchas / constraints",
    gotchasSec ? content.slice(gotchasSec.start, gotchasSec.end) : null,
    handoffPath,
    maxGotchas,
    { includeWhenEmpty: includeEmptyGotchas },
  );
  if (gotchasBlock) {
    parts.push("", gotchasBlock);
  }

  if (openQuestionsSec) {
    const openQuestionsBlock = formatRollingWindowSection(
      "## Open questions",
      content.slice(openQuestionsSec.start, openQuestionsSec.end),
      handoffPath,
      maxOpenQuestions,
    );
    if (openQuestionsBlock) {
      parts.push("", openQuestionsBlock);
    }
  }

  if (commandsSec) {
    const cleanedCommands = stripHtmlComments(
      content.slice(commandsSec.start, commandsSec.end),
    );
    if (hasNonEmptySectionBody(cleanedCommands)) {
      parts.push("", cleanedCommands);
    }
  }

  if (footer) {
    parts.push("", footer);
  }

  return `${parts.join("\n")}\n`;
}

export function buildCompactSummaryFromHandoff(
  handoffPath,
  handoffContent,
  options = {},
) {
  const maxDecisions = clampInt(options.maxDecisions, 1, 1000, 15);
  const maxGotchas = clampInt(options.maxGotchas, 1, 1000, 15);
  const maxOpenQuestions = clampInt(options.maxOpenQuestions, 1, 1000, 15);
  const maxStatusBullets = clampInt(options.maxStatusBullets, 1, 1000, 15);
  const resolvedPath = handoffPath || "HANDOFF.md";

  const formatted = formatBoundedHandoff(resolvedPath, handoffContent, {
    maxDecisions,
    maxGotchas,
    maxOpenQuestions,
    maxStatusBullets,
    header: "# Handoff & Compaction Summary (from HANDOFF.md)",
    intro: `The project's \`HANDOFF.md\` (${resolvedPath}) was automatically updated before compaction and serves as the authoritative continuation state:`,
    includeEmptyGotchas: false,
    footer: `Use this state to continue work. Read ${resolvedPath} directly if you need full history or earlier decisions.`,
  });

  return formatted.trim();
}

export function extractStartupContext(cwd) {
  const targetDir = path.resolve(cwd || process.cwd());
  const handoffPath = path.join(targetDir, "HANDOFF.md");
  if (!fs.existsSync(handoffPath)) {
    return null;
  }

  let content;
  try {
    content = fs.readFileSync(handoffPath, "utf8");
  } catch {
    return null;
  }

  const lastUpdatedMatch = content.match(/^>[ \t]*Last updated:[ \t]*(.+)$/m);
  if (!lastUpdatedMatch) {
    return null;
  }
  const lastUpdatedVal = lastUpdatedMatch[1].trim();
  if (!lastUpdatedVal || /^never$/i.test(lastUpdatedVal)) {
    return null;
  }

  return formatBoundedHandoff(handoffPath, content, {
    maxDecisions: 10,
    maxGotchas: 15,
    maxOpenQuestions: 15,
    maxStatusBullets: 15,
    header: `# Handoff (${handoffPath})`,
    intro: null,
    includeEmptyGotchas: true,
    footer: `Use this state to continue work. Read ${handoffPath} directly if you need earlier decision history.`,
  });
}

// ---------------------------------------------------------------------------
// Standalone Capture Orchestration (LLM Runner + Deterministic Fallback)
// ---------------------------------------------------------------------------

function extractCurrentStatusFromMarkdown(existingHandoff) {
  const sections = scanH2Sections(existingHandoff || "");
  const sec = sections.find((s) => s.norm === "current status");
  if (!sec) return { done: [], in_progress: [], next: "" };

  const slice = existingHandoff.slice(sec.start, sec.end);
  let bucket = null;
  const out = { done: [], in_progress: [], next: "" };

  for (const line of slice.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (/^\*\*Done\*\*/i.test(trimmed)) {
      bucket = "done";
      continue;
    }
    if (/^\*\*In progress\*\*/i.test(trimmed)) {
      bucket = "in_progress";
      continue;
    }
    if (/^\*\*Next\*\*/i.test(trimmed)) {
      bucket = "next";
      continue;
    }
    const m = trimmed.match(/^[-*+]\s+(.+)$/);
    if (m && bucket) {
      const val = m[1].trim();
      if (/^\(none(\s+yet)?\)$/i.test(val)) continue;
      if (bucket === "next") {
        if (!out.next) out.next = val;
      } else {
        out[bucket].push(val);
      }
    }
  }
  return out;
}

function extractOpenQuestionsFromMarkdown(existingHandoff) {
  const sections = scanH2Sections(existingHandoff || "");
  const sec = sections.find(
    (s) => s.norm === "open questions" || s.norm === "open question",
  );
  if (!sec) return [];
  return extractExistingBullets(existingHandoff.slice(sec.start, sec.end));
}

function parseTranscriptTurns(transcriptText) {
  if (!transcriptText || typeof transcriptText !== "string") return [];
  const trimmed = transcriptText.trim();
  if (!trimmed) return [];

  const chunks = trimmed
    .split(/\n\n(?=\[[a-z0-9_-]+\]:)/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const turns = [];
  for (const chunk of chunks) {
    const m = chunk.match(/^\[([a-z0-9_-]+)\]:\s*([\s\S]*)$/i);
    if (m) {
      turns.push({
        role: m[1].toLowerCase() === "model" ? "assistant" : m[1].toLowerCase(),
        body: m[2].trim(),
      });
    } else {
      turns.push({ role: "entry", body: chunk });
    }
  }
  return turns;
}

function isIgnorableTranscriptLine(line) {
  if (!line) return true;
  if (/^\.{3}\s*\[/.test(line)) return true;
  if (/^\[(?:files touched|code block omitted|truncated)/i.test(line)) return true;
  if (/^(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^[-*_]{3,}$/.test(line)) return true;
  return false;
}

function extractFirstMeaningfulLine(body) {
  if (!body) return "";
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim().replace(/^#+\s+/, "").replace(/^[-*+]\s+/, "").trim();
    if (!line || isIgnorableTranscriptLine(line)) continue;
    return line;
  }
  return "";
}

function extractDiscussionQuestions(turns) {
  const questions = [];
  // Scan from most recent turns backward (focusing on tail discussion)
  const recentTurns = turns.slice(-8);
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const turn = recentTurns[i];
    if (turn.role !== "assistant" && turn.role !== "user") continue;
    let inFence = false;
    const lines = turn.body.replace(/\r\n/g, "\n").split("\n");
    for (let j = lines.length - 1; j >= 0; j--) {
      const trimmed = lines[j].trim();
      if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || isIgnorableTranscriptLine(trimmed)) continue;
      if (!/[?？]\s*$/.test(trimmed)) continue;
      const cleaned = trimmed
        .replace(/^(?:[-*+]|\d+\.)\s+/, "")
        .replace(/^#+\s+/, "")
        .replace(/\*\*/g, "")
        .trim();
      if (cleaned.length < 8 || /^https?:\/\//i.test(cleaned)) continue;
      if (!questions.some((q) => similarBullets(q, cleaned))) {
        questions.push(cleaned.slice(0, 200));
      }
      if (questions.length >= 5) return questions;
    }
  }
  return questions;
}

function buildDeterministicResult({
  existingHandoff = "",
  gitContext = null,
  transcriptText = "",
}) {
  const prev = extractCurrentStatusFromMarkdown(existingHandoff);
  const done = [...prev.done];
  const inProgress = [];
  const isDiscussionMode = detectDiscussionMode(gitContext);
  const turns = parseTranscriptTurns(transcriptText);
  const userTopics = turns
    .filter((t) => t.role === "user")
    .map((t) => extractFirstMeaningfulLine(t.body))
    .filter(Boolean);
  const firstUserTopic = userTopics[0] || "";
  const latestUserTopic = userTopics[userTopics.length - 1] || "";
  const questionCandidates = extractDiscussionQuestions(turns);

  const commitsRaw =
    gitContext?.commitsSinceLastCapture || gitContext?.recentCommits || "";
  const commitLines = commitsRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5);
  for (const c of commitLines) {
    const bullet = `Commit ${c}`;
    if (!done.some((d) => similarBullets(d, bullet))) {
      done.push(bullet);
    }
  }

  const statusLines = (gitContext?.status || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (statusLines.length > 0) {
    const sampleFiles = statusLines
      .slice(0, 6)
      .map((l) => l.replace(/^\S+\s+/, "").replace(/\s+\[secret.*\]$/, ""));
    const suffix =
      statusLines.length > 6 ? ` (+${statusLines.length - 6} more)` : "";
    inProgress.push(
      `Uncommitted changes in ${sampleFiles.join(", ")}${suffix}`,
    );
  } else if (isDiscussionMode && userTopics.length > 0) {
    const topicSummary =
      firstUserTopic && latestUserTopic && !similarBullets(firstUserTopic, latestUserTopic)
        ? `Discussion: ${firstUserTopic.slice(0, 80)} (latest: ${latestUserTopic.slice(0, 80)})`
        : `Discussion: ${(latestUserTopic || firstUserTopic).slice(0, 140)}`;
    inProgress.push(topicSummary);
    for (const item of prev.in_progress) {
      if (!inProgress.some((p) => similarBullets(p, item))) {
        inProgress.push(item);
      }
    }
  } else if (prev.in_progress.length > 0) {
    inProgress.push(...prev.in_progress);
  }

  let next = prev.next || "";
  if (inProgress.length > 0 && statusLines.length > 0) {
    if (!next) {
      next = `Verify and complete work in ${statusLines[0].replace(/^\S+\s+/, "")}`;
    }
  } else if (isDiscussionMode && transcriptText && transcriptText.trim()) {
    if (questionCandidates.length > 0) {
      next = `Resolve open question and confirm next step: ${questionCandidates[0].slice(0, 140)}`;
    } else if (latestUserTopic) {
      next = `Continue discussion or execute next step for: ${latestUserTopic.slice(0, 140)}`;
    } else if (!next) {
      next = "Review HANDOFF.md and continue next planned task";
    }
  } else if (!next) {
    if (latestUserTopic) {
      next = `Continue from latest session context: ${latestUserTopic.slice(0, 140)}`;
    } else if (transcriptText && transcriptText.trim()) {
      const lastLine = transcriptText
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !isIgnorableTranscriptLine(l))
        .pop();
      next = lastLine
        ? `Continue from latest session context: ${lastLine.slice(0, 120)}`
        : "Review HANDOFF.md and continue next planned task";
    } else {
      next = "Review recent commits and continue next planned task";
    }
  }

  const openQuestions =
    questionCandidates.length > 0
      ? questionCandidates
      : !transcriptText || !transcriptText.trim()
        ? extractOpenQuestionsFromMarkdown(existingHandoff)
        : [];

  return {
    current_status: {
      done: done.slice(-12),
      in_progress: inProgress.slice(0, 8),
      next,
    },
    new_decisions: [],
    new_gotchas: [],
    open_questions: openQuestions.slice(0, 8),
  };
}

function findExecutable(name) {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(finder, [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (res.status === 0 && res.stdout?.trim()) {
    return res.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

function defaultExternalLLMRunner(prompt, { cwd, config }) {
  if (process.env.HANDOFF_DISABLE_EXTERNAL_LLM === "1") {
    return null;
  }

  const childEnv = {
    ...process.env,
    HANDOFF_CAPTURE_ACTIVE: "1",
  };

  // 1. Explicit user command override via HANDOFF_LLM_CMD
  if (process.env.HANDOFF_LLM_CMD) {
    const res = spawnSync(process.env.HANDOFF_LLM_CMD, {
      cwd,
      input: prompt,
      shell: true,
      encoding: "utf8",
      env: childEnv,
      timeout: 45000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status === 0 && res.stdout?.trim()) {
      return res.stdout;
    }
  }

  const modelArgs =
    config?.model && config.model !== "current" ? ["--model", config.model] : [];

  // 2. opencode non-interactive fallback
  const opencodeBin = findExecutable("opencode");
  if (opencodeBin) {
    const res = spawnSync(
      opencodeBin,
      ["run", ...modelArgs, prompt],
      {
        cwd,
        encoding: "utf8",
        env: childEnv,
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (res.status === 0 && res.stdout?.trim()) {
      return res.stdout;
    }
  }

  // 3. pi non-interactive ephemeral mode without tools
  const piBin = findExecutable("pi");
  if (piBin) {
    const res = spawnSync(
      piBin,
      ["-p", "--no-session", "--no-tools", ...modelArgs, prompt],
      {
        cwd,
        encoding: "utf8",
        env: childEnv,
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (res.status === 0 && res.stdout?.trim()) {
      return res.stdout;
    }
  }

  // 4. claude non-interactive print mode fallback
  const claudeBin = findExecutable("claude");
  if (claudeBin) {
    const res = spawnSync(
      claudeBin,
      ["-p", "--output-format", "text", ...modelArgs],
      {
        cwd,
        input: prompt,
        encoding: "utf8",
        env: childEnv,
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (res.status === 0 && res.stdout?.trim()) {
      return res.stdout;
    }
  }

  return null;
}

export function resolveStateFilePath(cwd) {
  const targetDir = path.resolve(cwd || process.cwd());
  const gitInfo = resolveGitInfo(targetDir);
  if (gitInfo) {
    return path.join(gitInfo.gitDir, "info", "handoff.state.json");
  }
  const dirHash = crypto
    .createHash("sha256")
    .update(targetDir)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `handoff.state.${dirHash}.json`);
}

export function readCaptureState(cwd) {
  const statePath = resolveStateFilePath(cwd);
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

export async function runStandaloneCapture({
  cwd = process.cwd(),
  trigger = "manual",
  agentName = "standalone",
  transcriptText = "",
  transcriptEntries = null,
  llmRunner = undefined,
  skipIfUnchanged = false,
  config: configOverride = null,
} = {}) {
  const targetDir = path.resolve(cwd);
  const config = configOverride || loadConfig();
  const { path: handoffPath } = ensureHandoffFile(targetDir, { config });
  const statePath = resolveStateFilePath(targetDir);
  const prevState = readCaptureState(targetDir);
  const currentSignal = computeGitSignal(targetDir);

  const hasRawTranscript =
    (typeof transcriptText === "string" && Boolean(transcriptText.trim())) ||
    (Array.isArray(transcriptEntries) && transcriptEntries.length > 0);

  if (
    skipIfUnchanged &&
    currentSignal &&
    prevState?.lastSignal === currentSignal &&
    !hasRawTranscript
  ) {
    return {
      skipped: true,
      handoffPath,
      statePath,
      signal: currentSignal,
      head: prevState?.lastHead || null,
      usedFallback: false,
    };
  }

  const existingHandoff = fs.readFileSync(handoffPath, "utf8");
  const gitContext = gatherGitContext(targetDir, prevState?.lastHead || null);
  const transcriptBudget = calculateTranscriptBudget(gitContext);
  const distilledFromEntries =
    Array.isArray(transcriptEntries) && transcriptEntries.length > 0
      ? distillTranscriptEntries(transcriptEntries, transcriptBudget)
      : "";
  const effectiveTranscriptText =
    distilledFromEntries ||
    (typeof transcriptText === "string" ? transcriptText : "");

  if (
    skipIfUnchanged &&
    currentSignal &&
    prevState?.lastSignal === currentSignal &&
    !effectiveTranscriptText.trim()
  ) {
    return {
      skipped: true,
      handoffPath,
      statePath,
      signal: currentSignal,
      head: prevState?.lastHead || null,
      usedFallback: false,
    };
  }

  const prompt = buildCapturePrompt({
    existingHandoff,
    gitContext,
    transcriptText: effectiveTranscriptText,
    agentName,
  });

  let parsedResult = null;
  let usedFallback = false;

  if (typeof llmRunner === "function") {
    try {
      const raw = await llmRunner(prompt);
      parsedResult =
        raw && typeof raw === "object"
          ? parseLLMResult(JSON.stringify(raw))
          : parseLLMResult(String(raw ?? ""));
    } catch {
      usedFallback = true;
    }
  } else if (llmRunner !== false) {
    try {
      const raw = defaultExternalLLMRunner(prompt, { cwd: targetDir, config });
      if (raw) {
        parsedResult = parseLLMResult(raw);
      } else {
        usedFallback = true;
      }
    } catch {
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (!parsedResult) {
    usedFallback = true;
    parsedResult = parseLLMResult(
      JSON.stringify(
        buildDeterministicResult({
          existingHandoff,
          gitContext,
          transcriptText: effectiveTranscriptText,
        }),
      ),
    );
  }

  const timestamp = new Date().toISOString();
  const updatedContent = applyUpdate(existingHandoff, parsedResult, {
    timestamp,
    agentName,
    trigger,
  });

  atomicWriteFileSync(handoffPath, updatedContent);

  const nextSignal = computeGitSignal(targetDir) ?? currentSignal;
  const nextState = {
    lastCapturedAt: timestamp,
    lastHead: gitContext.head || null,
    lastSignal: nextSignal,
    lastAgent: agentName,
    lastTrigger: trigger,
    usedFallback,
  };
  atomicWriteFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);

  return {
    skipped: false,
    handoffPath,
    statePath,
    updatedContent,
    parsedResult,
    usedFallback,
    signal: nextSignal,
    head: gitContext.head || null,
  };
}
