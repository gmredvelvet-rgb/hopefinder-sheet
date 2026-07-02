/**
 * Hopefinder Survivor Sheet — Timeline (event log) data layer.
 * A capped chronological log of significant character events, stored as an
 * actor flag. Sheet actions push entries directly; world hooks capture
 * events that originate outside the sheet (HP changes, level-ups, loot).
 */

import { MODULE_ID, FLAGS, TIMELINE_CAP, TIMELINE_ICONS, loc } from "./config.mjs";

/** Read the raw timeline array (newest first). */
export function getTimeline(actor) {
  return actor.getFlag(MODULE_ID, FLAGS.TIMELINE) ?? [];
}

/**
 * Push an event onto an actor's timeline.
 * @param {Actor} actor
 * @param {string} type   One of TIMELINE_ICONS keys.
 * @param {string} text   Already-localized display text.
 */
export function logEvent(actor, type, text) {
  if (!actor?.isOwner) return Promise.resolve();
  const entries = [{ t: Date.now(), type, text }, ...getTimeline(actor)];
  if (entries.length > TIMELINE_CAP) entries.length = TIMELINE_CAP;
  return actor.setFlag(MODULE_ID, FLAGS.TIMELINE, entries);
}

/** Remove a single entry by its timestamp. */
export function removeEvent(actor, timestamp) {
  const entries = getTimeline(actor).filter(e => e.t !== timestamp);
  return actor.setFlag(MODULE_ID, FLAGS.TIMELINE, entries);
}

/** Clear the whole log. */
export function clearTimeline(actor) {
  return actor.setFlag(MODULE_ID, FLAGS.TIMELINE, []);
}

/** Render-ready context: grouped by calendar day, newest first. */
export function prepareTimeline(actor) {
  const groups = new Map();
  for (const e of getTimeline(actor)) {
    const date = new Date(e.t);
    const dayKey = date.toLocaleDateString(game.i18n.lang, { year: "numeric", month: "short", day: "numeric" });
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push({
      t: e.t,
      type: e.type,
      icon: TIMELINE_ICONS[e.type] ?? "fa-circle-dot",
      text: e.text,
      time: date.toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit" })
    });
  }
  return [...groups.entries()].map(([day, events]) => ({ day, events }));
}

/* -------------------------------------------- */
/*  World hooks — auto-capture                  */
/* -------------------------------------------- */

/**
 * Whether an actor uses this module's sheet (avoids logging for actors
 * rendered with other sheets).
 */
function usesHopefinderSheet(actor) {
  if (actor.type !== "character") return false;
  const core = actor.getFlag("core", "sheetClass");
  if (typeof core === "string" && core.includes("HopefinderSheet")) return true;
  // Covers the case where this sheet is the world default (no per-actor flag)
  return actor.sheet?.constructor?.name === "HopefinderSheet";
}

/** Register world-level hooks that feed the timeline automatically. */
export function registerTimelineHooks() {
  Hooks.on("preUpdateActor", (actor, changes, options) => {
    if (!usesHopefinderSheet(actor)) return;
    const newHP = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (newHP !== undefined) {
      options[`${MODULE_ID}.prevHP`] = actor.system.attributes?.hp?.value ?? 0;
    }
    const newLevel = foundry.utils.getProperty(changes, "system.details.level.value");
    if (newLevel !== undefined) {
      options[`${MODULE_ID}.prevLevel`] = actor.system.details?.level?.value ?? 0;
    }
  });

  Hooks.on("updateActor", (actor, changes, options, userId) => {
    // Only the client that made the change writes the log entry.
    if (game.user.id !== userId) return;
    if (!usesHopefinderSheet(actor)) return;

    const prevHP = options[`${MODULE_ID}.prevHP`];
    const newHP = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (prevHP !== undefined && newHP !== undefined && newHP !== prevHP) {
      const delta = newHP - prevHP;
      if (newHP <= 0 && prevHP > 0) {
        logEvent(actor, "death", loc("Timeline.WentDown", { amount: Math.abs(delta) }));
      } else if (delta < 0) {
        logEvent(actor, "damage", loc("Timeline.TookDamage", { amount: Math.abs(delta) }));
      } else {
        logEvent(actor, "heal", loc("Timeline.Healed", { amount: delta }));
      }
    }

    const prevLevel = options[`${MODULE_ID}.prevLevel`];
    const newLevel = foundry.utils.getProperty(changes, "system.details.level.value");
    if (prevLevel !== undefined && newLevel !== undefined && newLevel > prevLevel) {
      logEvent(actor, "levelup", loc("Timeline.LevelUp", { level: newLevel }));
    }
  });

  Hooks.on("createItem", (item, options, userId) => {
    if (game.user.id !== userId) return;
    const actor = item.actor;
    if (!actor || !usesHopefinderSheet(actor)) return;
    if (!item.system?.quantity && item.system?.quantity !== 0) return; // physical items only
    logEvent(actor, "loot", loc("Timeline.Acquired", { item: item.name }));
  });

  Hooks.on("deleteItem", (item, options, userId) => {
    if (game.user.id !== userId) return;
    const actor = item.actor;
    if (!actor || !usesHopefinderSheet(actor)) return;
    if (!item.system?.quantity && item.system?.quantity !== 0) return;
    logEvent(actor, "drop", loc("Timeline.Discarded", { item: item.name }));
  });
}
