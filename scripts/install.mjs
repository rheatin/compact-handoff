#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  atomicWriteFileSync,
  loadConfig,
  mapOpenCodeTrigger,
  saveConfig,
  stripJsonc,
} from "./handoff-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

const VALID_HOSTS = new Set(["opencode", "pi", "claude", "gemini"]);
const DEFAULT_HOSTS = ["opencode", "pi", "claude"];

export function printInstallHelp() {
  console.log(`compact-handoff install — Idempotent multi-host installer

Usage:
  node scripts/install.mjs [options]
  compact-handoff install [options]

Options:
  --hosts <list>          Comma-separated hosts: opencode,pi,claude,gemini or "all"
                          (default: opencode,pi,claude)
  --opencode-dir <dir>    Override OpenCode config directory (default: $OPENCODE_CONFIG_DIR or ~/.config/opencode)
  --mode <mode>           Trigger mode: percentage | tokens | auto
  --percentage <1-100>    Percentage trigger threshold (default: 50)
  --tokens <N>            Token trigger threshold (default: 100000)
  --session-end <on|off>  Enable/disable session-end capture
  --subagent <on|off>     Enable/disable subagent usage in OpenCode capture
  --link-handoff          Also link ~/.local/bin/handoff -> compact-handoff CLI
  --copy                  Copy files instead of symlinking skills/extensions
  --dry-run               Print planned actions without writing files
  --uninstall             Remove installed compact-handoff links and host hooks
  -h, --help              Show this help
`);
}

function parseBoolToggle(val, flagName) {
  const norm = String(val ?? "")
    .trim()
    .toLowerCase();
  if (["on", "true", "1", "yes"].includes(norm)) return true;
  if (["off", "false", "0", "no"].includes(norm)) return false;
  throw new Error(`Invalid value for ${flagName}: expected on|off, got "${val}"`);
}

