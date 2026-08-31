/** Compact Trimegisto branding shared by status/footer and widgets. */

export const TMG_EMOJI = "🧙";
export const TMG_SHORT = `${TMG_EMOJI} Tmg`;

export function formatTmgStatus(enabled: boolean, detail?: string): string {
  const base = `${TMG_SHORT}:${enabled ? "on" : "off"}`;
  return detail ? `${base} · ${detail}` : base;
}
