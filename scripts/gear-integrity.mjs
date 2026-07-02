/**
 * Hopefinder Survivor Sheet — Dings & Broken Gear.
 * Centralized service for the official Hopefinder gear-degradation rules:
 *  - Items never lose Integrity from being on the receiving end of normal
 *    damage; Dings only happen on a Critical Miss, at the end of an
 *    Encounter, when a special ability explicitly says so, or when a hit
 *    partially overcomes a suit of armor's Resistance (Survivor's Guide,
 *    "Damage", p.36).
 *  - Broken (dings >= half Break Value) and Destroyed (dings >= Break
 *    Value) are derived straight from PF2e's own `item.isBroken` /
 *    `item.isDestroyed` getters, which already use hp.value/hp.max with
 *    brokenThreshold = floor(max / 2) — exactly Hopefinder's formula.
 * Every mutation in this module funnels through GearIntegrityManager so
 * there is a single source of truth for the mechanic.
 */

import { MODULE_ID, FLAGS, ITEM_FLAGS, MEDICAL_CATEGORIES, MEDICAL_KEYWORDS, loc, clamp } from "./config.mjs";
import { logEvent } from "./timeline.mjs";

const RULE_SLUG_ATK = "hopefinder-broken-atk";
const RULE_SLUG_DMG = "hopefinder-broken-dmg";
const BROKEN_PENALTY = -2;

/* ============================================= */
/*  Small internal helpers                       */
/* ============================================= */

function speakerFor(actor) {
  return ChatMessage.getSpeaker({ actor });
}

function postChat(actor, content) {
  return ChatMessage.create({ content, speaker: speakerFor(actor) });
}

function usesHopefinderSheet(actor) {
  if (!actor || actor.type !== "character") return false;
  const core = actor.getFlag?.("core", "sheetClass");
  if (typeof core === "string" && core.includes("HopefinderSheet")) return true;
  return actor.sheet?.constructor?.name === "HopefinderSheet";
}

/** Degree of success for a flat check (no modifiers), honoring nat 1 / nat 20. */
export function flatCheckOutcome(total, dc) {
  let degree = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (total === 20) degree = Math.min(3, degree + 1);
  if (total === 1) degree = Math.max(0, degree - 1);
  return ["criticalFailure", "failure", "success", "criticalSuccess"][degree];
}

/** True for the fists/body-part strike (the "unarmed" case for Critical Miss). */
export function isUnarmedItem(item) {
  if (!item) return false;
  return item.system?.category === "unarmed" ||
    (item.system?.traits?.value ?? []).includes("unarmed") ||
    item.slug === "basic-unarmed";
}

/* ============================================= */
/*  GearIntegrityManager                         */
/* ============================================= */

