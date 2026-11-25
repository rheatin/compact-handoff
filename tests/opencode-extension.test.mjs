import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const EXTENSION_PATH = path.resolve(__dirname, "../extensions/opencode/handoff.ts")

const extensionModule = await import(pathToFileURL(EXTENSION_PATH).href)
const HandoffExtension = extensionModule.default
const { extractBoundedTranscript, getModelContextLimit } = extensionModule

function createTempGitRepo(prefix = "handoff-opencode-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
  fs.writeFileSync(path.join(dir, "README.md"), "# Sample Repo\n", "utf8")
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: dir, stdio: "ignore" })
  return dir
}

function writeTempConfig(dir, overrides = {}) {
  const cfgPath = path.join(dir, "handoff.config.json")
  const base = {
    trigger: { mode: "percentage", percentage: 50, tokens: 100000 },
    model: "current",
    useSubagent: true,
    captureOnSessionEnd: false,
    autoExcludeGit: true,
    ...overrides,
  }
  fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2), "utf8")
  return cfgPath
}

test("extension exports canonical id and server factory", () => {
  assert.equal(HandoffExtension.id, "handoff")
  assert.equal(typeof HandoffExtension.server, "function")
})

test("chat.message injects startup context once per session when active HANDOFF.md exists", async (t) => {
  const repoDir = createTempGitRepo()
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }))

  const hooks = await HandoffExtension.server({ directory: repoDir })

  // 1. No HANDOFF.md yet -> no synthetic part added
  const outEmpty = { parts: [{ type: "text", text: "Hello" }] }
  await hooks["chat.message"]({ sessionID: "ses_no_handoff" }, outEmpty)
  assert.equal(outEmpty.parts.length, 1)

  // 2. Write active HANDOFF.md
  fs.writeFileSync(
    path.join(repoDir, "HANDOFF.md"),
    [
      "# Handoff",
      "",
      "> Last updated: 2026-11-23T01:00:00.000Z (via claude-code · manual)",
      "",
      "## Overview",
      "",
      "Cross-agent test repo.",
      "",
      "## Current status",
      "",
      "**Done**",
      "- Built core module",
      "",
      "**In progress**",
      "- Wiring OpenCode extension",
      "",
      "**Next**",
      "- Run verification tests",
      "",
      "## Gotchas / constraints",
      "",
      "- Never mutate tracked .gitignore",
      "",
    ].join("\n"),
    "utf8",
  )

  const outFirst = {
    message: { id: "msg_1", sessionID: "ses_alpha" },
    parts: [
      {
        id: "prt_01",
        sessionID: "ses_alpha",
        messageID: "msg_1",
        type: "text",
        text: "Continue where we left off",
      },
    ],
  }
  await hooks["chat.message"](
    {
      sessionID: "ses_alpha",
      messageID: "msg_1",
      model: { providerID: "google", modelID: "gemini-2.5-pro" },
    },
    outFirst,
  )

  assert.equal(outFirst.parts.length, 2)
  assert.match(outFirst.parts[1].text, /\[Handoff Context from HANDOFF\.md\]/)
  assert.match(outFirst.parts[1].text, /Wiring OpenCode extension/)
  assert.match(outFirst.parts[1].text, /Never mutate tracked \.gitignore/)
  assert.equal(outFirst.parts[1].synthetic, true)
  assert.match(outFirst.parts[1].id, /^prt_/)
  assert.equal(outFirst.parts[1].sessionID, "ses_alpha")
  assert.equal(outFirst.parts[1].messageID, "msg_1")

  // 3. Second message on same session -> does NOT inject again
  const outSecond = { parts: [{ type: "text", text: "Follow-up question" }] }
  await hooks["chat.message"]({ sessionID: "ses_alpha" }, outSecond)
  assert.equal(outSecond.parts.length, 1)

  // 4. Fresh session ID -> injects again
  const outFreshSession = { parts: [{ type: "text", text: "New session start" }] }
  await hooks["chat.message"]({ sessionID: "ses_beta" }, outFreshSession)
  assert.equal(outFreshSession.parts.length, 2)
  assert.match(outFreshSession.parts[1].text, /\[Handoff Context from HANDOFF\.md\]/)
})

