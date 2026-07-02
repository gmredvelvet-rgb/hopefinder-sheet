/**
 * Hopefinder Survivor Sheet — Premium item tooltip engine.
 * A single floating tooltip element shared by every sheet instance shows
 * image, traits, key stats and an enriched description excerpt for any
 * element carrying `data-hf-tip="<itemId>"`.
 */

import { loc, signed } from "./config.mjs";

let _el = null;
let _showTimer = null;
let _current = null;

function ensureElement() {
  if (_el) return _el;
  _el = document.createElement("div");
  _el.id = "hf-tooltip";
  _el.setAttribute("role", "tooltip");
  document.body.appendChild(_el);
  return _el;
}

function hide() {
  clearTimeout(_showTimer);
  _showTimer = null;
  _current = null;
  if (_el) _el.classList.remove("hf-tooltip--on");
}

function position(x, y) {
  if (!_el) return;
  const pad = 14;
  const rect = _el.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  _el.style.left = `${Math.max(8, left)}px`;
  _el.style.top = `${Math.max(8, top)}px`;
}

function statChips(item) {
  const chips = [];
  const sys = item.system ?? {};
  if (item.type === "weapon") {
    const dmg = sys.damage ?? {};
    if (dmg.dice && dmg.die) chips.push({ label: loc("Tip.Damage"), value: `${dmg.dice}${dmg.die} ${dmg.damageType ?? ""}`.trim() });
    if (sys.range) chips.push({ label: loc("Tip.Range"), value: `${sys.range} ft` });
    if (sys.reload?.value) chips.push({ label: loc("Tip.Reload"), value: sys.reload.value });
  }
  if (item.type === "armor") {
    if (sys.acBonus !== undefined) chips.push({ label: "AC", value: signed(sys.acBonus) });
    if (sys.dexCap !== undefined && sys.dexCap !== null) chips.push({ label: loc("Tip.DexCap"), value: signed(sys.dexCap) });
  }
  if (sys.uses?.max) chips.push({ label: loc("Tip.Uses"), value: `${sys.uses.value}/${sys.uses.max}` });
  if (sys.quantity !== undefined && sys.quantity !== 1) chips.push({ label: loc("Tip.Qty"), value: sys.quantity });
  if (sys.hp?.max) chips.push({ label: loc("Tip.Integrity"), value: `${sys.hp.value}/${sys.hp.max}` });
  const price = sys.price?.value?.gp ?? 0;
  if (price) chips.push({ label: loc("Tip.Value"), value: `${price} gp` });
  return chips;
}

async function render(item, x, y) {
  const el = ensureElement();
  const sys = item.system ?? {};
  const rarity = sys.traits?.rarity ?? "common";
  const traits = (sys.traits?.value ?? []).slice(0, 6);
  const level = sys.level?.value;

  let desc = sys.description?.value ?? "";
  try {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    desc = await TE.enrichHTML(desc, { async: true, relativeTo: item });
  } catch { /* show unenriched */ }

  // Strip to a readable excerpt: keep first paragraphs, cap length.
  const tmp = document.createElement("div");
  tmp.innerHTML = desc;
  let text = (tmp.textContent ?? "").trim().replace(/\s+/g, " ");
  if (text.length > 340) text = `${text.slice(0, 340)}…`;

  const chips = statChips(item);
  el.innerHTML = `
    <div class="hf-tooltip-head">
      <img src="${item.img}" alt="" loading="lazy">
      <div class="hf-tooltip-title">
        <span class="hf-tooltip-name">${foundry.utils.escapeHTML(item.name)}</span>
        <span class="hf-tooltip-sub">
          <span class="hf-rarity hf-rarity--${rarity}">${loc(`Rarity.${rarity}`)}</span>
          ${Number.isFinite(level) ? `<span class="hf-tooltip-lvl">LV ${level}</span>` : ""}
        </span>
      </div>
    </div>
    ${chips.length ? `<div class="hf-tooltip-stats">${chips.map(c =>
      `<span class="hf-tooltip-stat"><label>${c.label}</label><b>${c.value}</b></span>`).join("")}</div>` : ""}
    ${traits.length ? `<div class="hf-tooltip-traits">${traits.map(t =>
      `<span>${foundry.utils.escapeHTML(t)}</span>`).join("")}</div>` : ""}
    ${text ? `<div class="hf-tooltip-desc">${foundry.utils.escapeHTML(text)}</div>` : ""}
  `;
  el.classList.add("hf-tooltip--on");
  position(x, y);
}

/**
 * Attach delegated tooltip behavior to a sheet root.
 * Elements opt in with data-hf-tip="<itemId>".
 */
export function attachTooltips(root, actor) {
  root.addEventListener("pointerover", ev => {
    const target = ev.target.closest("[data-hf-tip]");
    if (!target) return;
    const itemId = target.dataset.hfTip;
    if (_current === itemId) return;
    clearTimeout(_showTimer);
    _showTimer = setTimeout(() => {
      const item = actor.items.get(itemId);
      if (!item) return;
      _current = itemId;
      render(item, ev.clientX, ev.clientY);
    }, 140);
  });

  root.addEventListener("pointerout", ev => {
    const target = ev.target.closest("[data-hf-tip]");
    if (!target) return;
    if (ev.relatedTarget && target.contains(ev.relatedTarget)) return;
    hide();
  });

  root.addEventListener("pointerdown", hide);
  root.addEventListener("wheel", hide, { passive: true });
}

/** Hide the shared tooltip (called on sheet close). */
export function hideTooltip() {
  hide();
}

document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") hide();
});