export const GearIntegrityManager = {

  /** Whether this item has a tracked Break Value at all. */
  hasIntegrity(item) {
    return !!item && (item.system?.hp?.max ?? 0) > 0;
  },

  getBreakValue(item) {
    return item?.system?.hp?.max ?? 0;
  },

  getDings(item) {
    if (!this.hasIntegrity(item)) return 0;
    return (item.system.hp.max ?? 0) - (item.system.hp.value ?? 0);
  },

  /** Native PF2e getters already implement Hopefinder's own broken/destroyed math. */
  isBroken(item) {
    return !!item?.isBroken;
  },
  isDestroyed(item) {
    return !!item?.isDestroyed;
  },

  /**
   * Apply one or more Dings to an item's Integrity.
   * @param {Item} item
   * @param {number} amount
   * @param {{via?: string, silent?: boolean}} [opts]
   */
  async addDing(item, amount = 1, opts = {}) {
    if (!this.hasIntegrity(item) || amount <= 0) return null;
    const hp = item.system.hp;
    const before = hp.value ?? 0;
    const after = clamp(before - amount, 0, hp.max);
    const applied = before - after;
    if (applied <= 0) return null;

    const wasBroken = this.isBroken(item);
    const wasDestroyed = this.isDestroyed(item);
    await item.update({ "system.hp.value": after });
    const nowBroken = this.isBroken(item);
    const nowDestroyed = this.isDestroyed(item);

    if (!opts.silent) {
      const actor = item.actor;
      let content = loc("Chat.Ding", { item: item.name, dings: after, max: hp.max });
      if (nowDestroyed && !wasDestroyed) content = loc("Chat.Destroyed", { item: item.name });
      else if (nowBroken && !wasBroken) content = loc("Chat.Broken", { item: item.name });
      if (actor) {
        await postChat(actor, content);
        if (usesHopefinderSheet(actor)) {
          const type = nowDestroyed && !wasDestroyed ? "destroyed" : nowBroken && !wasBroken ? "broken" : "ding";
          logEvent(actor, type, content);
        }
      }
    }
    return { item, before, after, applied, broken: nowBroken, destroyed: nowDestroyed };
  },

  /**
   * Restore Integrity (Repair action). Cannot repair a Destroyed item —
   * RAW requires rebuilding it from parts instead.
   */
  async repairItem(item, amount = 1, opts = {}) {
    if (!this.hasIntegrity(item) || amount <= 0) return null;
    if (this.isDestroyed(item)) {
      ui.notifications?.warn(loc("Warn.CannotRepairDestroyed", { item: item.name }));
      return null;
    }
    const hp = item.system.hp;
    const before = hp.value ?? 0;
    const after = clamp(before + amount, 0, hp.max);
    const applied = after - before;
    if (applied <= 0) return null;
    await item.update({ "system.hp.value": after });

    if (!opts.silent) {
      const actor = item.actor;
      const content = loc("Chat.Repaired", { item: item.name, amount: applied, dings: after, max: hp.max });
      if (actor) {
        await postChat(actor, content);
        if (usesHopefinderSheet(actor)) logEvent(actor, "repair", content);
      }
    }
    return { item, before, after, applied };
  },

  /* ── Weapon broken penalty (-2 attack / -2 damage) ── */

  /** Keep a weapon's self-scoped FlatModifier rule elements in sync with its broken state. */
  async syncWeaponBrokenRules(item) {
    if (!item || item.type !== "weapon") return;
    const current = foundry.utils.deepClone(item.system.rules ?? []);
    const stripped = current.filter(r => r.slug !== RULE_SLUG_ATK && r.slug !== RULE_SLUG_DMG);
    const shouldPenalize = this.isBroken(item);
    const next = shouldPenalize ? [
      ...stripped,
      { key: "FlatModifier", selector: `${item.id}-attack`, type: "untyped", value: BROKEN_PENALTY, label: "Hopefinder: Broken", slug: RULE_SLUG_ATK },
      { key: "FlatModifier", selector: `${item.id}-damage`, type: "untyped", value: BROKEN_PENALTY, label: "Hopefinder: Broken", slug: RULE_SLUG_DMG }
    ] : stripped;
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await item.update({ "system.rules": next });
    }
  },

  /** Re-sync every weapon's broken penalty on an actor. */
  async updateWeaponPenalties(actor) {
    if (!actor) return;
    for (const weapon of actor.itemTypes?.weapon ?? []) {
      await this.syncWeaponBrokenRules(weapon);
    }
  },

  /* ── Armor Resistance (halved while Broken, 0 while Destroyed) ── */

  getBaseResistance(item) {
    return item?.getFlag(MODULE_ID, ITEM_FLAGS.RESISTANCE) ?? { value: 0, types: "", helmet: false };
  },

  async setBaseResistance(item, { value, types, helmet }) {
    return item.setFlag(MODULE_ID, ITEM_FLAGS.RESISTANCE, {
      value: Math.max(0, Number(value) || 0),
      types: String(types ?? "").trim(),
      helmet: !!helmet
    });
  },

  /** Effective Resistance right now: halved (round down) if Broken, 0 if Destroyed. */
  getEffectiveResistance(item) {
    const base = this.getBaseResistance(item).value ?? 0;
    if (this.isDestroyed(item)) return 0;
    if (this.isBroken(item)) return Math.floor(base / 2);
    return base;
  },

  /** Recompute effective Resistance for every armor piece on an actor. */
  updateArmorResistance(actor) {
    if (!actor) return [];
    return (actor.itemTypes?.armor ?? []).map(item => ({
      item,
      base: this.getBaseResistance(item).value ?? 0,
      effective: this.getEffectiveResistance(item)
    }));
  },

  /* ── Destroyed handling ── */

  /** Force-unequip an item that can no longer be used, and warn. */
  async enforceDestroyed(item) {
    if (!this.isDestroyed(item)) return false;
    const carry = item.system?.equipped?.carryType;
    if (carry === "held" || carry === "worn") {
      await item.update({ "system.equipped.carryType": "stowed", "system.equipped.handsHeld": 0 });
      if (item.actor) ui.notifications?.warn(loc("Chat.Destroyed", { item: item.name }));
      return true;
    }
    return false;
  },

  /* ── Repair (Crafting check, Hopefinder's own DC & amounts) ── */

  /** Best-effort read on whether an item needs the +4 electronic/medicine/synthetic repair DC. */
  isTechOrMedical(item) {
    const sys = item.system ?? {};
    if ((sys.traits?.value ?? []).includes("tech")) return true;
    if (item.type === "consumable" && (MEDICAL_CATEGORIES.includes(sys.category ?? "") || MEDICAL_KEYWORDS.test(item.name))) return true;
    return false;
  },

  getRepairDC(item) {
    return 10 + this.getBreakValue(item) + (this.isTechOrMedical(item) ? 4 : 0);
  },

  /** Success: +1 Integrity (+2 master+). Critical Success: +2 (+3 master, +4 legendary). */
  repairAmountFor(outcome, craftingRank) {
    if (outcome === "criticalSuccess") return craftingRank >= 4 ? 4 : craftingRank === 3 ? 3 : 2;
    if (outcome === "success") return craftingRank >= 3 ? 2 : 1;
    return 0;
  },

  /** Launch the Hopefinder Repair flow: a Crafting check against Break-Value DC. */
  async runRepair(actor, item, options = {}) {
    if (!this.hasIntegrity(item)) {
      ui.notifications?.warn(loc("Warn.NothingToRepair", { item: item?.name ?? "" }));
      return;
    }
    if (this.isDestroyed(item)) {
      ui.notifications?.warn(loc("Warn.CannotRepairDestroyed", { item: item.name }));
      return;
    }
    const crafting = actor.skills?.crafting;
    if (!crafting?.roll) {
      ui.notifications?.warn(loc("Warn.ActionUnavailable", { action: "crafting" }));
      return;
    }
    const dc = this.getRepairDC(item);
    await crafting.roll({
      dc: { value: dc, visible: true },
      extraRollOptions: ["action:repair", "action:hf-repair"],
      traits: ["exploration", "manipulate"],
      title: loc("Arsenal.Repair") + ` — ${item.name}`,
      event: options.event,
      callback: async (roll, outcome) => {
        const rank = actor.skills?.crafting?.rank ?? 0;
        if (outcome === "success" || outcome === "criticalSuccess") {
          await this.repairItem(item, this.repairAmountFor(outcome, rank));
        } else if (outcome === "criticalFailure") {
          await this.addDing(item, 1, { via: "repair-fail" });
          await postChat(actor, loc("Chat.RepairCriticalFailure", { item: item.name }));
        }
      }
    });
  },

  /* ── Bruises (unarmed Critical Miss target) — simple counter, no UI thresholds ── */

  getBruises(actor) {
    return actor?.getFlag(MODULE_ID, FLAGS.BRUISES) ?? 0;
  },

  async addBruise(actor, amount = 1) {
    if (!actor) return;
    const next = Math.max(0, this.getBruises(actor) + amount);
    await actor.setFlag(MODULE_ID, FLAGS.BRUISES, next);
    return next;
  },

  /* ── "Ready" gear pool (equipped items with a Break Value) ── */

  getReadyItems(actor) {
    if (!actor) return [];
    return actor.items.filter(i => {
      const carry = i.system?.equipped?.carryType;
      return (carry === "held" || carry === "worn") && this.hasIntegrity(i) && !this.isDestroyed(i);
    });
  },

  /**
   * Special-ability entry point ("Deal 1 Ding", "Armor takes a Ding", …).
   * Meant to be called from macros / GM tools with an explicit item, or
   * with an actor to Ding a random Ready item on their behalf.
   */
  async dealDings(target, amount = 1, opts = {}) {
    if (!target) return null;
    if (target.documentName === "Item") return this.addDing(target, amount, opts);
    const pool = opts.armorOnly ? (target.itemTypes?.armor ?? []).filter(a => !this.isDestroyed(a)) : this.getReadyItems(target);
    if (!pool.length) {
      ui.notifications?.warn(loc("Chat.CombatEndNoGear", { actor: target.name }));
      return null;
    }
    const results = [];
    for (let i = 0; i < amount; i++) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      results.push(await this.addDing(pick, 1, opts));
    }
    return results;
  }
};