test("experimental.session.compaction.provide updates HANDOFF.md, writes .git/info/exclude, and populates output.summary", async (t) => {
  const repoDir = createTempGitRepo()
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-"))
  const cfgPath = writeTempConfig(cfgDir)
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1"
  process.env.HANDOFF_CONFIG_PATH = cfgPath

  t.after(() => {
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true })
  fs.writeFileSync(path.join(repoDir, "src", "auth.ts"), "export const auth = true\n", "utf8")

  const hooks = await HandoffExtension.server({ directory: repoDir })

  const sampleHead = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Implement token validation in src/auth.ts" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "Added initial auth module and checked edge cases." },
        {
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath: "src/auth.ts" } },
        },
      ],
    },
  ]

  const output = {}
  await hooks["experimental.session.compaction.provide"](
    {
      sessionID: "ses_compact_1",
      reason: "percentage",
      head: sampleHead,
    },
    output,
  )

  const handoffPath = path.join(repoDir, "HANDOFF.md")
  assert.equal(fs.existsSync(handoffPath), true)
  const handoffContent = fs.readFileSync(handoffPath, "utf8")
  assert.match(handoffContent, /> Last updated: .+ \(via opencode · percentage\)/)
  assert.match(handoffContent, /src\/auth\.ts/)

  const excludePath = path.join(repoDir, ".git", "info", "exclude")
  assert.equal(fs.existsSync(excludePath), true)
  const excludeContent = fs.readFileSync(excludePath, "utf8")
  assert.match(excludeContent, /^HANDOFF\.md$/m)
  assert.match(excludeContent, /^\.opencode\/handoff\.state\.json$/m)

  assert.ok(output.summary)
  assert.equal(output.summary.displayText, "HANDOFF.md updated & context compacted")
  assert.match(
    output.summary.modelText,
    /^# Handoff & Compaction Summary \(from HANDOFF\.md\)/,
  )
  assert.match(output.summary.modelText, /src\/auth\.ts/)
  assert.match(output.summary.modelText, /## Current status/)
  assert.ok(output.summary.modelText.includes(handoffPath))
  assert.equal(output.summary.modelText.includes("<!--"), false)
  assert.equal(output.summary.metadata.reason, "percentage")
  assert.ok(output.summary.metadata.handoffUpdatedAt)

  const presetOutput = { summary: { modelText: "preset", displayText: "preset" } }
  await hooks["experimental.session.compaction.provide"](
    { sessionID: "ses_compact_1", head: sampleHead },
    presetOutput,
  )
  assert.equal(presetOutput.summary.modelText, "preset")
})

