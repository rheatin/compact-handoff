import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const PI_EXTENSION_PATH = path.join(REPO_ROOT, "extensions", "pi", "handoff.ts");
const HANDOFF_CORE_PATH = path.join(REPO_ROOT, "scripts", "handoff-core.mjs");
const HANDOFF_CLI = path.join(REPO_ROOT, "scripts", "cli.mjs");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install.mjs");

const piExtModule = await import(pathToFileURL(PI_EXTENSION_PATH).href);
const setupPiHandoffExtension = piExtModule.default;
const { extractBoundedTranscript } = piExtModule;
const {
  applyUpdate,
  buildCompactSummaryFromHandoff,
  extractStartupContext,
} = await import(pathToFileURL(HANDOFF_CORE_PATH).href);
const { runInstaller } = await import(pathToFileURL(INSTALL_SCRIPT).href);

function createTempGitRepo(prefix = "handoff-hosts-test-") {
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

function writeTempConfig(dir, overrides = {}) {
  const cfgPath = path.join(dir, "handoff.config.json");
  const base = {
    trigger: {
      mode: "percentage",
      percentage: 50,
      tokens: 100000,
      ...(overrides.trigger || {}),
    },
    model: "current",
    useSubagent: true,
    captureOnSessionEnd: false,
    autoExcludeGit: true,
    ...overrides,
  };
  if (overrides.trigger) {
    base.trigger = {
      mode: "percentage",
      percentage: 50,
      tokens: 100000,
      ...overrides.trigger,
    };
  }
  fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2), "utf8");
  return cfgPath;
}

function createMockPiHarness() {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      };
    },
  };
  setupPiHandoffExtension(pi);

  return {
    handlers,
    async emit(event, payload, ctx) {
      const list = handlers.get(event) ?? [];
      let lastResult;
      for (const fn of list) {
        const res = await fn(payload, ctx);
        if (res !== undefined) lastResult = res;
      }
      return lastResult;
    },
  };
}

function runHookCli(args, stdinObj, options = {}) {
  const res = spawnSync(process.execPath, [HANDOFF_CLI, "hook", ...args], {
    cwd: options.cwd || os.tmpdir(),
    input: stdinObj !== undefined ? JSON.stringify(stdinObj) : "",
    encoding: "utf8",
    env: {
      ...process.env,
      HANDOFF_DISABLE_EXTERNAL_LLM: "1",
      ...(options.env || {}),
    },
    timeout: 15000,
  });
  assert.equal(
    res.status,
    0,
    `Hook exited with status ${res.status}: ${res.stderr}`,
  );
  return {
    rawStdout: res.stdout,
    json: JSON.parse(res.stdout.trim()),
  };
}

// ---------------------------------------------------------------------------
// 1. Pi Extension Tests
// ---------------------------------------------------------------------------

