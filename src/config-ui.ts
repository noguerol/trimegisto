import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { formatTierLabel, clampWatchdogSeconds, MAX_WATCHDOG_SECONDS, WATCHDOG_DEFAULTS } from "./config.ts";
import { MODEL_HEALTH_DEFAULTS, sanitizeModelHealthConfig } from "./model-health.ts";
import type { AgentTier, TrimegistoConfig } from "./types.ts";
import { formatTmgStatus } from "./branding.ts";

export interface ConfigUIRuntime {
  config: TrimegistoConfig;
  dashboardMode: "widget" | "compact" | "off";
  setDashboardMode: (mode: "widget" | "compact" | "off") => void;
  activeModel: string | null;
  ctxRef: any;
  updateDashboard: () => void | Promise<void>;
  haltAll: () => number;
  saveConfig: () => void;
  registerMainTool: () => void;
  syncLoopSupervisor?: () => void;
  syncWatchdog?: () => void;
  syncModelHealth?: () => void;
  clearModelHealth?: (model?: string) => void;
}

export async function runConfigUI(ctx: any, rt: ConfigUIRuntime): Promise<void> {
  const { config } = rt;
  // Defensive: a corrupted/legacy config must never crash the UI.
  if (!config.watchdog) config.watchdog = { ...WATCHDOG_DEFAULTS };
  // Sanitize rather than merely defaulting: a partial modelHealth block (e.g.
  // hand-edited config) must not leave undefined thresholds in the UI.
  config.modelHealth = sanitizeModelHealthConfig(config.modelHealth as any, MODEL_HEALTH_DEFAULTS);
  let modelList: string[] | null = null;

  const pickModel = async (title: string): Promise<string | undefined> => {
    if (!modelList) {
      const models = await ctx.modelRegistry.getAvailable();
      modelList = models.map((m: any) => `${m.provider}/${m.id} — ${m.name || m.id}`);
    }
    if (modelList.length === 0) {
      ctx.ui.notify("No models. Configure API keys.", "error");
      return undefined;
    }
    const choice = await ctx.ui.custom<string | undefined>((_tui: any, theme: any, _keybindings: any, done: any) => {
      const maxVisible = 10;
      const items = modelList!;
      let selectedIndex = 0;
      const list = new Container();
      const render = () => {
        list.clear();
        const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
        const end = Math.min(start + maxVisible, items.length);
        for (let i = start; i < end; i++) {
          list.addChild(new Text(i === selectedIndex ? theme.fg("accent", `→ ${items[i]}`) : `  ${items[i]}`, 1, 0));
        }
        if (start > 0 || end < items.length) {
          list.addChild(new Spacer(1));
          list.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${items.length})`), 1, 0));
        }
      };
      const root = new Container();
      root.addChild(new Spacer(1));
      root.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      root.addChild(new Spacer(1));
      root.addChild(list);
      root.addChild(new Spacer(1));
      root.addChild(new Text(theme.fg("muted", `  ↑↓ Enter Esc (${items.length})`), 1, 0));
      render();
      (root as any).handleInput = (keyData: string) => {
        const kb = getKeybindings();
        if (kb.matches(keyData, "tui.select.up") || keyData === "k") { selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1; render(); }
        else if (kb.matches(keyData, "tui.select.down") || keyData === "j") { selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1; render(); }
        else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") { if (items[selectedIndex]) done(items[selectedIndex]); }
        else if (kb.matches(keyData, "tui.select.cancel")) done(undefined);
      };
      return root;
    });
    return choice ? choice.split(" — ")[0].trim() : undefined;
  };

  const fmtCompaction = (n: number) => (n > 0 ? `compact@${n}%` : "compact:pi");

  // Main menu loop: after changing a setting we re-render the same level instead
  // of closing the whole UI. Esc / "Done" is the only way out.
  while (true) {
    const choice = await ctx.ui.select("Configure Trimegisto:", [
      `Active (t0): ${config.active.enabled ? "ON" : "OFF"} | max:${config.active.maxParallel} | ${fmtCompaction(config.active.compactionThreshold)}`,
      `T1: ${config.t1.enabled ? "ON" : "OFF"} | ${config.t1.model || "(not set)"} | max:${config.t1.maxParallel} | ${fmtCompaction(config.t1.compactionThreshold)}`,
      `T2: ${config.t2.enabled ? "ON" : "OFF"} | ${config.t2.model || "(not set)"} | max:${config.t2.maxParallel} | ${fmtCompaction(config.t2.compactionThreshold)}`,
      `T3: ${config.t3.enabled ? "ON" : "OFF"} | ${config.t3.model || "(not set)"} | max:${config.t3.maxParallel} | ${fmtCompaction(config.t3.compactionThreshold)}`,
      "Enabled: " + (config.enabled ? "ON" : "OFF"),
      "Auto-spawn: " + (config.autoSpawn ? "ON" : "OFF"),
      "Active model for agents: " + (config.useActiveModel ? "ON" : "OFF"),
      "Spawn only on active (t0): " + (config.spawnOnlyOnActive ? "ON" : "OFF"),
      "Redundant agents: " + (config.redundantAgents ? "YES" : "NO"),
      "Dedupe tasks: " + (config.dedupeTasks ? "ON" : "OFF"),
      "Dedupe cross-agent output: " + (config.dedupeCrossAgent ? "ON" : "OFF"),
      "Turn limit: " + (() => {
        const tl = config.loopSupervisor ?? {};
        if (!tl.turnLimitEnabled) return "OFF";
        const warn = tl.maxAgentTurns ?? 50;
        return `ON | warn ${warn} | kill ${warn + (tl.turnLimitGrace ?? 15)}`;
      })(),
      "Watchdogs: " + (() => {
        const wd = config.watchdog;
        const fmt = (s: number) => (s > 0 ? `${s}s` : "off");
        return `first ${fmt(wd.firstResponseSeconds)} | idle ${fmt(wd.idleSeconds)} | max ${fmt(wd.maxRuntimeSeconds)}`;
      })(),
      "Model health: " + (() => {
        const mh = config.modelHealth;
        if (!mh || !mh.enabled) return "OFF";
        return `on | fails≥${mh.failureThreshold} | cool ${mh.cooldownSeconds}s→${mh.maxCooldownSeconds}s`;
      })(),
      "Dashboard: " + rt.dashboardMode,
      "Done",
    ]);
    if (!choice || choice === "Done") return;

    if (choice.startsWith("Active model for agents")) {
      config.useActiveModel = !config.useActiveModel;
      ctx.ui.notify(`Agents use ${config.useActiveModel ? `ACTIVE (${rt.activeModel || "?"})` : "per-tier models"}`, "info");
      rt.saveConfig(); rt.registerMainTool(); continue;
    }
    if (choice.startsWith("Spawn only on active")) {
      config.spawnOnlyOnActive = !config.spawnOnlyOnActive;
      ctx.ui.notify(`Spawn only on active: ${config.spawnOnlyOnActive ? "ON" : "OFF"}`, "info");
      rt.saveConfig(); rt.registerMainTool(); continue;
    }
    if (choice.startsWith("Enabled")) {
      config.enabled = !config.enabled;
      ctx.ui.notify(`Trimegisto: ${config.enabled ? "ON" : "OFF"}`, config.enabled ? "info" : "warning");
      rt.registerMainTool();
      if (config.enabled) { await rt.updateDashboard(); try { rt.ctxRef?.ui.setStatus("trimegisto", formatTmgStatus(true)); } catch {} }
      else { rt.haltAll(); try { rt.ctxRef?.ui.setFooter(undefined); rt.ctxRef?.ui.setWidget("trimegisto", undefined); rt.ctxRef?.ui.setWidget("trimegisto-compact", undefined); rt.ctxRef?.ui.setStatus("trimegisto", formatTmgStatus(false)); } catch {} }
      rt.saveConfig(); continue;
    }
    if (choice.startsWith("Auto-spawn")) { config.autoSpawn = !config.autoSpawn; ctx.ui.notify(`Auto-spawn: ${config.autoSpawn ? "ON" : "OFF"}`, "info"); rt.saveConfig(); continue; }
    if (choice.startsWith("Redundant agents")) { config.redundantAgents = !config.redundantAgents; ctx.ui.notify(`Redundant agents: ${config.redundantAgents ? "YES" : "NO"}`, "info"); rt.saveConfig(); rt.registerMainTool(); continue; }
    if (choice.startsWith("Dedupe tasks")) { config.dedupeTasks = !config.dedupeTasks; ctx.ui.notify(`Dedupe tasks: ${config.dedupeTasks ? "ON" : "OFF"}`, "info"); rt.saveConfig(); continue; }
    if (choice.startsWith("Dedupe cross-agent")) { config.dedupeCrossAgent = !config.dedupeCrossAgent; rt.syncLoopSupervisor?.(); ctx.ui.notify(`Dedupe cross-agent output: ${config.dedupeCrossAgent ? "ON" : "OFF"}`, "info"); rt.saveConfig(); continue; }

    // Turn-limit submenu: stays open after each edit. Disabled by default;
    // when on, `Warn at` triggers a warning and `Kill after` adds the grace.
    if (choice.startsWith("Turn limit")) {
      if (!config.loopSupervisor) config.loopSupervisor = {};
      const tl = config.loopSupervisor;
      const editTurns = async (label: string, current: number, min: number, apply: (n: number) => void): Promise<void> => {
        const raw = await ctx.ui.input(`${label} — turns`, String(current));
        if (raw === undefined) return;
        const n = parseInt(raw.trim(), 10);
        if (isNaN(n) || n < min) { ctx.ui.notify(`Enter a number of turns >= ${min}`, "error"); return; }
        apply(Math.min(n, 100_000));
        rt.syncLoopSupervisor?.();
        ctx.ui.notify(`${label}: ${Math.min(n, 100_000)}`, "info");
        rt.saveConfig();
      };
      while (true) {
        const warn = tl.maxAgentTurns ?? 50;
        const grace = tl.turnLimitGrace ?? 15;
        const tlChoice = await ctx.ui.select("Turn limit (off by default):", [
          `Enabled: ${tl.turnLimitEnabled ? "ON" : "OFF"}`,
          `Warn at: ${warn} turns`,
          `Kill after: +${grace} turns (hard kill at ${warn + grace})`,
          "Back",
        ]);
        if (!tlChoice || tlChoice === "Back") break;
        if (tlChoice.startsWith("Enabled")) {
          tl.turnLimitEnabled = !tl.turnLimitEnabled;
          rt.syncLoopSupervisor?.();
          ctx.ui.notify(`Turn limit: ${tl.turnLimitEnabled ? "ON" : "OFF"}`, "info");
          rt.saveConfig();
        } else if (tlChoice.startsWith("Warn at")) {
          await editTurns("Warn at", warn, 1, n => { tl.maxAgentTurns = n; });
        } else if (tlChoice.startsWith("Kill after")) {
          await editTurns("Kill grace", grace, 0, n => { tl.turnLimitGrace = n; });
        }
      }
      continue;
    }
    if (choice.startsWith("Dashboard")) {
      const modes: Array<"widget" | "compact" | "off"> = ["compact", "widget", "off"];
      const mode = modes[(modes.indexOf(rt.dashboardMode) + 1) % modes.length];
      rt.setDashboardMode(mode);
      config.dashboardVisible = mode !== "off";
      await rt.updateDashboard();
      ctx.ui.notify(`Dashboard: ${mode}`, "info");
      rt.saveConfig(); continue;
    }

    // Watchdogs submenu: stays open after each edit.
    if (choice.startsWith("Watchdogs")) {
      const wd = config.watchdog;
      const fmt = (s: number) => (s > 0 ? `${s}s` : "off");
      const editSeconds = async (label: string, current: number, apply: (n: number) => void): Promise<void> => {
        const raw = await ctx.ui.input(`${label} — seconds (0 disables it)`, String(current));
        if (raw === undefined) return;
        const n = parseInt(raw.trim(), 10);
        if (isNaN(n) || n < 0) { ctx.ui.notify("Enter a non-negative number of seconds", "error"); return; }
        const clamped = clampWatchdogSeconds(n, 0);
        apply(clamped);
        rt.syncWatchdog?.();
        if (clamped !== n) ctx.ui.notify(`Value capped at ${MAX_WATCHDOG_SECONDS}s (max)`, "warning");
        ctx.ui.notify(`${label}: ${clamped > 0 ? `${clamped}s` : "off"}`, "info");
        rt.saveConfig();
      };
      while (true) {
        const wdChoice = await ctx.ui.select("Watchdogs (0 = off):", [
          `First response: ${fmt(wd.firstResponseSeconds)}`,
          `Idle timeout: ${fmt(wd.idleSeconds)}`,
          `Max runtime (wall-clock): ${fmt(wd.maxRuntimeSeconds)}`,
          "Back",
        ]);
        if (!wdChoice || wdChoice === "Back") break;
        if (wdChoice.startsWith("First response")) {
          await editSeconds("First response timeout", wd.firstResponseSeconds, n => { wd.firstResponseSeconds = n; });
        } else if (wdChoice.startsWith("Idle timeout")) {
          await editSeconds("Idle timeout", wd.idleSeconds, n => { wd.idleSeconds = n; });
        } else if (wdChoice.startsWith("Max runtime")) {
          await editSeconds("Max runtime", wd.maxRuntimeSeconds, n => { wd.maxRuntimeSeconds = n; });
        }
      }
      continue;
    }

    // Model health submenu: stays open after each edit.
    if (choice.startsWith("Model health")) {
      const mhRef = (config.modelHealth ??= { ...MODEL_HEALTH_DEFAULTS });
      const editSeconds = async (label: string, current: number, apply: (n: number) => void, max: number): Promise<void> => {
        const raw = await ctx.ui.input(`${label} — seconds`, String(current));
        if (raw === undefined) return;
        const n = parseInt(raw.trim(), 10);
        if (isNaN(n) || n < 1) { ctx.ui.notify("Enter a positive number of seconds", "error"); return; }
        const clamped = Math.min(n, max);
        apply(clamped);
        rt.syncModelHealth?.();
        if (clamped !== n) ctx.ui.notify(`Value capped at ${max}s (max)`, "warning");
        ctx.ui.notify(`${label}: ${clamped}s`, "info");
        rt.saveConfig();
      };
      while (true) {
        const mhChoice = await ctx.ui.select("Model health (circuit breaker):", [
          `Enabled: ${mhRef.enabled ? "ON" : "OFF"}`,
          `Failures before pause: ${mhRef.failureThreshold}`,
          `Base cooldown: ${mhRef.cooldownSeconds}s`,
          `Max cooldown (backoff cap): ${mhRef.maxCooldownSeconds}s`,
          "Reset paused models",
          "Back",
        ]);
        if (!mhChoice || mhChoice === "Back") break;
        if (mhChoice.startsWith("Enabled")) {
          mhRef.enabled = !mhRef.enabled;
          rt.syncModelHealth?.();
          ctx.ui.notify(`Model health: ${mhRef.enabled ? "ON" : "OFF"}`, "info");
          rt.saveConfig();
        } else if (mhChoice.startsWith("Failures before pause")) {
          const value = await ctx.ui.select("Consecutive model failures before pausing:", ["1", "2", "3", "4", "5"]);
          const num = value ? parseInt(value, 10) : NaN;
          if (!isNaN(num)) { mhRef.failureThreshold = num; rt.syncModelHealth?.(); ctx.ui.notify(`Pause after ${num} failure(s)`, "info"); rt.saveConfig(); }
        } else if (mhChoice.startsWith("Base cooldown")) {
          await editSeconds("Base cooldown", mhRef.cooldownSeconds, n => { mhRef.cooldownSeconds = n; }, mhRef.maxCooldownSeconds);
        } else if (mhChoice.startsWith("Max cooldown")) {
          await editSeconds("Max cooldown", mhRef.maxCooldownSeconds, n => { mhRef.maxCooldownSeconds = n; }, 86_400);
        } else if (mhChoice.startsWith("Reset paused")) {
          rt.clearModelHealth?.();
          ctx.ui.notify("Paused models cleared", "info");
        }
      }
      continue;
    }

    // Tier submenu: stays open after each change; "Back"/Esc returns to main.
    const tierKey = (choice.startsWith("Active") ? "active" : choice.startsWith("T1") ? "t1" : choice.startsWith("T2") ? "t2" : "t3") as AgentTier;
    while (true) {
      const subAction = await ctx.ui.select(`Configure ${formatTierLabel(tierKey)}:`, [
        `Enabled: ${config[tierKey].enabled ? "ON" : "OFF"}`,
        `Model: ${config[tierKey].model || "(not set)"}`,
        ...((tierKey === "t1" || tierKey === "t2") ? [`Redundant models: ${(config[tierKey].redundantModels ?? []).length}`] : []),
        `Max Parallel: ${config[tierKey].maxParallel}`,
        `Compaction Threshold: ${config[tierKey].compactionThreshold > 0 ? `${config[tierKey].compactionThreshold}%` : "off (pi default)"}`,
        "Back",
      ]);
      if (!subAction || subAction === "Back") break;

      if (subAction.startsWith("Enabled")) {
        config[tierKey].enabled = !config[tierKey].enabled;
        ctx.ui.notify(`${formatTierLabel(tierKey)}: ${config[tierKey].enabled ? "ON" : "OFF"}`, "info");
        rt.saveConfig(); rt.registerMainTool(); continue;
      }
      if (subAction.startsWith("Model")) {
        const previousModel = config[tierKey].model;
        const providerId = await pickModel(`Select ${formatTierLabel(tierKey)} model:`);
        if (providerId) {
          config[tierKey].model = providerId;
          // Changing the model clears any cooldown left on the old one so the
          // new model gets a clean slate (and the paused tier is unblocked).
          if (previousModel && previousModel !== providerId) rt.clearModelHealth?.(previousModel);
          ctx.ui.notify(`${formatTierLabel(tierKey)} model: ${providerId}`, "info");
          rt.saveConfig();
        }
        continue;
      }
      if (subAction.startsWith("Redundant models")) {
        // Nested loop: add/remove keeps this submenu open; Back returns to the tier menu.
        while (true) {
          const rm = config[tierKey].redundantModels ?? (config[tierKey].redundantModels = []);
          const rmChoice = await ctx.ui.select(`Redundant models for ${formatTierLabel(tierKey)}:`, [...rm.map(m => `✕ Remove: ${m}`), "＋ Add model...", "Back"]);
          if (!rmChoice || rmChoice === "Back") break;
          if (rmChoice === "＋ Add model...") {
            const providerId = await pickModel(`Add ${formatTierLabel(tierKey)} model:`);
            if (providerId) {
              if (providerId === config[tierKey].model || rm.includes(providerId)) ctx.ui.notify(`${providerId} already in pool`, "warning");
              else { rm.push(providerId); rt.clearModelHealth?.(providerId); ctx.ui.notify(`${formatTierLabel(tierKey)} redundant model added: ${providerId}`, "info"); rt.saveConfig(); rt.registerMainTool(); }
            }
          } else if (rmChoice.startsWith("✕ Remove: ")) {
            const m = rmChoice.slice("✕ Remove: ".length);
            config[tierKey].redundantModels = rm.filter(x => x !== m);
            ctx.ui.notify(`${formatTierLabel(tierKey)} redundant model removed: ${m}`, "info");
            rt.saveConfig(); rt.registerMainTool();
          }
        }
        continue;
      }
      if (subAction.startsWith("Max Parallel")) {
        const value = await ctx.ui.select(`Max parallel for ${formatTierLabel(tierKey)}:`, ["1", "2", "3", "4", "5", "6", "7", "8"]);
        const num = value ? parseInt(value, 10) : NaN;
        if (!isNaN(num) && num >= 1 && num <= 8) { config[tierKey].maxParallel = num; ctx.ui.notify(`${formatTierLabel(tierKey)} max: ${num}`, "info"); rt.saveConfig(); }
        continue;
      }
      if (subAction.startsWith("Compaction Threshold")) {
        const value = await ctx.ui.select(`Compaction for ${formatTierLabel(tierKey)}:`, ["Off (pi default)", "50%", "55%", "60%", "65%", "70%", "75%", "80%", "85%", "90%", "95%"]);
        if (value === "Off (pi default)") {
          config[tierKey].compactionThreshold = 0;
          ctx.ui.notify(`${formatTierLabel(tierKey)} compaction: off (pi decides)`, "info");
          rt.saveConfig();
        } else {
          const num = value ? parseInt(value, 10) : NaN;
          if (!isNaN(num) && num >= 50 && num <= 95) { config[tierKey].compactionThreshold = num; ctx.ui.notify(`${formatTierLabel(tierKey)} compact: ${num}%`, "info"); rt.saveConfig(); }
        }
        continue;
      }
    }
  }
}