export function parseInstallArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${arg}"`);
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      continue;
    }
    const key = arg.slice(2);
    if (["uninstall", "dry-run", "link-handoff", "copy", "help"].includes(key)) {
      flags[key] = true;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      flags[key] = argv[++i];
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

export function parseHostList(hostsArg) {
  if (!hostsArg || typeof hostsArg !== "string") {
    return [...DEFAULT_HOSTS];
  }
  const raw = hostsArg.trim().toLowerCase();
  if (raw === "all") {
    return ["opencode", "pi", "claude", "gemini"];
  }
  const list = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const mapped = [];
  for (const h of list) {
    const norm = h === "claude-code" ? "claude" : h === "gemini-cli" ? "gemini" : h;
    if (!VALID_HOSTS.has(norm)) {
      throw new Error(
        `Unknown host "${h}". Supported hosts: opencode, pi, claude, gemini`,
      );
    }
    if (!mapped.includes(norm)) mapped.push(norm);
  }
  return mapped;
}

function lstatSafe(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function copyDirRecursive(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function installSymlinkOrCopy(srcPath, dstPath, { copy = false, dryRun = false, isDir = false, actions }) {
  const existing = lstatSafe(dstPath);
  if (!copy) {
    if (existing?.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(dstPath);
      const resolvedCurrent = path.resolve(path.dirname(dstPath), currentTarget);
      if (resolvedCurrent === path.resolve(srcPath)) {
        actions.push(`keep symlink ${dstPath} -> ${srcPath}`);
        return;
      }
    }
    actions.push(`symlink ${dstPath} -> ${srcPath}`);
    if (dryRun) return;
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    if (existing) {
      fs.rmSync(dstPath, { recursive: true, force: true });
    }
    try {
      fs.symlinkSync(srcPath, dstPath, isDir ? "dir" : "file");
      return;
    } catch {
      // Fall back to copy if symlinks are unsupported
    }
  }

  actions.push(`copy ${srcPath} -> ${dstPath}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  if (existing?.isSymbolicLink()) {
    fs.unlinkSync(dstPath);
  }
  if (isDir) {
    copyDirRecursive(srcPath, dstPath);
  } else {
    fs.copyFileSync(srcPath, dstPath);
  }
}

function installSkillDir(repoRoot, skillTargetDir, { copy = false, dryRun = false, actions }) {
  const existing = lstatSafe(skillTargetDir);
  if (!copy && (!existing || existing.isSymbolicLink())) {
    installSymlinkOrCopy(repoRoot, skillTargetDir, {
      copy: false,
      dryRun,
      isDir: true,
      actions,
    });
    return;
  }

  actions.push(`sync skill files into ${skillTargetDir}`);
  if (dryRun) return;
  fs.mkdirSync(skillTargetDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "SKILL.md"), path.join(skillTargetDir, "SKILL.md"));
  copyDirRecursive(path.join(repoRoot, "scripts"), path.join(skillTargetDir, "scripts"));
  copyDirRecursive(path.join(repoRoot, "templates"), path.join(skillTargetDir, "templates"));
}

function removeIfPointsToRepo(dstPath, expectedTarget, { dryRun = false, actions }) {
  const st = lstatSafe(dstPath);
  if (!st) return;
  if (st.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(dstPath), fs.readlinkSync(dstPath));
    if (resolved === path.resolve(expectedTarget)) {
      actions.push(`remove symlink ${dstPath}`);
      if (!dryRun) fs.unlinkSync(dstPath);
    }
  }
}

function removePathAlways(dstPath, { dryRun = false, actions }) {
  const st = lstatSafe(dstPath);
  if (!st) return;
  actions.push(`remove ${dstPath}`);
  if (!dryRun) {
    fs.rmSync(dstPath, { recursive: true, force: true });
  }
}

function readJsonFileSafe(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8");
  const { cleaned } = stripJsonc(raw);
  const parsed = JSON.parse(cleaned);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : fallback;
}

function resolveOpenCodePluginTarget(openCodeDir) {
  const extDir = path.join(openCodeDir, "extensions");
  const plugDir = path.join(openCodeDir, "plugins");
  if (!fs.existsSync(extDir) && fs.existsSync(plugDir)) {
    return path.join(plugDir, "handoff.ts");
  }
  return path.join(extDir, "handoff.ts");
}

function configureOpenCodeJson(openCodeDir, trigger, { dryRun = false, actions }) {
  const jsoncPath = path.join(openCodeDir, "opencode.jsonc");
  const jsonPath = path.join(openCodeDir, "opencode.json");
  const targetPath = fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;

  let existing = {};
  if (fs.existsSync(targetPath)) {
    try {
      existing = readJsonFileSafe(targetPath, {});
    } catch {
      actions.push(`skip malformed OpenCode config ${targetPath}`);
      return;
    }
  }

  const existingCompaction =
    existing.compaction &&
    typeof existing.compaction === "object" &&
    !Array.isArray(existing.compaction)
      ? existing.compaction
      : {};

  const updated = {
    ...existing,
    compaction: {
      ...existingCompaction,
      trigger: mapOpenCodeTrigger(trigger),
    },
  };

  actions.push(`configure OpenCode compaction in ${targetPath}`);
  if (!dryRun) {
    atomicWriteFileSync(targetPath, `${JSON.stringify(updated, null, 2)}\n`);
  }
}

function isOurClaudeHookCommand(cmd) {
  if (typeof cmd !== "string") return false;
  return /\bcompact-handoff\s+hook\s+claude\b/.test(cmd);
}

function mergeClaudeHookGroup(existingGroups, matcher, entry) {
  const cleaned = [];
  for (const group of Array.isArray(existingGroups) ? existingGroups : []) {
    if (!group || typeof group !== "object") continue;
    const filteredHooks = Array.isArray(group.hooks)
      ? group.hooks.filter((h) => !isOurClaudeHookCommand(h?.command))
      : [];
    if (filteredHooks.length > 0) {
      cleaned.push({ ...group, hooks: filteredHooks });
    }
  }

  const newGroup = matcher ? { matcher, hooks: [entry] } : { hooks: [entry] };
  cleaned.push(newGroup);
  return cleaned;
}

function stripClaudeHookGroups(existingGroups) {
  const cleaned = [];
  for (const group of Array.isArray(existingGroups) ? existingGroups : []) {
    if (!group || typeof group !== "object") continue;
    const filteredHooks = Array.isArray(group.hooks)
      ? group.hooks.filter((h) => !isOurClaudeHookCommand(h?.command))
      : [];
    if (filteredHooks.length > 0) {
      cleaned.push({ ...group, hooks: filteredHooks });
    }
  }
  return cleaned;
}

function configureClaudeSettings(settingsPath, binPath, { uninstall = false, dryRun = false, actions }) {
  if (uninstall) {
    if (!fs.existsSync(settingsPath)) return;
    let settings;
    try {
      settings = readJsonFileSafe(settingsPath, {});
    } catch {
      return;
    }
    if (!settings.hooks || typeof settings.hooks !== "object") return;
    const nextHooks = { ...settings.hooks };
    for (const eventName of ["PreCompact", "SessionStart", "SessionEnd"]) {
      if (Array.isArray(nextHooks[eventName])) {
        const stripped = stripClaudeHookGroups(nextHooks[eventName]);
        if (stripped.length > 0) nextHooks[eventName] = stripped;
        else delete nextHooks[eventName];
      }
    }
    settings.hooks = nextHooks;
    actions.push(`remove compact-handoff hooks from ${settingsPath}`);
    if (!dryRun) {
      atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
    return;
  }

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = readJsonFileSafe(settingsPath, {});
  }
  const existingHooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};

  const nextHooks = {
    ...existingHooks,
    PreCompact: mergeClaudeHookGroup(existingHooks.PreCompact, "*", {
      type: "command",
      command: `${binPath} hook claude precompact`,
      timeout: 30,
    }),
    SessionStart: mergeClaudeHookGroup(
      existingHooks.SessionStart,
      "^(startup|resume|clear|compact|fork)$",
      {
        type: "command",
        command: `${binPath} hook claude sessionstart`,
        timeout: 5,
      },
    ),
    SessionEnd: mergeClaudeHookGroup(existingHooks.SessionEnd, null, {
      type: "command",
      command: `${binPath} hook claude sessionend`,
      timeout: 15,
    }),
  };

  settings.hooks = nextHooks;
  actions.push(`merge Claude Code hooks into ${settingsPath}`);
  if (!dryRun) {
    atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

function configureGeminiHooks(hooksPath, binPath, { uninstall = false, dryRun = false, actions }) {
  if (uninstall) {
    if (!fs.existsSync(hooksPath)) return;
    let hooksDoc;
    try {
      hooksDoc = readJsonFileSafe(hooksPath, {});
    } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(hooksDoc, "compact-handoff")) {
      delete hooksDoc["compact-handoff"];
      actions.push(`remove compact-handoff hooks from ${hooksPath}`);
      if (!dryRun) {
        atomicWriteFileSync(hooksPath, `${JSON.stringify(hooksDoc, null, 2)}\n`);
      }
    }
    return;
  }

  let hooksDoc = {};
  if (fs.existsSync(hooksPath)) {
    hooksDoc = readJsonFileSafe(hooksPath, {});
  }

  hooksDoc["compact-handoff"] = {
    enabled: true,
    SessionStart: [
      {
        type: "command",
        command: `${binPath} hook gemini sessionstart`,
        timeout: 10,
      },
    ],
    PreCompact: [
      {
        type: "command",
        command: `${binPath} hook gemini precompact`,
        timeout: 30,
      },
    ],
    Stop: [
      {
        type: "command",
        command: `${binPath} hook gemini stop`,
        timeout: 30,
      },
    ],
  };

  actions.push(`merge Gemini CLI hooks into ${hooksPath}`);
  if (!dryRun) {
    atomicWriteFileSync(hooksPath, `${JSON.stringify(hooksDoc, null, 2)}\n`);
  }
}

export async function runInstaller(options = {}) {
  const homeDir = path.resolve(
    options.homeDir || process.env.HANDOFF_HOME || os.homedir(),
  );
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const hosts = Array.isArray(options.hosts)
    ? options.hosts
    : parseHostList(options.hosts);
  const uninstall = Boolean(options.uninstall);
  const dryRun = Boolean(options.dryRun);
  const copy = Boolean(options.copy);
  const linkHandoff = Boolean(options.linkHandoff);

  const openCodeDir = path.resolve(
    options.openCodeDir ||
      process.env.OPENCODE_CONFIG_DIR ||
      path.join(homeDir, ".config", "opencode"),
  );
  const configPath = path.resolve(
    options.configPath ||
      process.env.HANDOFF_CONFIG_PATH ||
      path.join(homeDir, ".config", "handoff", "config.json"),
  );
  const binDir = path.join(homeDir, ".local", "bin");
  const binPath = path.join(binDir, "compact-handoff");
  const legacyAliasPath = path.join(binDir, "handoff");
  const cliSrc = path.join(repoRoot, "scripts", "cli.mjs");

  const actions = [];

  if (uninstall) {
    removePathAlways(binPath, { dryRun, actions });
    removeIfPointsToRepo(legacyAliasPath, cliSrc, { dryRun, actions });

    const skillDirs = [
      path.join(homeDir, ".agents", "skills", "compact-handoff"),
      path.join(homeDir, ".claude", "skills", "compact-handoff"),
      path.join(openCodeDir, "skills", "compact-handoff"),
      path.join(homeDir, ".gemini", "skills", "compact-handoff"),
    ];
    for (const dir of skillDirs) {
      removePathAlways(dir, { dryRun, actions });
    }

    if (hosts.includes("opencode")) {
      removeIfPointsToRepo(
        path.join(openCodeDir, "extensions", "handoff.ts"),
        path.join(repoRoot, "extensions", "opencode", "handoff.ts"),
        { dryRun, actions },
      );
      removeIfPointsToRepo(
        path.join(openCodeDir, "plugins", "handoff.ts"),
        path.join(repoRoot, "extensions", "opencode", "handoff.ts"),
        { dryRun, actions },
      );
    }
    if (hosts.includes("pi")) {
      removeIfPointsToRepo(
        path.join(homeDir, ".pi", "agent", "extensions", "handoff.ts"),
        path.join(repoRoot, "extensions", "pi", "handoff.ts"),
        { dryRun, actions },
      );
    }
    if (hosts.includes("claude")) {
      configureClaudeSettings(
        path.join(homeDir, ".claude", "settings.json"),
        binPath,
        { uninstall: true, dryRun, actions },
      );
    }
    if (hosts.includes("gemini")) {
      configureGeminiHooks(
        path.join(homeDir, ".gemini", "config", "hooks.json"),
        binPath,
        { uninstall: true, dryRun, actions },
      );
    }

    return { actions, dryRun, uninstall: true, hosts };
  }

  // 1. Config (~/.config/handoff/config.json)
  const configPatch = {};
  const triggerPatch = {};
  if (options.mode !== undefined) triggerPatch.mode = options.mode;
  if (options.percentage !== undefined) triggerPatch.percentage = options.percentage;
  if (options.tokens !== undefined) triggerPatch.tokens = options.tokens;
  if (Object.keys(triggerPatch).length > 0) configPatch.trigger = triggerPatch;
  if (options.captureOnSessionEnd !== undefined) {
    configPatch.captureOnSessionEnd = options.captureOnSessionEnd;
  }
  if (options.useSubagent !== undefined) {
    configPatch.useSubagent = options.useSubagent;
  }

  const configExists = fs.existsSync(configPath);
  const hasConfigUpdates = Object.keys(configPatch).length > 0;
  let activeConfig;

  if (!configExists || hasConfigUpdates) {
    actions.push(
      `${configExists ? "update" : "create"} config ${configPath}`,
    );
    if (!dryRun) {
      activeConfig = saveConfig(configPatch, {
        configPath,
        openCodeDir,
      });
    } else {
      const current = loadConfig({ configPath });
      activeConfig = {
        ...current,
        ...configPatch,
        trigger: { ...current.trigger, ...(configPatch.trigger || {}) },
      };
    }
  } else {
    activeConfig = loadConfig({ configPath });
    actions.push(`preserve existing config ${configPath}`);
  }

  // 2. CLI binary (~/.local/bin/compact-handoff + optional handoff alias)
  if (!dryRun && fs.existsSync(cliSrc)) {
    try {
      fs.chmodSync(cliSrc, 0o755);
    } catch {
      // ignore chmod errors
    }
  }
  installSymlinkOrCopy(cliSrc, binPath, { copy, dryRun, isDir: false, actions });
  if (linkHandoff || !lstatSafe(legacyAliasPath)) {
    installSymlinkOrCopy(cliSrc, legacyAliasPath, {
      copy,
      dryRun,
      isDir: false,
      actions,
    });
  }

  // 3. Skills (~/.agents/skills/compact-handoff + host skill directories)
  installSkillDir(
    repoRoot,
    path.join(homeDir, ".agents", "skills", "compact-handoff"),
    { copy, dryRun, actions },
  );
  if (hosts.includes("claude")) {
    installSkillDir(
      repoRoot,
      path.join(homeDir, ".claude", "skills", "compact-handoff"),
      { copy, dryRun, actions },
    );
  }
  if (hosts.includes("opencode")) {
    installSkillDir(
      repoRoot,
      path.join(openCodeDir, "skills", "compact-handoff"),
      { copy, dryRun, actions },
    );
  }
  if (hosts.includes("gemini")) {
    installSkillDir(
      repoRoot,
      path.join(homeDir, ".gemini", "skills", "compact-handoff"),
      { copy, dryRun, actions },
    );
  }

  // 4. Host extensions & hooks
  if (hosts.includes("opencode")) {
    const extTarget = resolveOpenCodePluginTarget(openCodeDir);
    installSymlinkOrCopy(
      path.join(repoRoot, "extensions", "opencode", "handoff.ts"),
      extTarget,
      { copy, dryRun, isDir: false, actions },
    );
    configureOpenCodeJson(openCodeDir, activeConfig.trigger, { dryRun, actions });
  }

  if (hosts.includes("pi")) {
    const piTarget = path.join(homeDir, ".pi", "agent", "extensions", "handoff.ts");
    installSymlinkOrCopy(
      path.join(repoRoot, "extensions", "pi", "handoff.ts"),
      piTarget,
      { copy, dryRun, isDir: false, actions },
    );
  }

  if (hosts.includes("claude")) {
    configureClaudeSettings(
      path.join(homeDir, ".claude", "settings.json"),
      binPath,
      { uninstall: false, dryRun, actions },
    );
  }

  if (hosts.includes("gemini")) {
    configureGeminiHooks(
      path.join(homeDir, ".gemini", "config", "hooks.json"),
      binPath,
      { uninstall: false, dryRun, actions },
    );
  }

  return { actions, dryRun, uninstall: false, hosts, config: activeConfig };
}

export async function runInstallFromCli(argv = process.argv.slice(2)) {
  const flags = parseInstallArgs(argv);
  if (flags.help) {
    printInstallHelp();
    return null;
  }

  const opts = {
    hosts: flags.hosts,
    uninstall: Boolean(flags.uninstall),
    dryRun: Boolean(flags["dry-run"]),
    copy: Boolean(flags.copy),
    linkHandoff: Boolean(flags["link-handoff"]),
    ...(flags["opencode-dir"] ? { openCodeDir: String(flags["opencode-dir"]) } : {}),
  };

  if (flags.mode !== undefined) {
    const mode = String(flags.mode).trim();
    if (!["percentage", "tokens", "auto"].includes(mode)) {
      throw new Error(`Invalid --mode "${mode}": expected percentage|tokens|auto`);
    }
    opts.mode = mode;
  }
  if (flags.percentage !== undefined) {
    const pct = Number(flags.percentage);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      throw new Error(`Invalid --percentage "${flags.percentage}": expected 1..100`);
    }
    opts.percentage = Math.round(pct);
  }
  if (flags.tokens !== undefined) {
    const tok = Number(flags.tokens);
    if (!Number.isFinite(tok) || tok < 1) {
      throw new Error(`Invalid --tokens "${flags.tokens}": expected positive integer`);
    }
    opts.tokens = Math.round(tok);
  }
  if (flags["session-end"] !== undefined) {
    opts.captureOnSessionEnd = parseBoolToggle(flags["session-end"], "--session-end");
  }
  if (flags.subagent !== undefined) {
    opts.useSubagent = parseBoolToggle(flags.subagent, "--subagent");
  }

  const result = await runInstaller(opts);
  const prefix = result.dryRun ? "[dry-run] " : "";
  for (const action of result.actions) {
    console.log(`${prefix}${action}`);
  }
  console.log(
    `${prefix}${result.uninstall ? "Uninstall" : "Install"} complete for hosts: ${result.hosts.join(", ")}`,
  );
  return result;
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isDirectRun) {
  runInstallFromCli().catch((err) => {
    console.error(`compact-handoff install error: ${err?.message || err}`);
    process.exit(1);
  });
}