test("Pi extension: session_start + before_agent_start injects startup context once per session without dirtying AGENTS.md", async (t) => {
  const repoDir = createTempGitRepo("handoff-pi-start-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const harness = createMockPiHarness();
  const ctx = { cwd: repoDir };

  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const emptyRes = await harness.emit(
    "before_agent_start",
    { type: "before_agent_start", messageType: "user", prompt: "Hi" },
    ctx,
  );
  assert.equal(emptyRes, undefined);

  fs.writeFileSync(
    path.join(repoDir, "HANDOFF.md"),
    [
      "# Handoff",
      "",
      "> Last updated: 2026-11-23T02:00:00.000Z (via opencode · auto)",
      "",
      "## Current status",
      "",
      "**Done**",
      "- OpenCode adapter completed",
      "",
      "**In progress**",
      "- Testing Pi startup context injection",
      "",
      "**Next**",
      "- Verify session_before_compact replacement",
      "",
      "## Gotchas / constraints",
      "",
      "- Keep AGENTS.md untouched",
      "",
    ].join("\n"),
    "utf8",
  );

  await harness.emit("session_start", { type: "session_start", reason: "new" }, ctx);
  const firstTurn = await harness.emit(
    "before_agent_start",
    { type: "before_agent_start", messageType: "user", prompt: "Resume work" },
    ctx,
  );

  assert.ok(firstTurn?.message);
  assert.equal(firstTurn.message.customType, "handoff-context");
  assert.equal(firstTurn.message.display, false);
  assert.match(firstTurn.message.content, /^\[Handoff Context from HANDOFF\.md\]/);
  assert.match(firstTurn.message.content, /Testing Pi startup context injection/);
  assert.match(firstTurn.message.content, /Keep AGENTS\.md untouched/);
  assert.equal(fs.existsSync(path.join(repoDir, "AGENTS.md")), false);

  const secondTurn = await harness.emit(
    "before_agent_start",
    { type: "before_agent_start", messageType: "user", prompt: "Next step" },
    ctx,
  );
  assert.equal(secondTurn, undefined);

  await harness.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
  const resumedFirstTurn = await harness.emit(
    "before_agent_start",
    { type: "before_agent_start", messageType: "user", prompt: "Back again" },
    ctx,
  );
  assert.equal(resumedFirstTurn?.message?.customType, "handoff-context");
});

test("Pi extension: turn_end skips 62% mid-turn, agent_end compacts at 62%, and turn_end enforces 85% / 1.4x emergency cap", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-pi-thresh-"));
  const prevCfg = process.env.HANDOFF_CONFIG_PATH;
  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH;
    else process.env.HANDOFF_CONFIG_PATH = prevCfg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(tmpDir, {
    trigger: { mode: "percentage", percentage: 60, tokens: 100000 },
  });

  const harness = createMockPiHarness();
  let compactCount = 0;
  let currentUsage = { tokens: 30000, contextWindow: 100000, percent: 30 };

  const ctx = {
    cwd: tmpDir,
    getContextUsage: () => currentUsage,
    compact: () => {
      compactCount += 1;
    },
  };

  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
  await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCount, 0);

  currentUsage = { tokens: 62000, contextWindow: 100000, percent: null };
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 1 }, ctx);
  assert.equal(compactCount, 0);

  await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCount, 1);

  await harness.emit("turn_end", { type: "turn_end", turnIndex: 1 }, ctx);
  await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCount, 1);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 2 }, ctx);
  currentUsage = { tokens: 86000, contextWindow: 100000, percent: 86 };
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 2 }, ctx);
  assert.equal(compactCount, 2);

  await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCount, 2);

  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(tmpDir, {
    trigger: { mode: "tokens", percentage: 60, tokens: 80000 },
  });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 3 }, ctx);
  currentUsage = { tokens: 75000, contextWindow: 200000, percent: 37.5 };
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 3 }, ctx);
  await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCount, 2);

  currentUsage = { tokens: 82000, contextWindow: 200000, percent: 41 };
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 4 }, ctx);
  assert.equal(compactCount, 2);
  await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCount, 3);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 5 }, ctx);
  currentUsage = { tokens: 115000, contextWindow: 200000, percent: 57.5 };
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 5 }, ctx);
  assert.equal(compactCount, 4);
});