test("compaction.provide uses ctx.client with subagent/model selection, recursion guard, and session cleanup", async (t) => {
  const repoDir = createTempGitRepo()
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-client-"))
  const cfgPath = writeTempConfig(cfgDir, { useSubagent: false })
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_CONFIG_PATH = cfgPath

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  const calls = { created: 0, prompted: [], deleted: [], envDuringPrompt: null }
  let hooksRef = null

  const mockClient = {
    session: {
      async create(opts) {
        calls.created += 1
        return { data: { id: `ses_ephemeral_${calls.created}`, parentID: opts?.body?.parentID } }
      },
      async prompt(opts) {
        calls.envDuringPrompt = process.env.HANDOFF_CAPTURE_ACTIVE
        calls.prompted.push(opts)

        const nestedOut = { parts: [{ type: "text", text: "nested" }] }
        await hooksRef["chat.message"]({ sessionID: opts.path.id }, nestedOut)
        assert.equal(nestedOut.parts.length, 1)

        const nestedCompact = {}
        await hooksRef["experimental.session.compaction.provide"](
          { sessionID: opts.path.id, head: [] },
          nestedCompact,
        )
        assert.equal(nestedCompact.summary, undefined)

        return {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  current_status: {
                    done: ["Implemented OpenCode extension in handoff.ts"],
                    in_progress: ["Running integration verification"],
                    next: "Proceed to cross-host tests",
                  },
                  new_decisions: [
                    "Used experimental.session.compaction.provide to make HANDOFF.md the compaction summary",
                  ],
                  new_gotchas: [
                    "Guard ephemeral capture sessions with HANDOFF_CAPTURE_ACTIVE to prevent recursion",
                  ],
                }),
              },
            ],
          },
        }
      },
      async delete(opts) {
        calls.deleted.push(opts.path.id)
        return { data: true }
      },
    },
  }

  hooksRef = await HandoffExtension.server({ directory: repoDir, client: mockClient })

  await hooksRef["chat.message"](
    {
      sessionID: "ses_main",
      model: { providerID: "google", modelID: "gemini-2.5-pro" },
    },
    { parts: [{ type: "text", text: "Build OpenCode adapter" }] },
  )

  const compactOut = {}
  await hooksRef["experimental.session.compaction.provide"](
    {
      sessionID: "ses_main",
      reason: "auto",
      head: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "Build OpenCode adapter" }],
        },
      ],
    },
    compactOut,
  )

  assert.equal(calls.created, 1)
  assert.equal(calls.envDuringPrompt, "1")
  assert.equal(process.env.HANDOFF_CAPTURE_ACTIVE, undefined)
  assert.deepEqual(calls.deleted, ["ses_ephemeral_1"])
  assert.deepEqual(calls.prompted[0].body.model, {
    providerID: "google",
    modelID: "gemini-2.5-pro",
  })

  const handoffMd = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8")
  assert.match(handoffMd, /Implemented OpenCode extension in handoff\.ts/)
  assert.match(handoffMd, /Proceed to cross-host tests/)
  assert.match(handoffMd, /experimental\.session\.compaction\.provide/)
  assert.match(handoffMd, /HANDOFF_CAPTURE_ACTIVE/)
  assert.equal(compactOut.summary.displayText, "HANDOFF.md updated & context compacted")
})

test("session.end respects captureOnSessionEnd toggle and command.execute.before injects /handoff instructions", async (t) => {
  const repoDir = createTempGitRepo()
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-end-"))
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1"

  t.after(() => {
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, { captureOnSessionEnd: false })
  const hooks = await HandoffExtension.server({ directory: repoDir })
  await hooks["session.end"]({ sessionID: "ses_end_1", directory: repoDir })
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), false)

  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, { captureOnSessionEnd: true })
  await hooks["session.end"]({ sessionID: "ses_end_2", directory: repoDir })
  assert.equal(fs.existsSync(path.join(repoDir, "HANDOFF.md")), true)
  const md = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8")
  assert.match(md, /\(via opencode · session-end\)/)

  const cmdOut = { parts: [] }
  await hooks["command.execute.before"](
    { command: "handoff", arguments: "focus on auth token refresh", sessionID: "ses_cmd" },
    cmdOut,
  )
  assert.equal(cmdOut.parts.length, 1)
  assert.match(cmdOut.parts[0].text, /compact-handoff/)
  assert.match(cmdOut.parts[0].text, /HANDOFF\.md/)
  assert.match(cmdOut.parts[0].text, /focus on auth token refresh/)

  const otherOut = { parts: [] }
  await hooks["command.execute.before"](
    { command: "commit", arguments: "", sessionID: "ses_cmd" },
    otherOut,
  )
  assert.equal(otherOut.parts.length, 0)
})

