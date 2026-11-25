import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DIFF_BUDGET_BYTES,
  TRANSCRIPT_MAX_BUDGET_BYTES,
  TRANSCRIPT_MIN_BUDGET_BYTES,
  applyUpdate,
  buildCapturePrompt,
  buildCompactSummaryFromHandoff,
  calculateTranscriptBudget,
  computeGitSignal,
  detectDiscussionMode,
  distillTranscriptEntries,
  ensureGitExclude,
  ensureHandoffFile,
  extractStartupContext,
  gatherGitContext,
  isNoisePath,
  isSecretPath,
  loadConfig,
  parseLLMResult,
  redactSecrets,
  runStandaloneCapture,
  saveConfig,
  similarBullets,
} from "../scripts/handoff-core.mjs";

function createTempGitRepo(prefix = "handoff-core-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: dir,
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(dir, "README.md"), "# Sample Repo\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit"], {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}

test("loadConfig returns defaults when missing and saveConfig syncs opencode.json compaction trigger", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-sync-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const configPath = path.join(tmpDir, "handoff", "config.json");
  const openCodeConfigPath = path.join(tmpDir, "opencode", "opencode.jsonc");
  fs.mkdirSync(path.dirname(openCodeConfigPath), { recursive: true });
  fs.writeFileSync(
    openCodeConfigPath,
    `{
      // existing JSONC comment
      "model": "anthropic/claude-sonnet-4-5",
      "compaction": {
        "auto": true,
      },
    }\n`,
    "utf8",
  );

  const defaults = loadConfig({ configPath });
  assert.equal(defaults.trigger.mode, "percentage");
  assert.equal(defaults.trigger.percentage, 50);
  assert.equal(defaults.trigger.tokens, 100000);

  const saved = saveConfig(
    { trigger: { mode: "percentage", percentage: 65 } },
    { configPath, openCodeConfigPath },
  );
  assert.equal(saved.trigger.percentage, 65);

  const ocParsed = JSON.parse(fs.readFileSync(openCodeConfigPath, "utf8"));
  assert.equal(ocParsed.model, "anthropic/claude-sonnet-4-5");
  assert.equal(ocParsed.compaction.auto, true);
  assert.deepEqual(ocParsed.compaction.trigger, {
    mode: "percentage",
    value: 65,
  });

  saveConfig(
    { trigger: { mode: "tokens", tokens: 90000 } },
    { configPath, openCodeConfigPath },
  );
  const ocTokens = JSON.parse(fs.readFileSync(openCodeConfigPath, "utf8"));
  assert.deepEqual(ocTokens.compaction.trigger, {
    mode: "tokens",
    value: 90000,
  });
});

test("ensureHandoffFile creates template and configures .git/info/exclude without duplicating entries", (t) => {
  const repoDir = createTempGitRepo("handoff-init-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const first = ensureHandoffFile(repoDir, {
    config: { autoExcludeGit: true },
  });
  assert.equal(first.created, true);
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(first.exclude.updated, true);

  const excludeTxt = fs.readFileSync(first.exclude.excludePath, "utf8");
  assert.match(excludeTxt, /^HANDOFF\.md$/m);
  assert.match(excludeTxt, /^\.claude\/handoff\.state\.json$/m);
  assert.match(excludeTxt, /^\.opencode\/handoff\.state\.json$/m);
  assert.match(excludeTxt, /^\.gemini\/handoff\.state\.json$/m);

  // Second call is idempotent
  const second = ensureGitExclude(repoDir, {
    config: { autoExcludeGit: true },
  });
  assert.equal(second.updated, false);
  assert.deepEqual(second.added, []);
});