test("Pi extension: session_before_compact updates HANDOFF.md via active Pi model and returns CompactionResult", async (t) => {
  const repoDir = createTempGitRepo("handoff-pi-compact-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-pi-compact-cfg-"));
  const prevCfg = process.env.HANDOFF_CONFIG_PATH;
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir);
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1";

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH;
    else process.env.HANDOFF_CONFIG_PATH = prevCfg;
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "pi-bridge.ts"), "export const ok = 1;\n", "utf8");

  const llmJson = JSON.stringify({
    current_status: {
      done: ["Wired Pi session_before_compact hook in extensions/pi/handoff.ts"],
      in_progress: ["Validating src/pi-bridge.ts integration"],
      next: "Run node --test suite across all host hooks",
    },
    new_decisions: [
      "Returned HANDOFF.md directly as session_before_compact compaction.summary",
    ],
    new_gotchas: [
      "Reset compaction cooldown on turn_start so single turns never compact twice",
    ],
  });

  let apiKeyLookups = 0;
  const activeModel = { provider: "mock", id: "mock-pi-model", api: "mock" };
  const modelRegistry = {
    async getApiKey() {
      apiKeyLookups += 1;
      return "test-pi-key";
    },
    async completeSimple() {
      return { content: [{ type: "text", text: llmJson }] };
    },
  };

  const harness = createMockPiHarness();
  const abortController = new AbortController();
  const compactRes = await harness.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      reason: "threshold",
      willRetry: false,
      signal: abortController.signal,
      branchEntries: [],
      preparation: {
        firstKeptEntryId: "entry_keep_42",
        tokensBefore: 112000,
        turnPrefixMessages: [],
        isSplitTurn: false,
        messagesToSummarize: [
          {
            role: "user",
            content: [{ type: "text", text: "Implement Pi handoff extension" }],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Created src/pi-bridge.ts and wired events." },
              {
                type: "toolCall",
                id: "tc_1",
                name: "write",
                arguments: { path: "src/pi-bridge.ts" },
              },
            ],
          },
        ],
      },
    },
    {
      cwd: repoDir,
      model: activeModel,
      modelRegistry,
    },
  );

  assert.equal(apiKeyLookups, 1);
  assert.ok(compactRes?.compaction);
  assert.equal(compactRes.compaction.firstKeptEntryId, "entry_keep_42");
  assert.equal(compactRes.compaction.tokensBefore, 112000);
  assert.match(
    compactRes.compaction.summary,
    /^# Handoff & Compaction Summary \(from HANDOFF\.md\)/,
  );
  assert.match(compactRes.compaction.summary, /Wired Pi session_before_compact hook/);

  const handoffMd = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8");
  assert.match(handoffMd, /\(via pi · threshold\)/);
  assert.match(handoffMd, /Run node --test suite across all host hooks/);
  assert.match(handoffMd, /Returned HANDOFF\.md directly/);

  const excludeTxt = fs.readFileSync(
    path.join(repoDir, ".git", "info", "exclude"),
    "utf8",
  );
  assert.match(excludeTxt, /^HANDOFF\.md$/m);

  const hugeMessages = [
    { role: "user", content: "Initial objective: cross-agent continuity" },
  ];
  for (let i = 0; i < 40; i++) {
    hugeMessages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Step ${i}: ${"detailed reasoning ".repeat(100)}` },
        { type: "toolCall", name: "edit", arguments: { filePath: `src/f-${i}.ts` } },
      ],
    });
  }
  const bounded = extractBoundedTranscript(hugeMessages);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 12 * 1024);
  assert.match(bounded, /Initial objective/);
  assert.match(bounded, /src\/f-39\.ts/);
});

test("Pi extension: session_shutdown respects captureOnSessionEnd", async (t) => {
  const repoDir = createTempGitRepo("handoff-pi-shutdown-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-pi-shut-cfg-"));
  const prevCfg = process.env.HANDOFF_CONFIG_PATH;
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1";

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH;
    else process.env.HANDOFF_CONFIG_PATH = prevCfg;
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  const harness = createMockPiHarness();
  const ctx = { cwd: repoDir };

  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, {
    captureOnSessionEnd: false,
  });
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), false);

  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, {
    captureOnSessionEnd: true,
  });
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), true);
  const md = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8");
  assert.match(md, /\(via pi · session-end\)/);
});

// ---------------------------------------------------------------------------
// 2. Installer Idempotency & Multi-Host Config Merge Tests
// ---------------------------------------------------------------------------

test("install.mjs installs across opencode, pi, claude, gemini idempotently without clobbering existing hooks, and uninstalls cleanly", async (t) => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-home-"));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  // Pre-seed Claude settings.json and Gemini hooks.json with existing unrelated rules
  const claudeDir = path.join(fakeHome, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        permissions: { allow: ["Bash(git status)"] },
        hooks: {
          SessionStart: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "echo custom-start", timeout: 5 }],
            },
          ],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo pre-tool", timeout: 5 }],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const geminiConfigDir = path.join(fakeHome, ".gemini", "config");
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiConfigDir, "hooks.json"),
    JSON.stringify(
      {
        customHook: { enabled: true },
      },
      null,
      2,
    ),
    "utf8",
  );

  const openCodeDir = path.join(fakeHome, ".config", "opencode");
  fs.mkdirSync(openCodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(openCodeDir, "opencode.json"),
    JSON.stringify({ theme: "dark" }, null, 2),
    "utf8",
  );

  // Dry-run does not mutate files
  const dryRes = await runInstaller({
    homeDir: fakeHome,
    openCodeDir,
    hosts: ["opencode", "pi", "claude", "gemini"],
    dryRun: true,
    percentage: 55,
  });
  assert.equal(dryRes.dryRun, true);
  assert.equal(fs.existsSync(path.join(fakeHome, ".config", "handoff", "config.json")), false);

  // Real install (run twice to verify idempotency)
  await runInstaller({
    homeDir: fakeHome,
    openCodeDir,
    hosts: ["opencode", "pi", "claude", "gemini"],
    percentage: 55,
  });
  await runInstaller({
    homeDir: fakeHome,
    openCodeDir,
    hosts: ["opencode", "pi", "claude", "gemini"],
  });

  const cfg = JSON.parse(
    fs.readFileSync(path.join(fakeHome, ".config", "handoff", "config.json"), "utf8"),
  );
  assert.equal(cfg.trigger.percentage, 55);

  const ocCfg = JSON.parse(fs.readFileSync(path.join(openCodeDir, "opencode.json"), "utf8"));
  assert.equal(ocCfg.theme, "dark");
  assert.deepEqual(ocCfg.compaction.trigger, { mode: "percentage", value: 55 });

  assert.equal(fs.existsSync(path.join(fakeHome, ".local", "bin", "compact-handoff")), true);
  assert.equal(fs.existsSync(path.join(fakeHome, ".agents", "skills", "compact-handoff", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(openCodeDir, "extensions", "handoff.ts")), true);
  assert.equal(fs.existsSync(path.join(fakeHome, ".pi", "agent", "extensions", "handoff.ts")), true);

  const claudeAfter = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  assert.deepEqual(claudeAfter.permissions.allow, ["Bash(git status)"]);
  assert.equal(claudeAfter.hooks.PreToolUse.length, 1);
  // Existing SessionStart preserved + exactly 1 compact-handoff SessionStart group (not duplicated)
  assert.equal(claudeAfter.hooks.SessionStart.length, 2);
  assert.equal(claudeAfter.hooks.PreCompact.length, 1);
  assert.equal(claudeAfter.hooks.SessionEnd.length, 1);

  const geminiAfter = JSON.parse(fs.readFileSync(path.join(geminiConfigDir, "hooks.json"), "utf8"));
  assert.deepEqual(geminiAfter.customHook, { enabled: true });
  assert.equal(geminiAfter["compact-handoff"].enabled, true);

  // Uninstall removes only compact-handoff hooks/links, preserving existing hooks
  await runInstaller({
    homeDir: fakeHome,
    openCodeDir,
    hosts: ["opencode", "pi", "claude", "gemini"],
    uninstall: true,
  });

  assert.equal(fs.existsSync(path.join(fakeHome, ".local", "bin", "compact-handoff")), false);
  assert.equal(fs.existsSync(path.join(openCodeDir, "extensions", "handoff.ts")), false);
  assert.equal(fs.existsSync(path.join(fakeHome, ".pi", "agent", "extensions", "handoff.ts")), false);

  const claudeUninstalled = JSON.parse(
    fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"),
  );
  assert.equal(claudeUninstalled.hooks.SessionStart.length, 1);
  assert.equal(claudeUninstalled.hooks.SessionStart[0].hooks[0].command, "echo custom-start");
  assert.equal(claudeUninstalled.hooks.PreCompact, undefined);
  assert.equal(claudeUninstalled.hooks.SessionEnd, undefined);

  const geminiUninstalled = JSON.parse(
    fs.readFileSync(path.join(geminiConfigDir, "hooks.json"), "utf8"),
  );
  assert.deepEqual(geminiUninstalled, { customHook: { enabled: true } });
});

// ---------------------------------------------------------------------------
// 3. Claude Code & Gemini CLI Hook CLI Tests
// ---------------------------------------------------------------------------

test("compact-handoff hook claude precompact | sessionstart | sessionend handle stdin JSON payloads", (t) => {
  const repoDir = createTempGitRepo("handoff-claude-hook-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-claude-cfg-"));
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  const cfgFalse = writeTempConfig(cfgDir, { captureOnSessionEnd: false });
  const transcriptPath = path.join(cfgDir, "claude-session.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Wire Claude PreCompact and SessionStart hooks" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Updated settings.json and verified CLI output." }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const startEmpty = runHookCli(
    ["claude", "sessionstart"],
    {
      session_id: "claude_ses_1",
      transcript_path: transcriptPath,
      cwd: repoDir,
      hook_event_name: "SessionStart",
      source: "startup",
    },
    { env: { HANDOFF_CONFIG_PATH: cfgFalse } },
  );
  assert.deepEqual(startEmpty.json, {});

  const endNoop = runHookCli(
    ["claude", "sessionend"],
    {
      session_id: "claude_ses_1",
      transcript_path: transcriptPath,
      cwd: repoDir,
      hook_event_name: "SessionEnd",
      reason: "exit",
    },
    { env: { HANDOFF_CONFIG_PATH: cfgFalse } },
  );
  assert.deepEqual(endNoop.json, {});
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), false);

  fs.writeFileSync(path.join(repoDir, "claude-feature.js"), "export default 1;\n", "utf8");
  const preCompactOut = runHookCli(
    ["claude", "precompact"],
    {
      session_id: "claude_ses_1",
      transcript_path: transcriptPath,
      cwd: repoDir,
      hook_event_name: "PreCompact",
      trigger: "auto",
    },
    { env: { HANDOFF_CONFIG_PATH: cfgFalse } },
  );
  assert.equal(preCompactOut.json.continue, true);
  assert.equal(preCompactOut.json.suppressOutput, true);
  assert.match(preCompactOut.json.systemMessage, /HANDOFF\.md updated/);

  const handoffAfterCompact = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8");
  assert.match(handoffAfterCompact, /\(via claude-code · auto\)/);
  assert.match(handoffAfterCompact, /claude-feature\.js/);

  const startActive = runHookCli(
    ["claude", "sessionstart"],
    {
      session_id: "claude_ses_2",
      transcript_path: transcriptPath,
      cwd: repoDir,
      hook_event_name: "SessionStart",
      source: "startup",
    },
    { env: { HANDOFF_CONFIG_PATH: cfgFalse } },
  );
  assert.equal(startActive.json.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(
    startActive.json.hookSpecificOutput?.additionalContext,
    /claude-feature\.js/,
  );

  const cfgTrue = writeTempConfig(cfgDir, { captureOnSessionEnd: true });
  fs.writeFileSync(path.join(repoDir, "claude-end.js"), "export default 2;\n", "utf8");
  const endCaptured = runHookCli(
    ["claude", "sessionend"],
    {
      session_id: "claude_ses_2",
      transcript_path: transcriptPath,
      cwd: repoDir,
      hook_event_name: "SessionEnd",
      reason: "exit",
    },
    { env: { HANDOFF_CONFIG_PATH: cfgTrue } },
  );
  assert.deepEqual(endCaptured.json, { continue: true, suppressOutput: true });
  const handoffAfterEnd = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8");
  assert.match(handoffAfterEnd, /\(via claude-code · session-end\)/);
  assert.match(handoffAfterEnd, /claude-end\.js/);
});

test("compact-handoff hook gemini sessionstart | stop | precompact handle workspacePaths, threshold checks, and SessionStart output", (t) => {
  const repoDir = createTempGitRepo("handoff-gemini-hook-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-gemini-cfg-"));
  const hooksWorkingDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-gemini-cwd-"));

  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(hooksWorkingDir, { recursive: true, force: true });
  });

  const smallTranscriptPath = path.join(cfgDir, "gemini-small.jsonl");
  fs.writeFileSync(
    smallTranscriptPath,
    JSON.stringify({ role: "user", content: "Quick status check" }) + "\n",
    "utf8",
  );

  const cfgThreshold = writeTempConfig(cfgDir, {
    trigger: { mode: "tokens", percentage: 50, tokens: 200 },
    captureOnSessionEnd: false,
  });

  const geminiStartEmpty = runHookCli(
    ["gemini", "sessionstart"],
    {
      conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
      workspacePaths: [repoDir],
      transcriptPath: smallTranscriptPath,
    },
    { cwd: hooksWorkingDir, env: { HANDOFF_CONFIG_PATH: cfgThreshold } },
  );
  assert.deepEqual(geminiStartEmpty.json, {});

  const geminiStopBelow = runHookCli(
    ["gemini", "stop"],
    {
      conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
      workspacePaths: [repoDir],
      transcriptPath: smallTranscriptPath,
    },
    { cwd: hooksWorkingDir, env: { HANDOFF_CONFIG_PATH: cfgThreshold } },
  );
  assert.deepEqual(geminiStopBelow.json, {});
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), false);

  const largeTranscriptPath = path.join(cfgDir, "gemini-large.jsonl");
  fs.writeFileSync(
    largeTranscriptPath,
    [
      JSON.stringify({
        role: "user",
        content: "Implement Gemini CLI stop hook threshold gate. " + "Context details. ".repeat(80),
      }),
      JSON.stringify({
        role: "assistant",
        content: "Wired ~/.gemini/config/hooks.json and verified hook output.",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "gemini-module.ts"), "export const gemini = true;\n", "utf8");

  const geminiStopAbove = runHookCli(
    ["gemini", "stop"],
    {
      conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
      workspacePaths: [repoDir],
      transcriptPath: largeTranscriptPath,
    },
    { cwd: hooksWorkingDir, env: { HANDOFF_CONFIG_PATH: cfgThreshold } },
  );
  assert.deepEqual(geminiStopAbove.json, { continue: true, suppressOutput: true });
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), true);
  const geminiHandoff = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8");
  assert.match(geminiHandoff, /\(via gemini-cli · auto\)/);
  assert.match(geminiHandoff, /gemini-module\.ts/);

  const geminiStartActive = runHookCli(
    ["gemini", "sessionstart"],
    {
      conversationId: "f1234567-0cba-4100-8142-c61503f6c587",
      workspacePaths: [repoDir],
      transcriptPath: smallTranscriptPath,
    },
    { cwd: hooksWorkingDir, env: { HANDOFF_CONFIG_PATH: cfgThreshold } },
  );
  assert.equal(geminiStartActive.json.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(
    geminiStartActive.json.hookSpecificOutput?.additionalContext,
    /gemini-module\.ts/,
  );

  const cfgSessionEnd = writeTempConfig(cfgDir, {
    trigger: { mode: "tokens", percentage: 50, tokens: 999999 },
    captureOnSessionEnd: true,
  });
  fs.writeFileSync(path.join(repoDir, "gemini-final.ts"), "export const done = true;\n", "utf8");

  const geminiStopSessionEnd = runHookCli(
    ["gemini", "stop"],
    {
      conversationId: "f1234567-0cba-4100-8142-c61503f6c587",
      workspacePaths: [repoDir],
      transcriptPath: smallTranscriptPath,
    },
    { cwd: hooksWorkingDir, env: { HANDOFF_CONFIG_PATH: cfgSessionEnd } },
  );
  assert.deepEqual(geminiStopSessionEnd.json, { continue: true, suppressOutput: true });
  const geminiHandoffEnd = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8");
  assert.match(geminiHandoffEnd, /\(via gemini-cli · session-end\)/);
  assert.match(geminiHandoffEnd, /gemini-final\.ts/);
});

// ---------------------------------------------------------------------------
// 4. Rolling-Window Compaction & Startup Trimming Tests
// ---------------------------------------------------------------------------

test("buildCompactSummaryFromHandoff and extractStartupContext trim large history while preserving full HANDOFF.md on disk", (t) => {
  const repoDir = createTempGitRepo("handoff-rolling-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const handoffPath = path.join(repoDir, "HANDOFF.md");
  const initialDoc = [
    "# Handoff",
    "",
    "> Last updated: never",
    "",
    "## Overview",
    "",
    "Cross-agent continuity platform.",
    "",
    "## Current status",
    "",
    "**Done**",
    "- (none yet)",
    "",
    "**In progress**",
    "- (none yet)",
    "",
    "**Next**",
    "- (none yet)",
    "",
    "## Decision log",
    "",
    "<!-- Append-only -->",
    "",
    "## Gotchas / constraints",
    "",
    "<!-- Append-only -->",
    "",
    "## Commands",
    "",
    "- `node --test tests/*.test.mjs`",
    "",
  ].join("\n");

  const doneItems = Array.from({ length: 24 }, (_, i) => `Completed milestone #${i + 1} with unique token alpha${i}`);
  const decisions = [
    "Use OAuth PKCE flow with rotating refresh tokens in src/auth/oauth.ts",
    "Store session metadata inside SQLite WAL mode at data/sessions.db",
    "Enable Redis pipelining for rate-limit counters in cache/limiter.ts",
    "Adopt GraphQL persisted queries to shrink payload overhead in api/schema.graphql",
    "Switch bundle pipeline to esbuild incremental watch in scripts/dev.mjs",
    "Run Docker multi-stage Alpine images for smaller container artifacts",
    "Configure Nginx upstream keepalive pools in deploy/nginx.conf",
    "Partition Postgres audit tables by month in migrations/004_audit.sql",
    "Use Kafka dead-letter topics for failed webhook deliveries in queue/dlq.ts",
    "Define gRPC proto3 validation rules inside proto/orders.proto",
    "Adopt Vitest workspace mode for faster monorepo parallel test execution",
    "Replace Prisma raw SQL helpers with typed query builders in db/client.ts",
    "Compile Tailwind utility layers at build time via postcss.config.cjs",
    "Serve Next.js static marketing pages from CDN edge cache headers",
    "Pin Deno lockfile integrity hashes inside deno.lock for CI reproducibility",
    "Migrate Cargo workspace dependencies to shared resolver v2 in Cargo.toml",
    "Isolate Python ML worker virtualenvs via uv sync in services/ml/pyproject.toml",
    "Manage Terraform remote state locking through DynamoDB backend configuration",
    "Implement WebSocket heartbeat ping/pong timeouts in realtime/socket.ts",
    "Batch S3 multipart uploads above 16MB threshold in storage/uploader.ts",
    "Enforce strict Content-Security-Policy nonces in middleware/security.ts",
    "Instrument OpenTelemetry span exporters over OTLP HTTP in telemetry/tracing.ts",
  ];
  const gotchas = [
    "ARM64 macOS requires Rosetta disabled when compiling native arm64 bindings",
    "Safari ITP clears third-party cookies after seven days without user interaction",
    "Node child_process execFileSync throws ETIMEDOUT if stdout exceeds maxBuffer",
    "Cloudflare Workers disallow TCP sockets on port 25 outbound SMTP connections",
    "Safari WebAudio AudioContext stays suspended until triggered inside click handler",
    "Git worktrees share common hooks dir under git-common-dir instead of local git-dir",
    "PostgreSQL advisory locks remain held until connection pool returns idle client",
    "TypeScript project references silently skip stale d.ts files without composite flag",
    "Zsh globbing fails on unquoted bracket patterns like tests/*.test.mjs unless escaped",
    "Nginx strips underscores from custom HTTP headers unless underscores_in_headers is on",
    "Redis KEYS command blocks single-threaded event loop on large production keyspaces",
    "SQLite FTS5 tokenizer splits hyphenated UUIDs unless wrapped in double quotes",
    "Docker BuildKit caches RUN mount steps across branches unless cache-bust arg changes",
    "Vitest fake timers freeze fs.promises unless specifically excluded in mock config",
    "OpenSSL 3 rejects legacy PKCS12 ciphers without legacy provider flag enabled",
    "Kubernetes preStop sleep hook is needed before SIGTERM drains active ingress pods",
    "Next.js App Router fetch caches GET responses indefinitely without revalidate zero",
    "gRPC keepalive pings too frequent trigger ENHANCE_YOUR_CALM GOAWAY from server",
    "Brotli level 11 dynamic compression stalls TTFB on large JSON API responses",
    "LaunchAgent plists ignore shell PATH from ~/.zshrc unless EnvironmentVariables set",
  ];

  const updated = applyUpdate(
    initialDoc,
    {
      current_status: {
        done: doneItems,
        in_progress: ["Testing rolling-window bounds"],
        next: "Ship upgrade to production",
      },
      new_decisions: decisions,
      new_gotchas: gotchas,
    },
    { timestamp: "2026-11-25T12:00:00.000Z", agentName: "opencode", trigger: "auto" },
  );
  fs.writeFileSync(handoffPath, updated, "utf8");

  const onDisk = fs.readFileSync(handoffPath, "utf8");
  assert.match(onDisk, /OAuth PKCE flow/);
  assert.match(onDisk, /OpenTelemetry span exporters/);
  assert.match(onDisk, /Rosetta disabled/);
  assert.match(onDisk, /LaunchAgent plists/);
  assert.match(onDisk, /Completed milestone #1 /);
  assert.match(onDisk, /Completed milestone #24 /);

  const compactSummary = buildCompactSummaryFromHandoff(handoffPath, onDisk);
  assert.match(compactSummary, /^# Handoff & Compaction Summary \(from HANDOFF\.md\)/);
  assert.match(compactSummary, /Cross-agent continuity platform\./);
  assert.match(compactSummary, /node --test tests\/\*\.test\.mjs/);
  assert.match(compactSummary, /Testing rolling-window bounds/);
  assert.match(compactSummary, /Ship upgrade to production/);

  assert.match(compactSummary, /\(\.\.\. 9 older entries omitted; read .*HANDOFF\.md for full history\)/);
  assert.match(compactSummary, /\(\.\.\. 7 older entries omitted; read .*HANDOFF\.md for full history\)/);
  assert.match(compactSummary, /\(\.\.\. 5 older entries omitted; read .*HANDOFF\.md for full history\)/);
  assert.equal(compactSummary.includes("Completed milestone #9 "), false);
  assert.equal(compactSummary.includes("Completed milestone #10 "), true);
  assert.equal(compactSummary.includes("Nginx upstream keepalive"), false);
  assert.equal(compactSummary.includes("Postgres audit tables"), true);
  assert.equal(compactSummary.includes("AudioContext stays suspended"), false);
  assert.equal(compactSummary.includes("Git worktrees share"), true);
  assert.ok(compactSummary.includes(handoffPath));

  const startupCtx = extractStartupContext(repoDir);
  assert.ok(startupCtx);
  assert.match(startupCtx, /Cross-agent continuity platform\./);
  assert.match(startupCtx, /node --test tests\/\*\.test\.mjs/);
  assert.match(startupCtx, /\(\.\.\. 12 older entries omitted; read .*HANDOFF\.md for full history\)/);
  assert.match(startupCtx, /\(\.\.\. 5 older entries omitted; read .*HANDOFF\.md for full history\)/);
  assert.equal(startupCtx.includes("typed query builders"), false);
  assert.equal(startupCtx.includes("Tailwind utility layers"), true);
  assert.equal(startupCtx.includes("AudioContext stays suspended"), false);
  assert.equal(startupCtx.includes("Git worktrees share"), true);
  assert.ok(
    startupCtx
      .trim()
      .endsWith(
        `Use this state to continue work. Read ${handoffPath} directly if you need earlier decision history.`,
      ),
  );
});

test("Pi session_before_compact and CLI precompact hook support pure-discussion dynamic 48 KB distillation and Open questions", async (t) => {
  const repoDir = createTempGitRepo("handoff-hosts-disc-");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-hosts-disc-cfg-"));
  const prevCfg = process.env.HANDOFF_CONFIG_PATH;
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir);
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1";

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH;
    else process.env.HANDOFF_CONFIG_PATH = prevCfg;
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM;
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  // 1. Pi session_before_compact in clean repo uses >12 KB distilled transcript and surfaces open_questions
  const seenPrompts = [];
  const activeModel = { provider: "mock", id: "mock-pi-model", api: "mock" };
  const modelRegistry = {
    async getApiKey() {
      return "test-pi-key";
    },
    async completeSimple(_model, llmContext) {
      seenPrompts.push(llmContext.messages[0].content[0].text);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              current_status: {
                done: ["Researched state persistence architecture"],
                in_progress: ["Evaluating migration steps"],
                next: "Confirm schema version header format",
              },
              new_decisions: ["Keep HANDOFF.md surgical without altering Overview"],
              new_gotchas: [],
              open_questions: ["Should legacy v1 headers auto-migrate on read?"],
            }),
          },
        ],
      };
    },
  };

  const longCode = [
    "```js",
    ...Array.from({ length: 12 }, (_, i) => `const item${i} = ${i};`),
    "```",
  ].join("\n");

  const discussionMessages = [
    { role: "user", content: "Plan pure-discussion continuity improvements" },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "### Findings",
            longCode,
            "- Should legacy v1 headers auto-migrate on read?",
          ].join("\n"),
        },
      ],
    },
  ];
  for (let i = 1; i <= 8; i++) {
    discussionMessages.push({
      role: "user",
      content: `Also check CLI transcript distillation aspect #${i}`,
    });
    discussionMessages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `- CLI notes #${i}: ${"cli streaming pipeline rationale ".repeat(75)}`,
        },
      ],
    });
  }

  const harness = createMockPiHarness();
  const compactRes = await harness.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      reason: "threshold",
      willRetry: false,
      branchEntries: [],
      preparation: {
        firstKeptEntryId: "keep_1",
        tokensBefore: 90000,
        turnPrefixMessages: [],
        isSplitTurn: false,
        messagesToSummarize: discussionMessages,
      },
    },
    { cwd: repoDir, model: activeModel, modelRegistry },
  );

  assert.equal(seenPrompts.length, 1);
  assert.match(seenPrompts[0], /Design \/ Planning \/ Research Discussion Mode/);
  assert.match(seenPrompts[0], /\[code block omitted: js, 12 lines\]/);
  assert.ok(Buffer.byteLength(seenPrompts[0], "utf8") > 16 * 1024);
  assert.match(
    compactRes.compaction.summary,
    /Should legacy v1 headers auto-migrate on read\?/,
  );

  // 2. CLI claude precompact hook in clean repo distills JSONL transcript through distillTranscriptEntries(..., 48KB)
  const cliRepoDir = createTempGitRepo("handoff-cli-disc-");
  t.after(() => fs.rmSync(cliRepoDir, { recursive: true, force: true }));
  const transcriptPath = path.join(cfgDir, "cli-discussion.jsonl");
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Design zero-downtime DB migration workflow" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "### Expand-Contract Plan",
                longCode,
                "Should dual-write run synchronously or via outbox queue?",
              ].join("\n"),
            },
          ],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const preCompactOut = runHookCli(
    ["claude", "precompact"],
    {
      session_id: "claude_disc_1",
      transcript_path: transcriptPath,
      cwd: cliRepoDir,
      hook_event_name: "PreCompact",
      trigger: "auto",
    },
    { env: { HANDOFF_CONFIG_PATH: writeTempConfig(cfgDir, { captureOnSessionEnd: false }) } },
  );
  assert.equal(preCompactOut.json.continue, true);

  const cliHandoff = fs.readFileSync(path.join(cliRepoDir, "HANDOFF.md"), "utf8");
  assert.match(cliHandoff, /Design zero-downtime DB migration workflow/);
  assert.match(cliHandoff, /Should dual-write run synchronously or via outbox queue\?/);
});
