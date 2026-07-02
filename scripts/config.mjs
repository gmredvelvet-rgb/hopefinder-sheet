/**
 * Hopefinder Survivor Sheet — Central configuration.
 * Single source of truth for module constants, vital-sign definitions,
 * tab registry and shared enums. No logic lives here.
 */

export const MODULE_ID = "hopefinder-sheet";

/** Flag keys stored under actor.flags[MODULE_ID] */
export const FLAGS = {
  VITALS: "vitals",
  TIMELINE: "timeline",
  FACTIONS: "factions",
  CONTACTS: "contacts",
  OBJECTIVES: "objectives",
  THREAT: "threat",
  ARCHETYPE: "archetype",
  CALLSIGN: "callsign",
  BACKDROP: "backdrop",
  FAVORITES: "favorites",
  BRUISES: "bruises"
};

/** Item-level flag keys stored under item.flags[MODULE_ID] (Dings & Broken Gear). */
export const ITEM_FLAGS = {
  RESISTANCE: "resistance"
};

/** Maximum number of timeline entries kept per actor. */
export const TIMELINE_CAP = 120;

/**
 * Vital sign definitions.
 * kind:
 *  - "bad"  → higher value is worse (0 = healthy)
 *  - "good" → higher value is better (max = healthy)
 *  - "band" → middle of the scale is healthy (temperature)
 * group: visual grouping on the Vitals tab.
 */
export const VITALS = [
  { key: "bleeding",  icon: "fa-droplet",          kind: "bad",  group: "condition", max: 10 },
  { key: "infection", icon: "fa-biohazard",        kind: "bad",  group: "condition", max: 10 },
  { key: "trauma",    icon: "fa-heart-crack",      kind: "bad",  group: "condition", max: 10 },
  { key: "hunger",    icon: "fa-drumstick-bite",   kind: "bad",  group: "needs",     max: 10 },
  { key: "thirst",    icon: "fa-glass-water",      kind: "bad",  group: "needs",     max: 10 },
  { key: "fatigue",   icon: "fa-battery-quarter",  kind: "bad",  group: "needs",     max: 10 },
  { key: "sleep",     icon: "fa-moon",             kind: "bad",  group: "needs",     max: 10 },
  { key: "temperature", icon: "fa-temperature-half", kind: "band", group: "needs",   max: 10 },
  { key: "stress",    icon: "fa-brain",            kind: "bad",  group: "mind",      max: 10 },
  { key: "addiction", icon: "fa-pills",            kind: "bad",  group: "mind",      max: 10 },
  { key: "morale",    icon: "fa-face-smile",       kind: "good", group: "mind",      max: 10 }
];

export const VITAL_GROUPS = ["condition", "needs", "mind"];

/** Severity bands for "bad" vitals (value / max). */
export const SEVERITY_BANDS = [
  { max: 0.0,  id: "clear" },
  { max: 0.35, id: "low" },
  { max: 0.65, id: "elevated" },
  { max: 0.9,  id: "high" },
  { max: 1.01, id: "critical" }
];

/** Sheet tab registry — order defines nav order. */
export const TABS = [
  { id: "survivor", icon: "fa-address-card" },
  { id: "vitals",   icon: "fa-heart-pulse" },
  { id: "gear",     icon: "fa-boxes-stacked" },
  { id: "arsenal",  icon: "fa-crosshairs" },
  { id: "medical",  icon: "fa-kit-medical" },
  { id: "skills",   icon: "fa-diagram-project" },
  { id: "journal",  icon: "fa-book-open" },
  { id: "factions", icon: "fa-handshake" },
  { id: "timeline", icon: "fa-clock-rotate-left" }
];

/** Physical item types shown in the Gear grid. */
export const PHYSICAL_TYPES = [
  "weapon", "armor", "shield", "equipment", "consumable", "ammo", "treasure", "backpack", "kit", "book"
];

/** Gear filter chips. */
export const GEAR_FILTERS = [
  { id: "all" },
  { id: "weapon" },
  { id: "armor" },
  { id: "consumable" },
  { id: "ammo" },
  { id: "equipment" },
  { id: "container" },
  { id: "favorites" }
];

/** Consumable categories considered "medical". */
export const MEDICAL_CATEGORIES = ["potion", "elixir", "drug", "oil", "mutagen", "poison"];

/** Keywords that flag equipment/consumables as medical or provisions. */
export const MEDICAL_KEYWORDS = /bandage|venda|tourniquet|torniquete|medkit|first.?aid|antidote|ant[ií]doto|antibiotic|antibi[oó]tico|vaccine|vacuna|medicine|medicina|painkiller|analg[eé]sico|splint|f[eé]rula|suture|sutura|morphine|morfina|adrenaline|adrenalina|syringe|jeringa|pill|pastilla|healer'?s|salve|ungüento/i;
export const PROVISION_KEYWORDS = /ration|raci[oó]n|food|comida|water|agua|canteen|cantimplora|drink|bebida|meal|jerky|cecina|can(ned)?\s|lata|snack|provision/i;

/** PF2e condition slugs offered in the quick condition menu. */
export const QUICK_CONDITIONS = [
  "frightened", "sickened", "fatigued", "drained", "enfeebled", "clumsy", "stupefied",
  "slowed", "stunned", "prone", "grabbed", "immobilized", "blinded", "dazzled",
  "deafened", "confused", "fascinated", "fleeing", "paralyzed", "unconscious", "off-guard"
];

/** Proficiency rank ids, indexed by PF2e rank number. */
export const RANKS = ["untrained", "trained", "expert", "master", "legendary"];

/** Faction standing scale: -3 (hostile) … +3 (allied). */
export const STANDING_MIN = -3;
export const STANDING_MAX = 3;

/** Threat level scale shown on the Survivor tab. */
export const THREAT_MAX = 5;

/** Timeline event types → icon. */
export const TIMELINE_ICONS = {
  damage: "fa-burst",
  heal: "fa-suitcase-medical",
  death: "fa-skull",
  levelup: "fa-ranking-star",
  item_use: "fa-hand-holding-medical",
  loot: "fa-box-open",
  drop: "fa-arrow-down-from-line",
  equip: "fa-shield-halved",
  vital: "fa-wave-square",
  faction: "fa-handshake",
  note: "fa-pen",
  condition: "fa-triangle-exclamation",
  ding: "fa-hammer",
  broken: "fa-triangle-exclamation",
  destroyed: "fa-skull-crossbones",
  repair: "fa-screwdriver-wrench",
  bruise: "fa-hand-fist"
};

/** Localization helper — resolves `HOPEFINDER.<key>` */
export function loc(key, data) {
  const k = `HOPEFINDER.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

/** Signed modifier string ("+4" / "-1"). */
export function signed(n) {
  n = Number(n) || 0;
  return (n >= 0 ? "+" : "") + n;
}

/** Clamp helper (Math.clamp is a Foundry extension; keep a local fallback). */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
