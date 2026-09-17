/**
 * Trimegisto - interactive config menu
 *
 * Built on pi-tui's `SettingsList`, the same component pi's own `/settings`
 * uses. Every row carries a `description`; the selected row's description is
 * rendered at the bottom of the list as a help hint, and a submenu row opens a
 * nested SettingsList that keeps the same behaviour. Enter/Space changes the
 * value (or opens the submenu), Esc goes back one level.
 *
 * The list themes are derived from the `theme` that `ctx.ui.custom` injects,
 * NOT from pi's global `getSettingsListTheme()`: the global reads a
 * process-wide theme that throws when uninitialised, which would make this
 * whole module untestable outside the TUI.
 *
 * The menu is pure navigation: every change goes through `applyChange` and is
 * persisted immediately, so a row only has to keep its own displayed value in
 * sync (SettingsList does that for cycled `values` and for submenus that call
 * `done(value)`).
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type SelectListTheme,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import { formatTierLabel, clampWatchdogSeconds, MAX_WATCHDOG_SECONDS, WATCHDOG_DEFAULTS, sanitizeReaperConfig } from "./config.ts";
import { MODEL_HEALTH_DEFAULTS, sanitizeModelHealthConfig } from "./model-health.ts";
import { REAPER_DEFAULTS, type AgentTier, type TrimegistoConfig } from "./types.ts";
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
  syncReaper?: () => void;
  syncModelHealth?: () => void;
  clearModelHealth?: (model?: string) => void;
}

type Theme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

const bool = (v: boolean): string => (v ? "ON" : "OFF");

// ── Descriptions (the hint shown under the selected row) ──────────────

const DESC: Record<string, string> = {
  tierActive: "Mass-parallel worker tier. Always available and uses the live active model. Enter to configure enabled, model, max parallel and compaction.",
  tierT1: "Expensive planning/coordination tier, reserved for hard architecture, trade-offs and synthesis. Enter to configure it.",
  tierT2: "Hard-problem solver tier: debugging, code review, multi-step analysis. Enter to configure it.",
  tierT3: "Fast, cheap mechanical tier: parsing, formatting, counting, commands and file ops. Enter to configure it.",
  enabled: "Master switch. When OFF the trimegisto tool refuses to spawn and any running agents are halted.",
  autoSpawn: "When ON, the per-turn prompt tells the main model to delegate decomposable work first. OFF: it only spawns when you explicitly ask.",
  useActiveModel: "Spawned agents reuse the live active model (sharing its speculative-decoding pool) instead of each tier's configured model.",
  spawnOnlyOnActive: "Force every spawn onto the active tier; t1/t2/t3 are never used. Useful when one local server backs the whole swarm.",
  redundantAgents: "Use each tier's redundant model pool: spawn on the least-loaded model and fail over on provider errors, quota or a first-response timeout.",
  dedupeTasks: "Reject near-duplicate tasks before launch, so the swarm never pays twice for effectively the same work.",
  dedupeCrossAgent: "Also flag near-identical outputs from DIFFERENT agents and report the wasted tokens. Overlap detection, not loop detection.",
  turnLimit: "Kill runaway agents by turn count. OFF by default: an agent never dies on its turn count unless you enable it here.",
  watchdogs: "Timeouts that kill an agent which stops making progress: first response, idle, and a wall-clock cap. 0 disables a watchdog.",
  reaper: "Auto-free finished agents (memory, locks, context, telemetry) and drop them off the dashboard once they have been idle long enough.",
  modelHealth: "Per-model circuit breaker: pause a model after repeated provider failures so a dead provider cannot trigger a spawn storm.",
  dashboard: "How much of the dashboard the TUI shows: compact (one line per agent), widget (also a footer), or off.",
  // tier submenu
  tierEnabled: "Whether this tier can be spawned. Disabled tiers are reported to the coordinator as unavailable.",
  tierModel: "Model this tier runs on. Required for t1/t2/t3 to become available.",
  tierRedundant: "Fallback models tried in order when the primary errors, is rate-limited or never responds. Enter to add or remove one.",
  tierMaxParallel: "How many agents this tier runs at once. The wave planner defers work beyond this cap to a later wave.",
  tierCompaction: "Force context compaction at this % of the model's context window. 'off' lets pi use its native setting.",
  // turn limit submenu
  tlEnabled: "Enforce the turn limit. When ON an agent is warned at the soft limit and hard-killed after the grace.",
  tlWarn: "Turn count at which the agent receives a warning. It is NOT killed at this point.",
  tlGrace: "Extra turns granted after the warning before the agent is hard-killed.",
  // watchdogs submenu
  wdFirst: "Seconds to wait for the agent's FIRST response before killing it (provider hang). 0 disables this watchdog.",
  wdIdle: "Seconds without any agent progress before killing it. Suspended while the agent is compacting. 0 disables it.",
  wdMax: "Hard wall-clock cap per agent attempt. 0 (default) lets a productive agent run as long as it keeps making progress.",
  // reaper submenu
  rpEnabled: "Free finished agents once they are terminal and no longer referenced by a live batch.",
  rpIdle: "Seconds a finished agent must sit unused before it is reaped. 0 reaps on the first sweep after it settles.",
  // model health submenu
  mhEnabled: "Pause a model after repeated model-level failures (400s, 5xx, quota, timeouts).",
  mhThreshold: "Consecutive model-level failures that open the breaker.",
  mhCooldown: "Seconds the breaker stays open on the first trip; it doubles on each further trip up to the max.",
  mhMaxCooldown: "Ceiling for the exponential backoff.",
  mhReset: "Clear every open breaker now, so paused models can be spawned again immediately.",
};

export async function runConfigUI(ctx: any, rt: ConfigUIRuntime): Promise<void> {
  const { config } = rt;
  // Defensive: a corrupted/legacy config must never crash the UI.
  if (!config.watchdog) config.watchdog = { ...WATCHDOG_DEFAULTS };
  // Sanitize rather than merely defaulting: a partial modelHealth block (e.g.
  // hand-edited config) must not leave undefined thresholds in the UI.
  config.modelHealth = sanitizeModelHealthConfig(config.modelHealth as any, MODEL_HEALTH_DEFAULTS);
  // Same for the reaper block: a partial/hand-edited config must not leak
  // undefined seconds into the UI.
  config.reaper = sanitizeReaperConfig(config.reaper as any, config.reaper ?? REAPER_DEFAULTS);

  // Model list is fetched ONCE, before the menu opens: submenu components must
  // be built synchronously (ctx.ui.custom's factory is sync).
  let modelList: Array<{ id: string; label: string }> = [];
  try {
    const models = await ctx.modelRegistry.getAvailable();
    modelList = models.map((m: any) => ({ id: `${m.provider}/${m.id}`, label: m.name || m.id }));
  } catch { /* no registry → picker reports it */ }

  const isTierKey = (id: string): id is AgentTier => id === "active" || id === "t1" || id === "t2" || id === "t3";
  /** "tier:t2" -> t2, "t2:model" -> t2, "wd:idle" -> null. */
  const tierKeyOf = (id: string): AgentTier | null => {
    const key = id.startsWith("tier:") ? id.slice(5) : id.split(":")[0];
    return isTierKey(key) ? key : null;
  };

  const tierSummary = (key: AgentTier): string => {
    const t = config[key];
    const bits = [bool(t.enabled)];
    if (key !== "active") bits.push(t.model || "(no model)");
    bits.push(`max:${t.maxParallel}`);
    bits.push(t.compactionThreshold > 0 ? `compact@${t.compactionThreshold}%` : "compact:pi");
    return bits.join(" · ");
  };
  const watchdogSummary = (): string => {
    const wd = config.watchdog;
    const fmt = (s: number) => (s > 0 ? `${s}s` : "off");
    return `first ${fmt(wd.firstResponseSeconds)} · idle ${fmt(wd.idleSeconds)} · max ${fmt(wd.maxRuntimeSeconds)}`;
  };
  const reaperSummary = (): string => {
    const rp = config.reaper;
    if (!rp || rp.enabled !== true) return "OFF";
    return `idle ${rp.terminalIdleSeconds > 0 ? `${rp.terminalIdleSeconds}s` : "instant"}`;
  };
  const modelHealthSummary = (): string => {
    const mh = config.modelHealth;
    if (!mh || !mh.enabled) return "OFF";
    return `fails≥${mh.failureThreshold} · cool ${mh.cooldownSeconds}s→${mh.maxCooldownSeconds}s`;
  };
  const turnLimitSummary = (): string => {
    const tl = config.loopSupervisor ?? {};
    // Same default-deny comparison the enforcer (checkTurnLimit) and /tmg guard
    // use, so the menu can never show ON while the gate is off.
    if (tl.turnLimitEnabled !== true) return "OFF";
    const warn = tl.maxAgentTurns ?? 50;
    return `warn ${warn} · kill ${warn + (tl.turnLimitGrace ?? 15)}`;
  };

  // ── Single place where a row change becomes a real config change ──
  const applyChange = (id: string, value: string): void => {
    const num = (): number => parseInt(value, 10);

    switch (id) {
      case "enabled": {
        config.enabled = value === "ON";
        rt.registerMainTool();
        if (config.enabled) {
          void rt.updateDashboard();
          try { rt.ctxRef?.ui.setStatus("trimegisto", formatTmgStatus(true)); } catch { /* stale ctx */ }
        } else {
          rt.haltAll();
          try {
            rt.ctxRef?.ui.setFooter(undefined);
            rt.ctxRef?.ui.setWidget("trimegisto", undefined);
            rt.ctxRef?.ui.setWidget("trimegisto-compact", undefined);
            rt.ctxRef?.ui.setStatus("trimegisto", formatTmgStatus(false));
          } catch { /* stale ctx */ }
        }
        ctx.ui.notify(`Trimegisto: ${bool(config.enabled)}`, config.enabled ? "info" : "warning");
        break;
      }
      case "autoSpawn": config.autoSpawn = value === "ON"; ctx.ui.notify(`Auto-spawn: ${bool(config.autoSpawn)}`, "info"); break;
      case "useActiveModel":
        config.useActiveModel = value === "ON";
        ctx.ui.notify(`Agents use ${config.useActiveModel ? `ACTIVE (${rt.activeModel || "?"})` : "per-tier models"}`, "info");
        rt.registerMainTool();
        break;
      case "spawnOnlyOnActive":
        config.spawnOnlyOnActive = value === "ON";
        ctx.ui.notify(`Spawn only on active: ${bool(config.spawnOnlyOnActive)}`, "info");
        rt.registerMainTool();
        break;
      case "redundantAgents":
        config.redundantAgents = value === "YES";
        ctx.ui.notify(`Redundant agents: ${config.redundantAgents ? "YES" : "NO"}`, "info");
        rt.registerMainTool();
        break;
      case "dedupeTasks": config.dedupeTasks = value === "ON"; ctx.ui.notify(`Dedupe tasks: ${bool(config.dedupeTasks)}`, "info"); break;
      case "dedupeCrossAgent":
        config.dedupeCrossAgent = value === "ON";
        rt.syncLoopSupervisor?.();
        ctx.ui.notify(`Dedupe cross-agent output: ${bool(config.dedupeCrossAgent)}`, "info");
        break;
      case "dashboard": {
        const mode = value as "compact" | "widget" | "off";
        rt.setDashboardMode(mode);
        // Persist the FULL mode (off|compact|widget); legacy `dashboardVisible`
        // is mirrored from it so older reading paths and saved configs keep working.
        config.dashboardMode = mode;
        config.dashboardVisible = mode !== "off";
        void rt.updateDashboard();
        ctx.ui.notify(`Dashboard: ${mode}`, "info");
        break;
      }
      // Redundant-pool changes (the picker calls these directly, so they must
      // persist through the shared rt.saveConfig() at the end of this function).
      case "rm:remove": {
        const key = value.slice(0, value.indexOf("\u0000")) as AgentTier;
        const model = value.slice(value.indexOf("\u0000") + 1);
        if (isTierKey(key) && model) {
          config[key].redundantModels = (config[key].redundantModels ?? []).filter(m => m !== model);
          ctx.ui.notify(`${formatTierLabel(key)} redundant model removed: ${model}`, "info");
          rt.registerMainTool();
        }
        break;
      }
      case "rm:add": {
        const key = value.slice(0, value.indexOf("\u0000")) as AgentTier;
        const model = value.slice(value.indexOf("\u0000") + 1);
        if (isTierKey(key) && model && model !== "__none__") {
          const pool = config[key].redundantModels ?? (config[key].redundantModels = []);
          if (model === config[key].model || pool.includes(model)) ctx.ui.notify(`${model} already in pool`, "warning");
          else { pool.push(model); rt.clearModelHealth?.(model); ctx.ui.notify(`${formatTierLabel(key)} redundant model added: ${model}`, "info"); rt.registerMainTool(); }
        }
        break;
      }
    }

    // ── Tier submenu rows: "<tier>:<field>" ──
    const tierKey = tierKeyOf(id);
    if (tierKey && id.startsWith(`${tierKey}:`)) {
      const field = id.slice(id.indexOf(":") + 1);
      const t = config[tierKey];
      if (field === "enabled") {
        t.enabled = value === "ON";
        ctx.ui.notify(`${formatTierLabel(tierKey)}: ${bool(t.enabled)}`, "info");
        rt.registerMainTool();
      } else if (field === "model") {
        const previous = t.model;
        t.model = value;
        if (previous && previous !== value) rt.clearModelHealth?.(previous);
        ctx.ui.notify(`${formatTierLabel(tierKey)} model: ${value}`, "info");
        rt.registerMainTool();
      } else if (field === "maxParallel") {
        t.maxParallel = num();
        ctx.ui.notify(`${formatTierLabel(tierKey)} max: ${t.maxParallel}`, "info");
      } else if (field === "compaction") {
        t.compactionThreshold = value === "off" ? 0 : num();
        ctx.ui.notify(`${formatTierLabel(tierKey)} compaction: ${t.compactionThreshold > 0 ? `${t.compactionThreshold}%` : "off (pi decides)"}`, "info");
      }
    }

    // ── Turn limit ──
    else if (id === "tl:enabled") { (config.loopSupervisor ??= {}).turnLimitEnabled = value === "ON"; rt.syncLoopSupervisor?.(); ctx.ui.notify(`Turn limit: ${value}`, "info"); }
    else if (id === "tl:warn") { (config.loopSupervisor ??= {}).maxAgentTurns = Math.min(num(), 100_000); rt.syncLoopSupervisor?.(); ctx.ui.notify(`Warn at: ${config.loopSupervisor!.maxAgentTurns}`, "info"); }
    else if (id === "tl:grace") { (config.loopSupervisor ??= {}).turnLimitGrace = Math.min(num(), 100_000); rt.syncLoopSupervisor?.(); ctx.ui.notify(`Kill grace: ${config.loopSupervisor!.turnLimitGrace}`, "info"); }

    // ── Watchdogs ──
    else if (id === "wd:first" || id === "wd:idle" || id === "wd:max") {
      const n = clampWatchdogSeconds(num(), 0);
      const field = id.slice(3) as "first" | "idle" | "max";
      if (field === "first") config.watchdog.firstResponseSeconds = n;
      else if (field === "idle") config.watchdog.idleSeconds = n;
      else config.watchdog.maxRuntimeSeconds = n;
      rt.syncWatchdog?.();
      if (n !== num()) ctx.ui.notify(`Value capped at ${MAX_WATCHDOG_SECONDS}s (max)`, "warning");
      const names: Record<string, string> = { first: "First response", idle: "Idle timeout", max: "Max runtime" };
      ctx.ui.notify(`${names[field]}: ${n > 0 ? `${n}s` : "off"}`, "info");
    }

    // ── Reaper ──
    else if (id === "rp:enabled") { config.reaper.enabled = value === "ON"; rt.syncReaper?.(); ctx.ui.notify(`Reaper: ${bool(config.reaper.enabled)}`, config.reaper.enabled ? "info" : "warning"); }
    else if (id === "rp:idle") {
      const n = clampWatchdogSeconds(num(), 0);
      config.reaper.terminalIdleSeconds = n;
      rt.syncReaper?.();
      if (n !== num()) ctx.ui.notify(`Value capped at ${MAX_WATCHDOG_SECONDS}s (max)`, "warning");
      ctx.ui.notify(`Terminal idle timeout: ${n > 0 ? `${n}s` : "instant"}`, "info");
    }

    // ── Model health ──
    else if (id === "mh:enabled") { config.modelHealth.enabled = value === "ON"; rt.syncModelHealth?.(); ctx.ui.notify(`Model health: ${bool(config.modelHealth.enabled)}`, "info"); }
    else if (id === "mh:threshold") { config.modelHealth.failureThreshold = num(); rt.syncModelHealth?.(); ctx.ui.notify(`Pause after ${config.modelHealth.failureThreshold} failure(s)`, "info"); }
    else if (id === "mh:cooldown") { config.modelHealth.cooldownSeconds = Math.min(num(), config.modelHealth.maxCooldownSeconds); rt.syncModelHealth?.(); ctx.ui.notify(`Base cooldown: ${config.modelHealth.cooldownSeconds}s`, "info"); }
    else if (id === "mh:maxCooldown") { config.modelHealth.maxCooldownSeconds = Math.min(num(), 86_400); rt.syncModelHealth?.(); ctx.ui.notify(`Max cooldown: ${config.modelHealth.maxCooldownSeconds}s`, "info"); }

    rt.saveConfig();
  };

  // Rows that are pure navigation open a submenu; SettingsList reports their
  // summary back through onChange and there is no direct value to apply.
  const isNavigationRow = (id: string): boolean =>
    id.startsWith("tier:") || id.startsWith("redundant:") ||
    id === "turnLimit" || id === "watchdogs" || id === "reaper" || id === "modelHealth";

  const onRowChange = (id: string, value: string): void => {
    // "Reset paused models" is an action, not a value.
    if (id === "mh:reset") { rt.clearModelHealth?.(); ctx.ui.notify("Paused models cleared", "info"); return; }
    if (isNavigationRow(id)) return;
    applyChange(id, value);
  };

  ctx.ui.custom((tui: any, theme: Theme, _kb: any, done: () => void) => {
    const settingsOnChange = (id: string, value: string): void => onRowChange(id, value);

    // Same shapes as pi's getSettingsListTheme()/getSelectListTheme(), but
    // derived from the injected theme so the module never touches pi's
    // process-wide (and uninitialised-in-tests) global.
    const listTheme: SettingsListTheme = {
      label: (text, selected) => (selected ? theme.fg("accent", text) : text),
      value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "→ "),
      hint: (text) => theme.fg("dim", text),
    };
    const selectTheme: SelectListTheme = {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    };

    /** A titled SettingsList submenu; Esc calls onClose (back to the parent). */
    const submenu = (title: string, items: SettingItem[], description: string | undefined, onClose: () => void): Component => {
      const container = new Container();
      container.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
      if (description) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("muted", description), 1, 0)); }
      container.addChild(new Spacer(1));
      const list = new SettingsList(items, 14, listTheme, settingsOnChange, onClose, { enableSearch: false });
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { list.handleInput(data); tui.requestRender?.(); },
      };
    };

    /** Numeric editor that keeps the title + description + hint pattern. */
    const numberEditor = (opts: {
      title: string; description: string; value: number; min: number; max: number;
      onSubmit: (n: number) => void; onCancel: () => void;
    }): Component => {
      const input = new Input({ prompt: "  " });
      input.setValue(String(opts.value));
      // `setValue` leaves the cursor at 0, so editing a prefilled number would
      // type at the front. Ctrl-E is the default `cursorLineEnd` binding.
      input.handleInput("\x05");
      let error = "";
      input.onSubmit = () => {
        const n = parseInt(input.getValue().trim(), 10);
        if (!Number.isFinite(n) || n < opts.min || n > opts.max) {
          error = `Enter a number between ${opts.min} and ${opts.max}`;
          return;
        }
        opts.onSubmit(n);
      };
      const hint: Component = {
        render: () => [theme.fg("dim", error ? `  ${error}` : "  Enter to save · Esc to cancel")],
        invalidate: () => { /* static */ },
      };
      const container = new Container();
      container.addChild(new Text(theme.bold(theme.fg("accent", opts.title)), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", opts.description), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "  value:"), 1, 0));
      container.addChild(input);
      container.addChild(new Spacer(1));
      container.addChild(hint);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          const kb = getKeybindings();
          if (kb.matches(data, "tui.select.cancel")) { opts.onCancel(); return; }
          error = "";
          input.handleInput(data);
          tui.requestRender?.();
        },
      };
    };

    const numberRow = (id: string, label: string, description: string, current: number, min: number, max: number): SettingItem => ({
      id, label, description, currentValue: String(current),
      submenu: (curr: string, close: (v?: string) => void) =>
        numberEditor({
          title: label, description, value: parseInt(curr, 10) || 0, min, max,
          onSubmit: (n: number) => close(String(n)),
          onCancel: () => close(),
        }),
    });

    const modelPicker = (title: string, current: string | undefined, onPick: (id: string) => void, onCancel: () => void): Component => {
      const items = modelList.length > 0
        ? modelList.map(m => ({ value: m.id, label: m.label, description: m.id }))
        : [{ value: "__none__", label: "No models available", description: "Log in to a provider or configure an API key first" }];
      const list = new SelectList(items, Math.min(items.length, 12), selectTheme);
      const idx = items.findIndex(i => i.value === current);
      if (idx >= 0) list.setSelectedIndex(idx);
      list.onSelect = (item) => { if (item.value !== "__none__") onPick(item.value); };
      list.onCancel = onCancel;
      const container = new Container();
      container.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 1, 0));
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { list.handleInput(data); tui.requestRender?.(); },
      };
    };

    // Redundant-models manager: a mini router so Add/Remove stay inside it.
    const redundantPicker = (key: AgentTier, onClose: () => void): Component => {
      const container = new Container();
      let active: Component | null = null;
      const header = (): void => {
        container.clear();
        container.addChild(new Text(theme.bold(theme.fg("accent", `Redundant models for ${formatTierLabel(key)}`)), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", DESC.tierRedundant), 1, 0));
        container.addChild(new Spacer(1));
      };
      const showList = (): void => {
        header();
        const pool = config[key].redundantModels ?? [];
        const items = [
          ...pool.map(m => ({ value: `rm\u0000${m}`, label: `✕ Remove: ${m}`, description: "Remove this model from the fallback pool" })),
          { value: "add", label: "＋ Add model…", description: "Pick another model to try when the primary fails" },
          { value: "back", label: "Back", description: "Return to the tier settings" },
        ];
        const list = new SelectList(items, Math.min(items.length, 12), selectTheme);
        list.onSelect = (item) => {
          if (item.value === "back") { onClose(); return; }
          if (item.value === "add") { showPicker(); return; }
          // item.value is "rm\u0000<model>"; the model is the 4th onwards.
          applyChange("rm:remove", `${key}\u0000${item.value.slice(3)}`);
          showList();
        };
        list.onCancel = onClose;
        active = {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => { list.handleInput(data); tui.requestRender?.(); },
        };
        container.addChild(list);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 1, 0));
      };
      const showPicker = (): void => {
        active = modelPicker(`Add ${formatTierLabel(key)} model`, undefined, (id) => { applyChange("rm:add", `${key}\u0000${id}`); showList(); }, showList);
      };
      showList();
      return {
        render: (w: number) => (active ? active.render(w) : []),
        invalidate: () => active?.invalidate?.(),
        handleInput: (data: string) => { active?.handleInput?.(data); tui.requestRender?.(); },
      };
    };

    // ── submenu item builders ────────────────────────────────────────
    const tierItems = (key: AgentTier): SettingItem[] => {
      const t = config[key];
      const items: SettingItem[] = [
        { id: `${key}:enabled`, label: "Enabled", description: DESC.tierEnabled, currentValue: bool(t.enabled), values: ["ON", "OFF"] },
      ];
      if (key !== "active") {
        items.push({
          id: `${key}:model`, label: "Model", description: DESC.tierModel, currentValue: t.model || "(not set)",
          submenu: (_c: string, close: (v?: string) => void) => modelPicker(`Select ${formatTierLabel(key)} model`, t.model, (id) => close(id), () => close()),
        });
      }
      if (key === "t1" || key === "t2") {
        items.push({
          id: `redundant:${key}`, label: "Redundant models", description: DESC.tierRedundant,
          currentValue: `${(t.redundantModels ?? []).length} configured`,
          submenu: (_c: string, close: (v?: string) => void) => redundantPicker(key, () => close(`${(t.redundantModels ?? []).length} configured`)),
        });
      }
      items.push({ id: `${key}:maxParallel`, label: "Max Parallel", description: DESC.tierMaxParallel, currentValue: String(t.maxParallel), values: ["1", "2", "3", "4", "5", "6", "7", "8"] });
      items.push({
        id: `${key}:compaction`, label: "Compaction Threshold", description: DESC.tierCompaction,
        currentValue: t.compactionThreshold > 0 ? `${t.compactionThreshold}%` : "off",
        values: ["off", "50%", "55%", "60%", "65%", "70%", "75%", "80%", "85%", "90%", "95%"],
      });
      return items;
    };

    const turnItems = (): SettingItem[] => {
      const tl = (config.loopSupervisor ??= {});
      return [
        { id: "tl:enabled", label: "Enabled", description: DESC.tlEnabled, currentValue: bool(tl.turnLimitEnabled === true), values: ["ON", "OFF"] },
        numberRow("tl:warn", "Warn at (turns)", DESC.tlWarn, tl.maxAgentTurns ?? 50, 1, 100_000),
        numberRow("tl:grace", "Kill grace (turns)", DESC.tlGrace, tl.turnLimitGrace ?? 15, 0, 100_000),
      ];
    };
    const watchdogItems = (): SettingItem[] =>
      [
        numberRow("wd:first", "First response (seconds)", DESC.wdFirst, config.watchdog.firstResponseSeconds, 0, MAX_WATCHDOG_SECONDS),
        numberRow("wd:idle", "Idle timeout (seconds)", DESC.wdIdle, config.watchdog.idleSeconds, 0, MAX_WATCHDOG_SECONDS),
        numberRow("wd:max", "Max runtime (seconds)", DESC.wdMax, config.watchdog.maxRuntimeSeconds, 0, MAX_WATCHDOG_SECONDS),
      ];
    const reaperItems = (): SettingItem[] => {
      const rp = config.reaper;
      return [
        { id: "rp:enabled", label: "Enabled", description: DESC.rpEnabled, currentValue: bool(rp.enabled === true), values: ["ON", "OFF"] },
        numberRow("rp:idle", "Terminal idle timeout (seconds)", DESC.rpIdle, rp.terminalIdleSeconds, 0, MAX_WATCHDOG_SECONDS),
      ];
    };
    const modelHealthItems = (): SettingItem[] => {
      const mh = config.modelHealth;
      return [
        { id: "mh:enabled", label: "Enabled", description: DESC.mhEnabled, currentValue: bool(mh.enabled), values: ["ON", "OFF"] },
        { id: "mh:threshold", label: "Failures before pause", description: DESC.mhThreshold, currentValue: String(mh.failureThreshold), values: ["1", "2", "3", "4", "5"] },
        numberRow("mh:cooldown", "Base cooldown (seconds)", DESC.mhCooldown, mh.cooldownSeconds, 1, mh.maxCooldownSeconds),
        numberRow("mh:maxCooldown", "Max cooldown (seconds)", DESC.mhMaxCooldown, mh.maxCooldownSeconds, 1, 86_400),
        { id: "mh:reset", label: "Reset paused models", description: DESC.mhReset, currentValue: "clear now", values: ["clear now"] },
      ];
    };

    // ── main menu ────────────────────────────────────────────────────
    const mainItems: SettingItem[] = [
      { id: "tier:active", label: "Active (t0)", description: DESC.tierActive, currentValue: tierSummary("active"), submenu: (_c, close) => submenu("Configure Active (t0)", tierItems("active"), DESC.tierActive, () => close(tierSummary("active"))) },
      { id: "tier:t1", label: "T1", description: DESC.tierT1, currentValue: tierSummary("t1"), submenu: (_c, close) => submenu("Configure T1", tierItems("t1"), DESC.tierT1, () => close(tierSummary("t1"))) },
      { id: "tier:t2", label: "T2", description: DESC.tierT2, currentValue: tierSummary("t2"), submenu: (_c, close) => submenu("Configure T2", tierItems("t2"), DESC.tierT2, () => close(tierSummary("t2"))) },
      { id: "tier:t3", label: "T3", description: DESC.tierT3, currentValue: tierSummary("t3"), submenu: (_c, close) => submenu("Configure T3", tierItems("t3"), DESC.tierT3, () => close(tierSummary("t3"))) },
      { id: "enabled", label: "Enabled", description: DESC.enabled, currentValue: bool(config.enabled), values: ["ON", "OFF"] },
      { id: "autoSpawn", label: "Auto-spawn", description: DESC.autoSpawn, currentValue: bool(config.autoSpawn), values: ["ON", "OFF"] },
      { id: "useActiveModel", label: "Active model for agents", description: DESC.useActiveModel, currentValue: bool(config.useActiveModel), values: ["ON", "OFF"] },
      { id: "spawnOnlyOnActive", label: "Spawn only on active (t0)", description: DESC.spawnOnlyOnActive, currentValue: bool(config.spawnOnlyOnActive), values: ["ON", "OFF"] },
      { id: "redundantAgents", label: "Redundant agents", description: DESC.redundantAgents, currentValue: config.redundantAgents ? "YES" : "NO", values: ["YES", "NO"] },
      { id: "dedupeTasks", label: "Dedupe tasks", description: DESC.dedupeTasks, currentValue: bool(config.dedupeTasks), values: ["ON", "OFF"] },
      { id: "dedupeCrossAgent", label: "Dedupe cross-agent output", description: DESC.dedupeCrossAgent, currentValue: bool(config.dedupeCrossAgent), values: ["ON", "OFF"] },
      { id: "turnLimit", label: "Turn limit", description: DESC.turnLimit, currentValue: turnLimitSummary(), submenu: (_c, close) => submenu("Turn limit", turnItems(), DESC.turnLimit, () => close(turnLimitSummary())) },
      { id: "watchdogs", label: "Watchdogs", description: DESC.watchdogs, currentValue: watchdogSummary(), submenu: (_c, close) => submenu("Watchdogs", watchdogItems(), DESC.watchdogs, () => close(watchdogSummary())) },
      { id: "reaper", label: "Reaper", description: DESC.reaper, currentValue: reaperSummary(), submenu: (_c, close) => submenu("Reaper", reaperItems(), DESC.reaper, () => close(reaperSummary())) },
      { id: "modelHealth", label: "Model health", description: DESC.modelHealth, currentValue: modelHealthSummary(), submenu: (_c, close) => submenu("Model health", modelHealthItems(), DESC.modelHealth, () => close(modelHealthSummary())) },
      { id: "dashboard", label: "Dashboard", description: DESC.dashboard, currentValue: rt.dashboardMode, values: ["compact", "widget", "off"] },
    ];

    const list = new SettingsList(mainItems, 18, listTheme, settingsOnChange, () => done(), { enableSearch: false });
    const root = new Container();
    root.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    root.addChild(new Text(theme.bold(theme.fg("accent", "Configure Trimegisto")), 1, 1));
    root.addChild(list);
    root.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => root.render(w),
      invalidate: () => root.invalidate(),
      handleInput: (data: string) => { list.handleInput(data); tui.requestRender?.(); },
    };
  });
}