test("extractBoundedTranscript caps large message heads to <= 12 KB while preserving UTF-8 and touched paths", () => {
  const head = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "初始目标：重构跨 Agent 的 HANDOFF 状态同步模块" }],
    },
  ]
  for (let i = 0; i < 30; i++) {
    head.push({
      info: { role: "assistant" },
      parts: [
        { type: "text", text: `Turn ${i}: ${"详细分析与实现说明 ".repeat(120)}` },
        {
          type: "tool",
          tool: "edit",
          state: { input: { filePath: `src/module-${i}.ts` } },
        },
      ],
    })
  }

  const bounded = extractBoundedTranscript(head)
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 12 * 1024)
  assert.match(bounded, /初始目标/)
  assert.match(bounded, /src\/module-29\.ts/)
  assert.equal(bounded.includes("\uFFFD"), false)
})

test("server returns compaction extension owner metadata and getModelContextLimit resolves provider catalog + heuristics", async (t) => {
  const repoDir = createTempGitRepo()
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }))

  const hooks = await HandoffExtension.server({ directory: repoDir })
  assert.deepEqual(hooks.compaction, {
    owner: "extension",
    label: "Handoff",
    description: "Updates HANDOFF.md and compacts at turn boundaries (emergency cap at 85%).",
  })

  const mockCatalog = {
    all: [
      {
        id: "anthropic",
        models: {
          "claude-opus-4-6": { limit: { context: 1_000_000 } },
          "claude-haiku-4-5": { limit: { context: 200_000 } },
        },
      },
    ],
  }

  assert.equal(
    getModelContextLimit({ providerID: "anthropic", modelID: "claude-opus-4-6" }, mockCatalog),
    1_000_000,
  )
  assert.equal(
    getModelContextLimit({ providerID: "anthropic", modelID: "claude-haiku-4-5" }, mockCatalog),
    200_000,
  )
  assert.equal(
    getModelContextLimit({ providerID: "google", modelID: "gemini-2.5-pro" }),
    1_048_576,
  )
  assert.equal(
    getModelContextLimit({ providerID: "custom", modelID: "unknown-claude-variant" }),
    200_000,
  )
  assert.equal(
    getModelContextLimit({ providerID: "custom", modelID: "inline-model", limit: { context: 128_000 } }),
    128_000,
  )
})