/* ============================================= */
/*  Reactive sync — any hp/equip change, from     */
/*  any source, keeps derived state consistent.   */
/* ============================================= */

function registerReactiveSync() {
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (userId !== game.user.id) return;
    const hpChanged = foundry.utils.hasProperty(changes, "system.hp.value") || foundry.utils.hasProperty(changes, "system.hp.max");
    const carryChanged = foundry.utils.hasProperty(changes, "system.equipped.carryType");
    if (hpChanged && item.type === "weapon") await GearIntegrityManager.syncWeaponBrokenRules(item);
    if (hpChanged || carryChanged) await GearIntegrityManager.enforceDestroyed(item);
  });
}

/* ============================================= */
/*  A) Critical Miss                              */
/* ============================================= */

function registerCriticalMissHook() {
  Hooks.on("createChatMessage", async (message, options, userId) => {
    if (userId !== game.user.id) return;
    const ctx = message.flags?.pf2e?.context;
    if (!ctx || ctx.type !== "attack-roll") return;
    if (ctx.outcome !== "criticalFailure") return;

    const actor = message.actor;
    const item = message.item;
    if (!actor || !item) return;

    if (isUnarmedItem(item)) {
      await GearIntegrityManager.addBruise(actor, 1);
      await postChat(actor, loc("Chat.CriticalMissBruise", { actor: actor.name }));
      if (usesHopefinderSheet(actor)) logEvent(actor, "bruise", loc("Chat.CriticalMissBruise", { actor: actor.name }));
    } else if (GearIntegrityManager.hasIntegrity(item)) {
      await GearIntegrityManager.addDing(item, 1, { via: "critical-miss" });
    }
  });
}

