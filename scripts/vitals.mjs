/**
 * Hopefinder Survivor Sheet — Vital signs data layer.
 * Survival stats (hunger, thirst, infection, …) are not part of the PF2e data
 * model, so they are persisted as actor flags under this module's scope.
 * This module owns all reads/writes and derives the global "sheet state"
 * (stable / wounded / critical / dying / infected) that drives UI theming.
 */

import { MODULE_ID, FLAGS, VITALS, SEVERITY_BANDS, clamp, loc } from "./config.mjs";

/** Default vitals object: every stat at its healthy value. */
export function defaultVitals() {
  const out = {};
  for (const def of VITALS) {
    if (def.kind === "good") out[def.key] = def.max;        // morale starts full
    else if (def.kind === "band") out[def.key] = def.max / 2; // temperature starts centered
    else out[def.key] = 0;
  }
  return out;
}

/** Read the vitals object for an actor (merged over defaults). */
export function getVitals(actor) {
  const stored = actor.getFlag(MODULE_ID, FLAGS.VITALS) ?? {};
  return { ...defaultVitals(), ...stored };
}

/** Set one vital to an absolute value (clamped). Returns the promise from setFlag. */
export function setVital(actor, key, value) {
  const def = VITALS.find(v => v.key === key);
  if (!def) return Promise.resolve();
  const vitals = getVitals(actor);
  vitals[key] = clamp(Math.round(Number(value) || 0), 0, def.max);
  return actor.setFlag(MODULE_ID, FLAGS.VITALS, vitals);
}

/** Step one vital by +1 / -1 (or any delta). */
export function stepVital(actor, key, delta) {
  const vitals = getVitals(actor);
  return setVital(actor, key, (vitals[key] ?? 0) + delta);
}

/**
 * Severity id for a vital value: "clear" | "low" | "elevated" | "high" | "critical".
 * For "good" vitals the scale is inverted (empty morale = critical).
 * For "band" vitals, distance from the center is what matters.
 */
export function severityOf(def, value) {
  let ratio;
  if (def.kind === "good") ratio = 1 - value / def.max;
  else if (def.kind === "band") ratio = Math.abs(value - def.max / 2) / (def.max / 2);
  else ratio = value / def.max;
  for (const band of SEVERITY_BANDS) {
    if (ratio <= band.max) return band.id;
  }
  return "critical";
}

/** Human label for a temperature band value. */
export function temperatureLabel(def, value) {
  const half = def.max / 2;
  const d = value - half;
  if (d <= -4) return loc("Temp.Hypothermia");
  if (d <= -2) return loc("Temp.Cold");
  if (d < 2) return loc("Temp.Normal");
  if (d < 4) return loc("Temp.Hot");
  return loc("Temp.Heatstroke");
}

/**
 * Build render-ready context for every vital sign.
 * Returns [{ key, label, icon, value, max, pct, severity, severityLabel,
 *            statusLabel, kind, group, segments[] }]
 */
export function prepareVitals(actor) {
  const vitals = getVitals(actor);
  return VITALS.map(def => {
    const value = vitals[def.key] ?? 0;
    const severity = severityOf(def, value);
    const statusLabel = def.kind === "band"
      ? temperatureLabel(def, value)
      : loc(`Severity.${severity}`);
    return {
      key: def.key,
      label: loc(`Vitals.${def.key}`),
      hint: loc(`VitalsHint.${def.key}`),
      icon: def.icon,
      kind: def.kind,
      group: def.group,
      value,
      max: def.max,
      pct: Math.round((value / def.max) * 100),
      severity,
      statusLabel,
      segments: Array.from({ length: def.max }, (_, i) => ({
        index: i,
        filled: i < value
      }))
    };
  });
}

/**
 * Derive the global sheet state for theming.
 * Returns { id, label, classes } where classes is a space-joined string
 * applied to the sheet root (e.g. "hf-state-critical hf-state-infected").
 */
export function deriveSheetState(actor) {
  const hp = actor.system.attributes?.hp ?? {};
  const hpPct = hp.max > 0 ? hp.value / hp.max : 1;
  const dying = actor.system.attributes?.dying?.value ?? 0;
  const vitals = getVitals(actor);

  let id = "stable";
  if (hp.max > 0 && hp.value <= 0) id = "down";
  else if (dying > 0) id = "down";
  else if (hpPct <= 0.25) id = "critical";
  else if (hpPct <= 0.6) id = "wounded";

  const classes = [`hf-state-${id}`];
  if ((vitals.infection ?? 0) >= 7) classes.push("hf-state-infected");
  if ((vitals.bleeding ?? 0) >= 7) classes.push("hf-state-bleeding");

  return { id, label: loc(`State.${id}`), classes: classes.join(" ") };
}
