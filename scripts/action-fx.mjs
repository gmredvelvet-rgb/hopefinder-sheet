/**
 * Hopefinder Survivor Sheet — Weapon action FX (sound + image).
 * Per-weapon-item flags let a GM/player wire a Foundry Playlist track to
 * each roll type (attack 1/2/3, damage, critical) and a still image to the
 * weapon. Sound plays through Foundry's native Playlist API (synced to all
 * clients by the document update); the image is broadcast via the
 * vnd-enhanced.actionImage hook so vnd-enhanced (if installed) can show its
 * overlay — this module has no hard dependency on it.
 */

import { MODULE_ID } from "./config.mjs";

export const ROLL_TYPES = ["attack1", "attack2", "attack3", "damage", "critical"];

export const ROLL_LABEL_KEYS = {
  attack1: "ActionFx.Attack1",
  attack2: "ActionFx.Attack2",
  attack3: "ActionFx.Attack3",
  damage: "ActionFx.Damage",
  critical: "ActionFx.Critical"
};

export const ROLL_ICONS = {
  attack1: "fa-dice-d20",
  attack2: "fa-dice-d20",
  attack3: "fa-dice-d20",
  damage: "fa-bolt",
  critical: "fa-skull-crossbones"
};

/** Read the full FX config for an item: { sounds: { [rollType]: {playlist, track, volume} }, image }. */
export function getActionFx(item) {
  const fx = item?.getFlag(MODULE_ID, "actionFx");
  return { sounds: {}, image: "", ...fx };
}

/** True if this item has any sound or image configured. */
export function hasActionFx(item) {
  const fx = getActionFx(item);
  if (fx.image) return true;
  return Object.values(fx.sounds ?? {}).some(c => c?.playlist && c?.track);
}

/** Persist one roll-type's sound config. */
export function setActionFxSound(item, rollType, { playlist = "", track = "", volume = 0.8 } = {}) {
  return item.setFlag(MODULE_ID, `actionFx.sounds.${rollType}`, { playlist, track, volume });
}

/** Persist the shared action image path. */
export function setActionFxImage(item, path) {
  return item.setFlag(MODULE_ID, "actionFx.image", path ?? "");
}

/**
 * Determine the roll-type key from a PF2e ChatMessage for per-roll-type sound.
 * Returns "attack1" | "attack2" | "attack3" | "damage" | "critical" | null.
 */
export function detectRollType(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx) return null;

  if (ctx.type === "damage-roll") {
    return ctx.outcome === "criticalSuccess" ? "critical" : "damage";
  }
  if (ctx.type === "attack-roll" || ctx.type === "spell-attack-roll") {
    const mapIncreases = ctx.mapIncreases ?? ctx["map-increases"] ?? 0;
    if (mapIncreases >= 2) return "attack3";
    if (mapIncreases === 1) return "attack2";
    return "attack1";
  }
  return null;
}

/** Resolve the {playlist, track, volume} to play for this item + message (falls back to attack1/damage). */
function resolveSoundConfig(item, message) {
  const rollType = detectRollType(message);
  if (!rollType) return null;
  const sounds = getActionFx(item).sounds ?? {};

  const direct = sounds[rollType];
  if (direct?.playlist && direct?.track) return direct;

  const fallbackKey = rollType.startsWith("attack") ? "attack1" : "damage";
  const fallback = sounds[fallbackKey];
  if (fallback?.playlist && fallback?.track) return fallback;

  return null;
}

/** Play a configured playlist track (native Foundry sync — requires Playlist update permission). */
export async function playActionSound(playlistId, trackId, volume = 0.8) {
  const playlist = game.playlists?.get(playlistId);
  if (!playlist) return;

  if (trackId === "random-track") {
    const ids = playlist.sounds.map(s => s.id);
    if (!ids.length) return;
    trackId = ids[Math.floor(Math.random() * ids.length)];
  }

  const sound = playlist.sounds.get(trackId);
  if (!sound) return;

  const original = sound.volume;
  if (Math.abs(original - volume) > 0.01) await sound.update({ volume });
  await playlist.playSound(sound);
  if (Math.abs(original - volume) > 0.01) {
    setTimeout(() => sound.update({ volume: original }), 500);
  }
}

function isFirstActiveGM() {
  return game.user === game.users.find(u => u.isGM && u.active);
}

/** Wire the createChatMessage hooks: sound playback (GM-gated) + image overlay broadcast (all clients). */
export function registerActionFxHooks() {
  Hooks.on("createChatMessage", async message => {
    if (!isFirstActiveGM()) return;
    if (message.getFlag(MODULE_ID, "actionFxSoundPlayed")) return;

    const item = message.item;
    if (!item) return;

    const cfg = resolveSoundConfig(item, message);
    if (!cfg) return;

    await playActionSound(cfg.playlist, cfg.track, cfg.volume ?? 0.8);
    await message.setFlag(MODULE_ID, "actionFxSoundPlayed", true);
  });

  // No GM guard — fires on every client so everyone sees the overlay (vnd-enhanced decides visibility).
  Hooks.on("createChatMessage", message => {
    try {
      const item = message.item;
      if (!item) return;

      const imagePath = getActionFx(item).image;
      if (!imagePath) return;

      const rollType = detectRollType(message);
      const overlayRollType = rollType === "critical" || rollType === "damage" ? rollType : "attack";
      const actor = message.actor;
      Hooks.callAll("vnd-enhanced.actionImage", {
        imagePath,
        actorName: actor?.name ?? message.speaker?.alias ?? "",
        actorImg: actor?.img ?? "",
        actionName: item.name ?? "",
        rollType: overlayRollType
      });
    } catch (e) {
      console.warn(`${MODULE_ID} | action FX image error:`, e);
    }
  });
}