/* ============================================= */
/*  B) End of Combat                              */
/* ============================================= */

async function resolveCombatEndFor(actor, dc, roundLabel) {
  const roll = await new Roll("1d20").evaluate();
  const outcome = flatCheckOutcome(roll.total, dc);
  const flavor = loc("Chat.CombatEndTitle");

  if (outcome === "success" || outcome === "criticalSuccess") {
    await ChatMessage.create({
      flavor,
      content: loc("Chat.CombatEndPass", { actor: actor.name, total: roll.total, dc }),
      speaker: speakerFor(actor),
      rolls: [roll]
    });
    return;
  }

  const ready = GearIntegrityManager.getReadyItems(actor);
  if (!ready.length) {
    await ChatMessage.create({
      flavor,
      content: loc("Chat.CombatEndNoGear", { actor: actor.name }),
      speaker: speakerFor(actor),
      rolls: [roll]
    });
    return;
  }

  if (outcome === "criticalFailure") {
    const countRoll = await new Roll("1d4").evaluate();
    const n = Math.min(countRoll.total, ready.length);
    const picked = [];
    const pool = [...ready];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const [item] = pool.splice(idx, 1);
      picked.push(item);
      await GearIntegrityManager.addDing(item, 1, { via: "combat-end", silent: true });
    }
    await ChatMessage.create({
      flavor,
      content: loc("Chat.CombatEndCritFail", { actor: actor.name, total: roll.total, dc, n, items: picked.map(i => i.name).join(", ") }),
      speaker: speakerFor(actor),
      rolls: [roll]
    });
  } else {
    const item = ready[Math.floor(Math.random() * ready.length)];
    await GearIntegrityManager.addDing(item, 1, { via: "combat-end", silent: true });
    await ChatMessage.create({
      flavor,
      content: loc("Chat.CombatEndFail", { actor: actor.name, item: item.name, total: roll.total, dc }),
      speaker: speakerFor(actor),
      rolls: [roll]
    });
  }
}

