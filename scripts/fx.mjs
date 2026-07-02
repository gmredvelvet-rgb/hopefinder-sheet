/**
 * Hopefinder Survivor Sheet — FX engine.
 * Motion (Web Animations API, no external libraries) and optional UI audio
 * (WebAudio-synthesized ticks — no shipped sound files).
 * Every effect degrades gracefully: honors prefers-reduced-motion and the
 * module's "animations" client setting.
 */

import { MODULE_ID } from "./config.mjs";

/* -------------------------------------------- */
/*  Motion                                      */
/* -------------------------------------------- */

function motionEnabled() {
  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
    return game.settings.get(MODULE_ID, "animations");
  } catch {
    return true;
  }
}

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_SNAP = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/** Staggered entrance when the sheet first renders. */
export function sheetEnter(root) {
  if (!motionEnabled() || !root) return;
  const seq = [
    [root.querySelector(".hf-rail"), { transform: ["translateX(-16px)", "none"], opacity: [0, 1] }, 380, 0],
    [root.querySelector(".hf-stage"), { transform: ["scale(0.985)", "none"], opacity: [0, 1] }, 360, 60],
    [root.querySelector(".hf-statusbar"), { transform: ["translateY(-10px)", "none"], opacity: [0, 1] }, 320, 120]
  ];
  for (const [el, frames, duration, delay] of seq) {
    if (el) el.animate(frames, { duration, delay, easing: EASE_OUT, fill: "backwards" });
  }
  const navItems = root.querySelectorAll(".hf-nav-item");
  navItems.forEach((el, i) => {
    el.animate(
      { transform: ["translateX(-10px)", "none"], opacity: [0, 1] },
      { duration: 260, delay: 140 + i * 32, easing: EASE_OUT, fill: "backwards" }
    );
  });
  staggerReveal(root.querySelector(".hf-tab.active"));
}

/** Slide/fade the newly activated tab panel. dir: +1 forward, -1 back. */
export function tabSwitch(panel, dir = 1) {
  if (!motionEnabled() || !panel) return;
  panel.animate(
    { transform: [`translateX(${dir * 14}px)`, "none"], opacity: [0, 1] },
    { duration: 220, easing: EASE_OUT }
  );
  staggerReveal(panel);
}

/** Cascade-reveal the cards inside a panel. */
export function staggerReveal(panel, selector = ".hf-card, .hf-vital, .hf-skill-card, .hf-tl-entry") {
  if (!motionEnabled() || !panel) return;
  const items = panel.querySelectorAll(selector);
  const count = Math.min(items.length, 24); // cap so huge inventories stay snappy
  for (let i = 0; i < count; i++) {
    items[i].animate(
      { transform: ["translateY(8px)", "none"], opacity: [0, 1] },
      { duration: 240, delay: i * 22, easing: EASE_OUT, fill: "backwards" }
    );
  }
}

/** Tactile press feedback on any interactive control. */
export function press(el) {
  if (!motionEnabled() || !el) return;
  el.animate(
    { transform: ["scale(1)", "scale(0.94)", "scale(1)"] },
    { duration: 180, easing: EASE_SNAP }
  );
}

/** Emphasis pop for roll buttons. */
export function rollPulse(el) {
  if (!motionEnabled() || !el) return;
  el.animate(
    { transform: ["scale(1)", "scale(0.9)", "scale(1.06)", "scale(1)"] },
    { duration: 300, easing: EASE_SNAP }
  );
}

/** Animate a numeric readout from one value to another. */
export function countTween(el, from, to, ms = 450) {
  if (!el) return;
  from = Number(from); to = Number(to);
  if (!motionEnabled() || !Number.isFinite(from) || from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = now => {
    const p = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Screen-edge flash on HP change. kind: "damage" | "heal". */
export function screenFlash(root, kind) {
  const el = root?.querySelector(".hf-flash");
  if (!el) return;
  el.dataset.kind = kind;
  el.classList.remove("hf-flash--on");
  void el.offsetWidth; // restart the CSS animation
  el.classList.add("hf-flash--on");
}

/** Impact shake (portrait / whole stage on heavy damage). */
export function shake(el, intensity = 5) {
  if (!motionEnabled() || !el) return;
  const i = intensity;
  el.animate(
    [
      { transform: "translate(0,0)" },
      { transform: `translate(${i}px,-${i * 0.6}px)` },
      { transform: `translate(-${i * 0.8}px,${i * 0.5}px)` },
      { transform: `translate(${i * 0.5}px,${i * 0.4}px)` },
      { transform: `translate(-${i * 0.3}px,-${i * 0.2}px)` },
      { transform: "translate(0,0)" }
    ],
    { duration: 380, easing: "ease-out" }
  );
}

/** Brief highlight when a meter segment changes. */
export function meterPulse(el) {
  if (!motionEnabled() || !el) return;
  el.animate(
    { filter: ["brightness(1)", "brightness(1.9)", "brightness(1)"] },
    { duration: 420, easing: "ease-out" }
  );
}

/* -------------------------------------------- */
/*  UI Audio (synthesized — optional)           */
/* -------------------------------------------- */

let _ctx = null;

function audioCtx() {
  try {
    if (!game.settings.get(MODULE_ID, "uiAudio")) return null;
  } catch {
    return null;
  }
  if (!_ctx) {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  }
  if (_ctx.state === "suspended") _ctx.resume().catch(() => {});
  return _ctx;
}

function volume() {
  try { return game.settings.get(MODULE_ID, "uiAudioVolume") / 100; }
  catch { return 0.3; }
}

/** Short filtered blip — generic interaction. */
export function sfxTick() {
  const ctx = audioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(1400, t);
  osc.frequency.exponentialRampToValueAtTime(700, t + 0.03);
  gain.gain.setValueAtTime(0.05 * volume(), t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

/** Deeper mechanical thunk — tab switches, equip, confirm. */
export function sfxThunk() {
  const ctx = audioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.09);
  gain.gain.setValueAtTime(0.12 * volume(), t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}

/** Two-tone warning — critical states, destructive confirms. */
export function sfxAlert() {
  const ctx = audioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const [freq, delay] of [[880, 0], [660, 0.09]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t + delay);
    gain.gain.setValueAtTime(0.001, t + delay);
    gain.gain.linearRampToValueAtTime(0.09 * volume(), t + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.1);
  }
}