test("experimental.chat.messages.transform defers 62% mid-turn, compacts at turn boundary, and enforces 85% emergency cap", async (t) => {
  const repoDir = createTempGitRepo()
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-turn-"))
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, {
    trigger: { mode: "percentage", percentage: 60, tokens: 100000 },
  })

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  const hooks = await HandoffExtension.server({ directory: repoDir })
  const sessionID = "ses_turn_boundary"
  const geminiModel = { providerID: "google", modelID: "gemini-2.5-pro" } // 1,048,576 context
  const baseMessages = [{ info: { role: "user", sessionID }, parts: [{ type: "text", text: "Go" }] }]

  await hooks["chat.message"]({ sessionID, model: geminiModel }, { parts: [{ type: "text", text: "Go" }] })
  await hooks["experimental.chat.step.end"]({
    sessionID,
    tokens: { input: 300_000, output: 14_572 },
  })
  const outStart = { messages: [...baseMessages] }
  await hooks["experimental.chat.messages.transform"](
    { sessionID, compactionAvailable: true, model: geminiModel },
    outStart,
  )
  assert.equal(outStart.pendingCompaction, undefined)

  await hooks["experimental.chat.step.end"]({
    sessionID,
    tokens: { input: 630_000, output: 20_117 },
  })
  const outMidTurn62 = {
    messages: [
      ...baseMessages,
      { info: { role: "assistant", sessionID }, parts: [{ type: "text", text: "Calling tool..." }] },
    ],
  }
  await hooks["experimental.chat.messages.transform"](
    { sessionID, compactionAvailable: true, model: geminiModel },
    outMidTurn62,
  )
  assert.equal(outMidTurn62.pendingCompaction, undefined)

  await hooks["chat.message"]({ sessionID, model: geminiModel }, { parts: [{ type: "text", text: "Next" }] })
  const outBoundary62 = {
    messages: [
      ...outMidTurn62.messages,
      { info: { role: "user", sessionID }, parts: [{ type: "text", text: "Next" }] },
    ],
  }
  await hooks["experimental.chat.messages.transform"](
    { sessionID, compactionAvailable: true, model: geminiModel },
    outBoundary62,
  )
  assert.deepEqual(outBoundary62.pendingCompaction, { auto: true })

  const sesEmergency = "ses_emergency"
  await hooks["chat.message"]({ sessionID: sesEmergency, model: geminiModel }, { parts: [{ type: "text", text: "Start" }] })
  const consumeBoundary = { messages: [{ info: { role: "user", sessionID: sesEmergency }, parts: [{ type: "text", text: "Start" }] }] }
  await hooks["experimental.chat.messages.transform"](
    { sessionID: sesEmergency, compactionAvailable: true, model: geminiModel },
    consumeBoundary,
  )
  assert.equal(consumeBoundary.pendingCompaction, undefined)

  await hooks["experimental.chat.step.end"]({
    sessionID: sesEmergency,
    tokens: { input: 880_000, output: 22_000 },
  })
  const outEmergency86 = {
    messages: [
      ...consumeBoundary.messages,
      { info: { role: "assistant", sessionID: sesEmergency }, parts: [{ type: "text", text: "Huge tool output" }] },
    ],
  }
  await hooks["experimental.chat.messages.transform"](
    { sessionID: sesEmergency, compactionAvailable: true, model: geminiModel },
    outEmergency86,
  )
  assert.deepEqual(outEmergency86.pendingCompaction, { auto: true })

  const outCompactionPurpose = { messages: outEmergency86.messages }
  await hooks["experimental.chat.messages.transform"](
    { sessionID: sesEmergency, purpose: "compaction", compactionAvailable: true, model: geminiModel },
    outCompactionPurpose,
  )
  assert.equal(outCompactionPurpose.pendingCompaction, undefined)

  const outUnavailable = { messages: outEmergency86.messages }
  await hooks["experimental.chat.messages.transform"](
    { sessionID: sesEmergency, compactionAvailable: false, model: geminiModel },
    outUnavailable,
  )
  assert.equal(outUnavailable.pendingCompaction, undefined)
})

