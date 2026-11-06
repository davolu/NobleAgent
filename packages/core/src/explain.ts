import type { ConfigEntry } from "./types.js";

/**
 * Nothing is a black box: `bot.explain()` prints every resolved setting and
 * where it came from (preset | env | convention | user), plus warnings for
 * fallbacks and permissive defaults.
 */
export function renderExplain(
  cfg: Map<string, ConfigEntry>,
  warnings: string[],
  extra: Record<string, ConfigEntry> = {}
): string {
  const rows: [string, string, string][] = [];
  const all = new Map(cfg);
  for (const [k, v] of Object.entries(extra)) if (!all.has(k)) all.set(k, v);

  for (const [key, entry] of [...all.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push([key, formatValue(entry.value), entry.source]);
  }

  const keyW = Math.max(7, ...rows.map(([k]) => k.length));
  const valW = Math.min(60, Math.max(5, ...rows.map(([, v]) => v.length)));

  const lines = [
    "noble explain",
    `${"setting".padEnd(keyW)}  ${"value".padEnd(valW)}  source`,
    `${"-".repeat(keyW)}  ${"-".repeat(valW)}  ------`,
    ...rows.map(([k, v, s]) => `${k.padEnd(keyW)}  ${v.slice(0, valW).padEnd(valW)}  ${s}`),
  ];
  if (warnings.length) {
    lines.push("", "warnings:");
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}

function formatValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (v === null) return "null";
  if (typeof v === "function") return `[function ${(v as { name?: string }).name || "anonymous"}]`;
  if (Array.isArray(v)) {
    return `[${v.map((x) => (typeof x === "object" && x && "name" in (x as object) ? (x as { name: string }).name : formatValue(x))).join(", ")}]`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && typeof o.run === "function") return `tool:${o.name}`;
    if (typeof o.id === "string" && typeof o.complete === "function") return `model:${o.id}`;
    try {
      return JSON.stringify(v, (_k, val) => (typeof val === "function" ? "[fn]" : val)) ?? String(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
