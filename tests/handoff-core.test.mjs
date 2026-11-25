import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DIFF_BUDGET_BYTES,
  applyUpdate,
  buildCapturePrompt,
  buildCompactSummaryFromHandoff,
  computeGitSignal,
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