test("subagent sessions (explore agent or parentID) never overwrite HANDOFF.md during compaction or transform", async (t) => {
  const repoDir = createTempGitRepo()
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-sub-"))
  const prevDisable = process.env.HANDOFF_DISABLE_EXTERNAL_LLM
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_DISABLE_EXTERNAL_LLM = "1"
  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir)

  t.after(() => {
    if (prevDisable === undefined) delete process.env.HANDOFF_DISABLE_EXTERNAL_LLM
    else process.env.HANDOFF_DISABLE_EXTERNAL_LLM = prevDisable
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  const originalHandoff = [
    "# Handoff",
    "",
    "> Last updated: 2026-11-25T00:00:00.000Z (via opencode · manual)",
    "",
    "## Current status",
    "",
    "**Done**",
    "- Main session task A",
    "",
    "**In progress**",
    "- Main session task B",
    "",
    "**Next**",
    "- Continue main task C",
    "",
  ].join("\n")
  const handoffPath = path.join(repoDir, "HANDOFF.md")
  fs.writeFileSync(handoffPath, originalHandoff, "utf8")

  const mockClient = {
    session: {
      async get(opts) {
        if (opts.path.id === "ses_child_by_parent") {
          return { data: { id: "ses_child_by_parent", parentID: "ses_main_parent" } }
        }
        return { data: { id: opts.path.id } }
      },
      async create() {
        throw new Error("Should not create capture session for subagent")
      },
      async prompt() {
        throw new Error("Should not prompt for subagent")
      },
    },
  }

  const hooks = await HandoffExtension.server({ directory: repoDir, client: mockClient })

  await hooks["chat.message"](
    { sessionID: "ses_explore_1", agent: "explore" },
    { parts: [{ type: "text", text: "Explore repo" }] },
  )
  const outTransformExplore = {
    messages: [{ info: { role: "user", sessionID: "ses_explore_1" }, parts: [{ type: "text", text: "Explore" }] }],
  }
  await hooks["experimental.chat.messages.transform"](
    { sessionID: "ses_explore_1", compactionAvailable: true },
    outTransformExplore,
  )
  assert.equal(outTransformExplore.pendingCompaction, undefined)

  const compactExploreOut = {}
  await hooks["experimental.session.compaction.provide"](
    {
      sessionID: "ses_explore_1",
      head: [{ info: { role: "user" }, parts: [{ type: "text", text: "Explore" }] }],
    },
    compactExploreOut,
  )
  assert.equal(compactExploreOut.summary, undefined)
  assert.equal(fs.readFileSync(handoffPath, "utf8"), originalHandoff)

  const compactChildOut = {}
  await hooks["experimental.session.compaction.provide"](
    {
      sessionID: "ses_child_by_parent",
      head: [{ info: { role: "user" }, parts: [{ type: "text", text: "Child impl task" }] }],
    },
    compactChildOut,
  )
  assert.equal(compactChildOut.summary, undefined)
  assert.equal(fs.readFileSync(handoffPath, "utf8"), originalHandoff)
})

test("createClientLlmRunner passes activeModel with useSubagent=true, aborts/deletes on failure, and enforces 3-min backoff", async (t) => {
  const repoDir = createTempGitRepo()
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-backoff-"))
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, {
    useSubagent: true,
    model: "current",
  })

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  const calls = { create: 0, prompt: 0, aborted: [], deleted: [], promptedBodies: [] }
  let shouldFail = false

  const mockClient = {
    session: {
      async create() {
        calls.create += 1
        return { data: { id: `ses_cap_${calls.create}` } }
      },
      async prompt(opts) {
        calls.prompt += 1
        calls.promptedBodies.push(opts.body)
        if (shouldFail) {
          throw new Error("401 Unauthorized")
        }
        return {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  current_status: {
                    done: ["Captured with activeModel"],
                    in_progress: [],
                    next: "Continue testing",
                  },
                  new_decisions: [],
                  new_gotchas: [],
                }),
              },
            ],
          },
        }
      },
      async abort(opts) {
        calls.aborted.push(opts.path.id)
        return { data: true }
      },
      async delete(opts) {
        calls.deleted.push(opts.path.id)
        return { data: true }
      },
    },
  }

  const hooks = await HandoffExtension.server({ directory: repoDir, client: mockClient })
  const geminiModel = { providerID: "google", modelID: "gemini-2.5-pro" }
  await hooks["chat.message"](
    { sessionID: "ses_model_test", model: geminiModel },
    { parts: [{ type: "text", text: "Start" }] },
  )

  const outSuccess = {}
  await hooks["experimental.session.compaction.provide"](
    {
      sessionID: "ses_model_test",
      head: [{ info: { role: "user" }, parts: [{ type: "text", text: "Start" }] }],
    },
    outSuccess,
  )
  assert.equal(calls.create, 1)
  assert.equal(calls.prompt, 1)
  assert.equal(calls.promptedBodies[0].agent, "explore")
  assert.deepEqual(calls.promptedBodies[0].model, geminiModel)
  assert.deepEqual(calls.deleted, ["ses_cap_1"])

  shouldFail = true
  fs.writeFileSync(path.join(repoDir, "extra.ts"), "export const x = 1\n", "utf8")
  const outFail = {}
  const t0 = Date.now()
  await hooks["experimental.session.compaction.provide"](
    {
      sessionID: "ses_model_test",
      head: [{ info: { role: "user" }, parts: [{ type: "text", text: "Hit 401" }] }],
    },
    outFail,
  )
  const elapsed1 = Date.now() - t0
  assert.ok(elapsed1 < 1000)
  assert.equal(calls.create, 2)
  assert.equal(calls.prompt, 2)
  assert.deepEqual(calls.aborted, ["ses_cap_2"])
  assert.deepEqual(calls.deleted, ["ses_cap_1", "ses_cap_2"])
  assert.ok(outFail.summary)

  const outBackoff = {}
  const t1 = Date.now()
  await hooks["experimental.session.compaction.provide"](
    {
      sessionID: "ses_model_test",
      head: [{ info: { role: "user" }, parts: [{ type: "text", text: "Backoff check" }] }],
    },
    outBackoff,
  )
  const elapsed2 = Date.now() - t1
  assert.ok(elapsed2 < 1000)
  assert.equal(calls.create, 2)
  assert.equal(calls.prompt, 2)
  assert.ok(outBackoff.summary)
})