test("isSecretPath, isNoisePath, and redactSecrets filter sensitive paths and tokens", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath(".env.production"), true);
  assert.equal(isSecretPath(".env.example"), false);
  assert.equal(isSecretPath("keys/id_ed25519"), true);
  assert.equal(isSecretPath("certs/server.pem"), true);
  assert.equal(isNoisePath("package-lock.json"), true);
  assert.equal(isNoisePath("node_modules/pkg/index.js"), true);
  assert.equal(isNoisePath("HANDOFF.md"), true);
  assert.equal(isNoisePath("src/index.ts"), false);

  const raw = [
    "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop",
    "GH=ghp_1234567890abcdefghijklmnop",
    "AWS=AKIAIOSFODNN7EXAMPLE",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
  ].join("\n");
  const redacted = redactSecrets(raw);
  assert.equal(redacted.includes("sk-1234567890"), false);
  assert.equal(redacted.includes("ghp_1234567890"), false);
  assert.equal(redacted.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.match(redacted, /\[REDACTED_API_KEY\]/);
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(redacted, /\[REDACTED_AWS_KEY\]/);
});

test("gatherGitContext respects 45 KB fair-share diff budget and omits secret file diffs", (t) => {
  const repoDir = createTempGitRepo("handoff-git-ctx-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(repoDir, ".env"),
    "API_SECRET=super_secret_value_123456\n",
    "utf8",
  );
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "src", "small.ts"),
    "export const small = 1;\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "large.ts"),
    `// large file\n${"export const line = '0123456789abcdef';\n".repeat(2500)}`,
    "utf8",
  );

  const ctx = gatherGitContext(repoDir);
  assert.equal(ctx.isGitRepo, true);
  assert.match(ctx.status, /\.env \[secret file - diff omitted\]/);
  assert.equal(ctx.diff.includes("super_secret_value_123456"), false);
  assert.match(ctx.diff, /src\/small\.ts/);
  assert.match(ctx.diff, /src\/large\.ts/);
  assert.ok(Buffer.byteLength(ctx.diff, "utf8") <= DIFF_BUDGET_BYTES);
});

test("parseLLMResult extracts JSON from fenced or prose responses and validates required fields", () => {
  const fenced = `Here is the updated state:
\`\`\`json
{
  "current_status": {
    "done": ["- Built core module"],
    "in_progress": ["Testing parser"],
    "next": "Run test suite"
  },
  "new_decisions": ["Use ESM with zero dependencies"],
  "new_gotchas": []
}
\`\`\`
Hope that helps!`;

  const parsed = parseLLMResult(fenced);
  assert.deepEqual(parsed.current_status.done, ["Built core module"]);
  assert.deepEqual(parsed.current_status.in_progress, ["Testing parser"]);
  assert.equal(parsed.current_status.next, "Run test suite");
  assert.deepEqual(parsed.new_decisions, ["Use ESM with zero dependencies"]);
  assert.deepEqual(parsed.new_gotchas, []);

  assert.throws(() => parseLLMResult("{}"), /missing current_status/);
  assert.throws(
    () =>
      parseLLMResult(
        JSON.stringify({ current_status: { done: [], in_progress: [], next: "" } }),
      ),
    /non-empty string/,
  );
});