function registerCombatEndHook() {
  Hooks.on("deleteCombat", async combat => {
    if (!game.user.isGM) return;
    const rounds = Math.max(1, combat.round || 1);
    const dc = 5 + rounds;
    const actors = new Set();
    for (const c of combat.combatants) {
      if (c.actor?.type === "character") actors.add(c.actor);
    }
    for (const actor of actors) {
      await resolveCombatEndFor(actor, dc);
    }
  });
}

/* ============================================= */
/*  C) Special abilities ("Deal 1 Ding", …)       */
/*     — detected, but GM-confirmed before firing */
/*     to avoid guessing at an unintended target. */
/* ============================================= */

const DING_TEXT = /deal[s]?\s+(\d+)\s+dings?|armor\s+takes?\s+a\s+ding/i;

function extractDingClause(item) {
  if (!item) return null;
  const haystack = `${item.name ?? ""} ${item.system?.description?.value ?? ""}`;
  const match = DING_TEXT.exec(haystack);
  if (!match) return null;
  return { amount: match[1] ? Number(match[1]) : 1, armorOnly: /armor/i.test(match[0]) };
}

function registerSpecialAbilityHook() {
  const handler = (message, html) => {
    const ctx = message.flags?.pf2e?.context;
    if (!ctx || !["attack-roll", "damage-roll"].includes(ctx.type)) return;
    const clause = extractDingClause(message.item);
    if (!clause) return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    const container = root?.querySelector(".message-content") ?? root;
    if (!container || container.querySelector(".hf-ding-apply-btn")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hf-ding-apply-btn";
    btn.innerHTML = `<i class="fas fa-hammer"></i> ${loc("Chat.ApplyDings", { n: clause.amount })}`;
    btn.addEventListener("click", async () => {
      const target = game.user.targets.first()?.actor;
      if (!target) { ui.notifications?.warn(loc("Warn.NoTarget")); return; }
      await GearIntegrityManager.dealDings(target, clause.amount, { via: "ability", armorOnly: clause.armorOnly });
    });
    container.appendChild(btn);
  };

  Hooks.on("renderChatMessageHTML", (message, html) => handler(message, html));
  Hooks.on("renderChatMessage", (message, html) => handler(message, html));
}

/* ============================================= */
/*  Damage → Resistance → armor Ding (p.36)       */
/*  GM-confirmed dialog: the RAW requires human    */
/*  judgment (damage type coverage, crit/Helmet)   */
/*  that can't be inferred safely from the roll.   */
/* ============================================= */

async function openResolveHitDialog({ actorHint, rawDamage, sourceName }) {
  const target = game.user.targets.first()?.actor ?? actorHint;
  if (!target) { ui.notifications?.warn(loc("Warn.NoTarget")); return; }

  const armor = (target.itemTypes?.armor ?? []).find(a => a.system.equipped?.carryType === "worn") ?? null;
  const base = armor ? GearIntegrityManager.getBaseResistance(armor) : { value: 0, types: "", helmet: false };
  const effective = armor ? GearIntegrityManager.getEffectiveResistance(armor) : 0;

  const content = `
    <form class="hf-resolve-hit-form">
      <p>${sourceName ? foundry.utils.escapeHTML(sourceName) + " → " : ""}${foundry.utils.escapeHTML(target.name)}${armor ? ` (${foundry.utils.escapeHTML(armor.name)})` : ""}</p>
      <div class="form-group">
        <label>${loc("Dialog.Damage")}</label>
        <input type="number" name="damage" value="${Number(rawDamage) || 0}" min="0">
      </div>
      <div class="form-group">
        <label>${loc("Dialog.Resistance")}</label>
        <input type="number" name="resistance" value="${effective}" min="0">
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="typeCovered" checked> ${loc("Dialog.TypeCovered")}</label>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="critical"> ${loc("Dialog.CriticalHit")}</label>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="helmet" ${base.helmet ? "checked" : ""}> ${loc("Dialog.Helmet")}</label>
      </div>
    </form>`;

  const apply = async formEl => {
    const data = new FormData(formEl);
    const dmg = Number(data.get("damage")) || 0;
    const typeCovered = data.get("typeCovered") === "on";
    const critical = data.get("critical") === "on";
    const helmet = data.get("helmet") === "on";
    const resistanceApplies = typeCovered && !(critical && !helmet);
    const resistance = resistanceApplies ? (Number(data.get("resistance")) || 0) : 0;
    const final = Math.max(0, dmg - resistance);

    if (resistance > 0 && dmg <= resistance) {
      await GearIntegrityManager.addBruise(target, 1);
      await postChat(target, loc("Chat.AbsorbedFully", { actor: target.name }));
      return;
    }

    if (final > 0) {
      const hp = target.system.attributes.hp;
      await target.update({ "system.attributes.hp.value": clamp((hp.value ?? 0) - final, 0, hp.max) });
    }
    if (resistance > 0 && dmg > resistance && armor) {
      await GearIntegrityManager.addDing(armor, 1, { via: "absorption" });
    }
  };

  const D2 = foundry.applications?.api?.DialogV2;
  if (D2?.wait) {
    return D2.wait({
      window: { title: loc("Dialog.ResolveHitTitle") },
      content,
      buttons: [{
        action: "apply", label: loc("Dialog.Apply"), icon: "fas fa-check", default: true,
        callback: (event, button) => apply(button.form ?? event.currentTarget.closest("dialog").querySelector("form"))
      }]
    });
  }
  return new Dialog({
    title: loc("Dialog.ResolveHitTitle"),
    content,
    buttons: { apply: { icon: '<i class="fas fa-check"></i>', label: loc("Dialog.Apply"), callback: html => apply((html[0] ?? html).querySelector("form")) } },
    default: "apply"
  }).render(true);
}

function registerResolveHitHook() {
  const handler = (message, html) => {
    const ctx = message.flags?.pf2e?.context;
    if (!ctx || ctx.type !== "damage-roll") return;
    const item = message.item;
    if (!item || (item.type !== "weapon" && !isUnarmedItem(item))) return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    const container = root?.querySelector(".message-content") ?? root;
    if (!container || container.querySelector(".hf-resolve-hit-btn")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hf-resolve-hit-btn";
    btn.innerHTML = `<i class="fas fa-shield-halved"></i> ${loc("Dialog.ResolveHitTitle")}`;
    btn.addEventListener("click", () => {
      const roll = message.rolls?.[0];
      openResolveHitDialog({ actorHint: null, rawDamage: roll?.total ?? 0, sourceName: item.name });
    });
    container.appendChild(btn);
  };

  Hooks.on("renderChatMessageHTML", (message, html) => handler(message, html));
  Hooks.on("renderChatMessage", (message, html) => handler(message, html));
}

/* ============================================= */
/*  Public entry point                            */
/* ============================================= */

export function registerGearIntegrityHooks() {
  registerReactiveSync();
  registerCriticalMissHook();
  registerCombatEndHook();
  registerSpecialAbilityHook();
  registerResolveHitHook();
}