test("compaction.provide delegates transcriptEntries in pure-discussion mode with up-to-48KB budget and captures open_questions", async (t) => {
  const repoDir = createTempGitRepo("handoff-oc-discussion-")
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-oc-disc-cfg-"))
  const prevCfg = process.env.HANDOFF_CONFIG_PATH
  process.env.HANDOFF_CONFIG_PATH = writeTempConfig(cfgDir, { useSubagent: false })

  t.after(() => {
    if (prevCfg === undefined) delete process.env.HANDOFF_CONFIG_PATH
    else process.env.HANDOFF_CONFIG_PATH = prevCfg
    fs.rmSync(repoDir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  })

  const promptedTexts = []
  const mockClient = {
    session: {
      async create() {
        return { data: { id: "ses_ephemeral_disc" } }
      },
      async prompt(opts) {
        promptedTexts.push(opts.body.parts[0].text)
        return {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  current_status: {
                    done: ["Completed architecture discussion for sync protocol"],
                    in_progress: ["Evaluating conflict resolution strategy"],
                    next: "Confirm CRDT vs LWW preference before coding",
                  },
                  new_decisions: ["Use WebSocket binary frames for delta sync"],
                  new_gotchas: [],
                  open_questions: ["Should offline edits merge via CRDT or last-write-wins?"],
                }),
              },
            ],
          },
        }
      },
      async delete() {
        return { data: true }
      },
    },
  }

  const hooks = await HandoffExtension.server({ directory: repoDir, client: mockClient })
  const longCode = [
    "```ts",
    ...Array.from({ length: 12 }, (_, i) => `const snippet${i} = ${i};`),
    "```",
  ].join("\n")

  const discussionHead = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Design the offline sync protocol before writing code" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        {
          type: "text",
          text: [
            "### Sync Architecture",
            longCode,
            "- Should offline edits merge via CRDT or last-write-wins?",
          ].join("\n"),
        },
      ],
    },
  ]
  for (let i = 1; i <= 8; i++) {
    discussionHead.push({
      info: { role: "user" },
      parts: [{ type: "text", text: `Compare payload overhead for sync scenario #${i}` }],
    })
    discussionHead.push({
      info: { role: "assistant" },
      parts: [
        {
          type: "text",
          text: `- Payload comparison #${i}: ${"compact protobuf overhead analysis ".repeat(75)}`,
        },
      ],
    })
  }

  const out = {}
  await hooks["experimental.session.compaction.provide"](
    { sessionID: "ses_disc_main", reason: "percentage", head: discussionHead },
    out,
  )

  assert.equal(promptedTexts.length, 1)
  assert.match(promptedTexts[0], /Design \/ Planning \/ Research Discussion Mode/)
  assert.match(promptedTexts[0], /\[code block omitted: ts, 12 lines\]/)
  // Clean git repo -> > 12 KB transcript is preserved within 48 KB budget
  assert.ok(Buffer.byteLength(promptedTexts[0], "utf8") > 16 * 1024)

  const handoffMd = fs.readFileSync(path.join(repoDir, "HANDOFF.md"), "utf8")
  assert.match(handoffMd, /## Open questions/)
  assert.match(handoffMd, /Should offline edits merge via CRDT or last-write-wins\?/)
  assert.match(
    out.summary.modelText,
    /Should offline edits merge via CRDT or last-write-wins\?/,
  )
})