test("applyUpdate preserves Overview, Commands, and custom sections while deduplicating EN + CJK bullets", () => {
  const initial = `# Handoff

> Last updated: 2026-11-20T10:00:00.000Z (via pi · manual)

## Overview

Custom project overview that must stay byte-for-byte identical.

## Current status

**Done**
- Old item

**In progress**
- Active item

**Next**
- Old next

## Decision log

- 2026-11-20: Use zero-dependency ESM modules in scripts/handoff-core.mjs
- 2026-11-20: 使用滚动窗口限制上下文注入大小

## Gotchas / constraints

- Never modify tracked .gitignore files

## Commands

- \`npm test\`

## Custom notes

Keep this custom section untouched!
`;

  const updated = applyUpdate(
    initial,
    {
      current_status: {
        done: ["Old item", "Active item"],
        in_progress: ["Writing integration tests"],
        next: "Publish v0.1.0",
      },
      new_decisions: [
        "Use zero-dependency ESM modules in scripts/handoff-core.mjs",
        "使用滚动窗口限制上下文注入大小",
        "Add turn-boundary compaction deferral in extensions",
      ],
      new_gotchas: [
        "Never modify tracked .gitignore files",
        "Avoid top-level await in extension entrypoints for jiti compatibility",
      ],
    },
    {
      timestamp: "2026-11-25T15:30:00.000Z",
      agentName: "opencode",
      trigger: "auto",
    },
  );

  assert.match(
    updated,
    /^> Last updated: 2026-11-25T15:30:00\.000Z \(via opencode · auto\)$/m,
  );
  assert.match(
    updated,
    /Custom project overview that must stay byte-for-byte identical\./,
  );
  assert.match(updated, /- `npm test`/);
  assert.match(updated, /Keep this custom section untouched!/);

  // Duplicates skipped, new entries appended with date prefix on Decision log
  const decisionMatches = updated.match(/Use zero-dependency ESM modules/g) || [];
  assert.equal(decisionMatches.length, 1);
  const cjkMatches = updated.match(/使用滚动窗口限制上下文注入大小/g) || [];
  assert.equal(cjkMatches.length, 1);
  assert.match(
    updated,
    /^- 2026-11-25: Add turn-boundary compaction deferral in extensions$/m,
  );

  const gotchaMatches = updated.match(/Never modify tracked \.gitignore/g) || [];
  assert.equal(gotchaMatches.length, 1);
  assert.match(updated, /^- Avoid top-level await in extension entrypoints/m);

  assert.equal(
    similarBullets(
      "2026-11-20: Store handoff state under .git/info/handoff.state.json",
      "Store handoff state under .git/info/handoff.state.json",
    ),
    true,
  );
});

test("runStandaloneCapture handles custom llmRunner, deterministic fallback, and skipIfUnchanged", async (t) => {
  const repoDir = createTempGitRepo("handoff-capture-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cap-cfg-"));
  const prevCfg = process.env.HANDOFF_CONFIG_PATH;
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
  process.env.HANDOFF_CONFIG_PATH = path.join(cfgDir, "config.json");
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1";

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH;
    else process.env.HANDOFF_CONFIG_PATH = prevCfg;
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('hi');\n", "utf8");

  // 1. Deterministic fallback when external LLM is disabled
  const res1 = await runStandaloneCapture({
    cwd: repoDir,
    trigger: "manual",
    agentName: "cli",
  });
  assert.equal(res1.skipped, false);
  assert.equal(res1.usedFallback, true);
  assert.match(res1.updatedContent, /app\.js/);

  // 2. skipIfUnchanged skips when signal matches and transcript is empty
  const sigBefore = computeGitSignal(repoDir);
  assert.ok(sigBefore);
  const res2 = await runStandaloneCapture({
    cwd: repoDir,
    trigger: "session-end",
    agentName: "cli",
    skipIfUnchanged: true,
  });
  assert.equal(res2.skipped, true);

  // 3. Custom llmRunner populates structured result and buildCapturePrompt embeds git + transcript
  let capturedPrompt = "";
  const res3 = await runStandaloneCapture({
    cwd: repoDir,
    trigger: "auto",
    agentName: "opencode",
    transcriptText: "[user]: Fix app.js startup",
    llmRunner: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        current_status: {
          done: ["Verified app.js startup"],
          in_progress: [],
          next: "Add unit test for app.js",
        },
        new_decisions: ["Keep app.js minimal"],
        new_gotchas: [],
      });
    },
  });
  assert.equal(res3.usedFallback, false);
  assert.match(capturedPrompt, /Fix app\.js startup/);
  assert.match(res3.updatedContent, /Add unit test for app\.js/);

  const summary = buildCompactSummaryFromHandoff(res3.handoffPath, res3.updatedContent);
  assert.match(summary, /^# Handoff & Compaction Summary/);
  const startup = extractStartupContext(repoDir);
  assert.match(startup, /Add unit test for app\.js/);
  assert.ok(buildCapturePrompt({ agentName: "pi" }).includes("agent: pi"));
});

test("calculateTranscriptBudget scales dynamically between 12 KB and 48 KB based on diff size", () => {
  assert.equal(calculateTranscriptBudget(null), TRANSCRIPT_MAX_BUDGET_BYTES);
  assert.equal(calculateTranscriptBudget({ diff: "" }), TRANSCRIPT_MAX_BUDGET_BYTES);
  assert.equal(
    calculateTranscriptBudget({ diff: "x".repeat(20 * 1024) }),
    37 * 1024,
  );
  assert.equal(
    calculateTranscriptBudget({ diff: "x".repeat(DIFF_BUDGET_BYTES) }),
    TRANSCRIPT_MIN_BUDGET_BYTES,
  );
  assert.equal(
    calculateTranscriptBudget({ diff: "x".repeat(60 * 1024) }),
    TRANSCRIPT_MIN_BUDGET_BYTES,
  );
});

test("distillTranscriptEntries strips >8-line code blocks, keeps short fences, preserves user intent trajectory, and redacts secrets", () => {
  const longCode = [
    "```ts",
    ...Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`),
    "```",
  ].join("\n");
  const shortCode = ["```bash", "npm test", "```"].join("\n");

  const entries = [
    { role: "system", content: "You are a system prompt" },
    { customType: "handoff-context", role: "user", content: "Old injected handoff" },
    { role: "user", content: "[Handoff Context from HANDOFF.md]\nOld startup context" },
    {
      role: "user",
      content: "初始设计目标：设计纯讨论模式下的 Handoff 压缩机制 with key sk-1234567890abcdefghijklmnop",
    },
    {
      role: "assistant",
      content: [
        "### Architecture Proposal",
        "",
        "This is a verbose introductory paragraph explaining background rationale. ".repeat(12),
        "",
        "**Conclusion**: Use 48 KB dynamic transcript budget when git diff is empty.",
        "",
        longCode,
        "",
        shortCode,
        "",
        "- Should we also strip code fences longer than 8 lines?",
      ].join("\n"),
      toolCalls: [{ name: "read", arguments: { filePath: "scripts/handoff-core.mjs" } }],
    },
  ];

  // Add middle user turns and bulky assistant turns to force packing under a tight 3.5 KB cap
  for (let i = 1; i <= 6; i++) {
    entries.push({
      role: "user",
      content: `User intent checkpoint #${i}: confirm constraint alpha-${i}`,
    });
    entries.push({
      role: "assistant",
      content: `Detailed analysis #${i}: ${"长段中文讨论与分析内容 ".repeat(60)}\n- Key takeaway ${i}`,
    });
  }
  entries.push({
    role: "user",
    content: "Final question: should Open questions be regenerated on each capture?",
  });

  const fullDistilled = distillTranscriptEntries(entries, 48 * 1024);
  assert.equal(fullDistilled.includes("You are a system prompt"), false);
  assert.equal(fullDistilled.includes("Old injected handoff"), false);
  assert.equal(fullDistilled.includes("Old startup context"), false);
  assert.equal(fullDistilled.includes("sk-1234567890"), false);
  assert.match(fullDistilled, /\[REDACTED_API_KEY\]/);
  assert.match(fullDistilled, /\[code block omitted: ts, 12 lines\]/);
  assert.match(fullDistilled, /npm test/);
  assert.match(fullDistilled, /### Architecture Proposal/);
  assert.match(fullDistilled, /\*\*Conclusion\*\*: Use 48 KB dynamic transcript budget/);
  assert.match(fullDistilled, /\[files touched: scripts\/handoff-core\.mjs\]/);

  const packed = distillTranscriptEntries(entries, 3500);
  assert.ok(Buffer.byteLength(packed, "utf8") <= 3500);
  assert.equal(packed.includes("\uFFFD"), false);
  assert.match(packed, /初始设计目标/);
  assert.match(packed, /User intent checkpoint #1/);
  assert.match(packed, /Final question: should Open questions/);
});

test("open_questions flows through parseLLMResult, applyUpdate, buildCompactSummaryFromHandoff, and extractStartupContext", (t) => {
  const repoDir = createTempGitRepo("handoff-open-q-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const parsed = parseLLMResult(
    JSON.stringify({
      current_status: {
        done: ["Aligned on WebSocket heartbeat design"],
        in_progress: ["Evaluating reconnect backoff"],
        next: "Confirm jitter factor before implementing reconnect loop",
      },
      new_decisions: ["Use 30s ping/pong heartbeat interval"],
      new_gotchas: [],
      open_questions: [
        "- Should reconnect backoff cap at 30s or 60s?",
        "Should stale subscriptions replay missed events?",
      ],
    }),
  );
  assert.deepEqual(parsed.open_questions, [
    "Should reconnect backoff cap at 30s or 60s?",
    "Should stale subscriptions replay missed events?",
  ]);

  // Existing HANDOFF.md without ## Open questions gets it inserted before ## Commands
  const legacyHandoff = `# Handoff

> Last updated: 2026-11-20T10:00:00.000Z (via opencode · manual)

## Overview

Realtime broker.

## Current status

**Done**
- Initial scaffold

**In progress**
- (none)

**Next**
- Design heartbeat

## Decision log

<!-- Append-only -->

## Gotchas / constraints

<!-- Append-only -->

## Commands

- \`npm test\`
`;

  const withQuestions = applyUpdate(legacyHandoff, parsed, {
    timestamp: "2026-11-26T09:00:00.000Z",
    agentName: "opencode",
    trigger: "auto",
  });
  const handoffPath = path.join(repoDir, "HANDOFF.md");
  fs.writeFileSync(handoffPath, withQuestions, "utf8");

  const openQIdx = withQuestions.indexOf("## Open questions");
  const cmdIdx = withQuestions.indexOf("## Commands");
  assert.ok(openQIdx !== -1 && cmdIdx !== -1 && openQIdx < cmdIdx);
  assert.match(withQuestions, /- Should reconnect backoff cap at 30s or 60s\?/);

  const summaryWithQ = buildCompactSummaryFromHandoff(handoffPath, withQuestions);
  assert.match(summaryWithQ, /## Open questions/);
  assert.match(summaryWithQ, /Should stale subscriptions replay missed events\?/);

  const startupWithQ = extractStartupContext(repoDir);
  assert.match(startupWithQ, /## Open questions/);
  assert.match(startupWithQ, /Should reconnect backoff cap at 30s or 60s\?/);

  // Next capture resolves all open questions -> ## Open questions resets to - (none) and is omitted from bounded summaries
  const resolved = applyUpdate(
    withQuestions,
    {
      current_status: {
        done: ["Aligned on WebSocket heartbeat design", "Settled backoff cap at 60s"],
        in_progress: [],
        next: "Implement reconnect backoff in src/ws/client.ts",
      },
      new_decisions: ["Cap reconnect backoff at 60s with full jitter"],
      new_gotchas: [],
      open_questions: [],
    },
    {
      timestamp: "2026-11-26T10:00:00.000Z",
      agentName: "pi",
      trigger: "manual",
    },
  );
  fs.writeFileSync(handoffPath, resolved, "utf8");
  assert.match(resolved, /## Open questions\n\n- \(none\)/);
  assert.equal(resolved.includes("Should reconnect backoff cap at 30s or 60s?"), false);

  const summaryResolved = buildCompactSummaryFromHandoff(handoffPath, resolved);
  assert.equal(summaryResolved.includes("## Open questions"), false);
  const startupResolved = extractStartupContext(repoDir);
  assert.equal(startupResolved.includes("## Open questions"), false);
});

test("buildCapturePrompt switches between Discussion Mode and Code Mode, and runStandaloneCapture handles transcriptEntries + discussion fallback", async (t) => {
  const repoDir = createTempGitRepo("handoff-discussion-cap-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-disc-cfg-"));
  const prevCfg = process.env.HANDOFF_CONFIG_PATH;
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
  process.env.HANDOFF_CONFIG_PATH = path.join(cfgDir, "config.json");
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1";

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH;
    else process.env.HANDOFF_CONFIG_PATH = prevCfg;
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  const cleanGit = gatherGitContext(repoDir);
  assert.equal(detectDiscussionMode(cleanGit), true);
  assert.equal(detectDiscussionMode("(not a git repository)"), true);

  const discussionPrompt = buildCapturePrompt({
    gitContext: cleanGit,
    transcriptText: "[user]: Let's plan the plugin migration",
    agentName: "opencode",
  });
  assert.match(discussionPrompt, /Design \/ Planning \/ Research Discussion Mode/);
  assert.match(discussionPrompt, /"open_questions"/);

  // Build > 14 KB transcript entries across multiple turns in clean repo (budget = 48 KB)
  const entries = [
    { role: "user", content: "Plan the caching architecture without editing files yet" },
    {
      role: "assistant",
      content: [
        "## Cache Design Options",
        "```ts",
        ...Array.from({ length: 12 }, (_, i) => `export const c${i} = ${i};`),
        "```",
        "Should we use SQLite WAL or an in-memory LRU cache?",
      ].join("\n"),
    },
  ];
  for (let i = 1; i <= 8; i++) {
    entries.push({
      role: "user",
      content: `Discussion turn #${i}: evaluate eviction policy and TTL bounds for tier ${i}.`,
    });
    entries.push({
      role: "assistant",
      content: [
        `### Eviction Notes #${i}`,
        `- Tradeoff details #${i}: ${"memory-pressure analysis ".repeat(90)}`,
        ...(i === 8 ? ["- Should TTL refresh on read or remain absolute?"] : []),
      ].join("\n"),
    });
  }

  // 1. Custom llmRunner receives >12 KB distilled transcript (up to 48 KB) with long code stripped
  let promptSeen = "";
  const resLlm = await runStandaloneCapture({
    cwd: repoDir,
    trigger: "auto",
    agentName: "opencode",
    transcriptEntries: entries,
    llmRunner: async (prompt) => {
      promptSeen = prompt;
      return {
        current_status: {
          done: ["Evaluated SQLite WAL vs in-memory LRU cache"],
          in_progress: ["Defining TTL eviction policy"],
          next: "Confirm whether TTL refreshes on read",
        },
        new_decisions: ["Prefer single-process LRU over external Redis for local CLI"],
        new_gotchas: [],
        open_questions: ["Should TTL refresh on read or remain absolute?"],
      };
    },
  });
  assert.equal(resLlm.usedFallback, false);
  assert.match(promptSeen, /\[code block omitted: ts, 12 lines\]/);
  assert.ok(Buffer.byteLength(promptSeen, "utf8") > 12 * 1024);
  assert.match(resLlm.updatedContent, /Should TTL refresh on read or remain absolute\?/);

  // 2. skipIfUnchanged must NOT skip when transcriptEntries is provided even with clean git state
  const resDiscFallback = await runStandaloneCapture({
    cwd: repoDir,
    trigger: "session-end",
    agentName: "pi",
    transcriptEntries: [
      { role: "user", content: "Align on storage schema migration plan" },
      {
        role: "assistant",
        content: [
          "Proposed two-phase migration.",
          "Should we keep backward compatibility with v1 config files?",
        ].join("\n"),
      },
    ],
    llmRunner: false,
    skipIfUnchanged: true,
  });
  assert.equal(resDiscFallback.skipped, false);
  assert.equal(resDiscFallback.usedFallback, true);
  assert.match(resDiscFallback.updatedContent, /Align on storage schema migration plan/);
  assert.match(
    resDiscFallback.updatedContent,
    /Should we keep backward compatibility with v1 config files\?/,
  );
  assert.match(
    resDiscFallback.updatedContent,
    /Resolve open question and confirm next step: Should we keep backward compatibility/,
  );

  // 3. Code mode when uncommitted file exists
  fs.writeFileSync(path.join(repoDir, "src-change.js"), "export const x = 1;\n", "utf8");
  const dirtyGit = gatherGitContext(repoDir);
  assert.equal(detectDiscussionMode(dirtyGit), false);
  const codePrompt = buildCapturePrompt({
    gitContext: dirtyGit,
    transcriptText: "[user]: Added src-change.js",
    agentName: "claude-code",
  });
  assert.match(codePrompt, /Mode: Code & Implementation Mode/);
});
