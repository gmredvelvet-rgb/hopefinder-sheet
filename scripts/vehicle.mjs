/**
 * Hopefinder Vehicle — data layer & travel engine.
 * Vehicle wear (wheels, engine, battery, chassis), fuel and travel mechanics
 * are not part of the PF2e vehicle data model, so they are persisted as
 * actor flags under this module's scope — the same pattern as vitals.mjs.
 *
 * Mechanics:
 *  - Fuel burn = consumption (L/100 km) × engine-wear multiplier. A worn
 *    engine burns up to 2× the base rate; a dead engine cannot travel.
 *  - Wheels wear down with distance. Worn wheels risk a blowout on every
 *    trip (d20 flat check, DC scales with wear). A flat wheel caps travel
 *    speed hard; two or more flats immobilize the vehicle.
 *  - Effective speed = base speed × wheel × engine × chassis factors, so a
 *    beat-up vehicle travels slower and drinks more fuel per trip.
 */

import {
  MODULE_ID, FLAGS, VEHICLE_SYSTEMS, VEHICLE_COND_MAX, VEHICLE_DEFAULTS,
  VEHICLE_SEAT_ROLES, VEHICLE_MOUNT_KINDS, PHYSICAL_TYPES, loc, clamp
} from "./config.mjs";
import { logEvent } from "./timeline.mjs";

/* ============================================= */
/*  Storage                                      */
/* ============================================= */

/** Default vehicle object: everything factory-fresh. */
export function defaultVehicleData() {
  return {
    fuel: { value: VEHICLE_DEFAULTS.fuelMax, max: VEHICLE_DEFAULTS.fuelMax },
    consumption: VEHICLE_DEFAULTS.consumption,
    baseSpeed: VEHICLE_DEFAULTS.baseSpeed,
    wheels: Array(VEHICLE_DEFAULTS.wheelCount).fill(VEHICLE_COND_MAX),
    spares: VEHICLE_DEFAULTS.spares,
    engine: VEHICLE_COND_MAX,
    battery: VEHICLE_COND_MAX,
    chassis: VEHICLE_COND_MAX,
    odometer: 0,
    cargoMax: VEHICLE_DEFAULTS.cargoMax,
    seats: [{ id: "seat-driver", role: "driver", occupant: null }],
    mounts: []
  };
}

/** Read the vehicle object for an actor (merged over defaults). */
export function getVehicleData(actor) {
  const stored = actor.getFlag(MODULE_ID, FLAGS.VEHICLE) ?? {};
  const v = foundry.utils.mergeObject(defaultVehicleData(), stored, { inplace: false });
  // Sanitize after manual edits / older data
  v.wheels = (Array.isArray(v.wheels) && v.wheels.length ? v.wheels : defaultVehicleData().wheels)
    .map(w => clamp(Math.round(Number(w) || 0), 0, VEHICLE_COND_MAX));
  for (const s of VEHICLE_SYSTEMS) v[s.key] = clamp(Math.round(Number(v[s.key]) || 0), 0, VEHICLE_COND_MAX);
  v.fuel.max = Math.max(1, Number(v.fuel.max) || VEHICLE_DEFAULTS.fuelMax);
  v.fuel.value = clamp(Number(v.fuel.value) || 0, 0, v.fuel.max);
  v.consumption = Math.max(0.1, Number(v.consumption) || VEHICLE_DEFAULTS.consumption);
  v.baseSpeed = Math.max(1, Number(v.baseSpeed) || VEHICLE_DEFAULTS.baseSpeed);
  v.spares = Math.max(0, Math.round(Number(v.spares) || 0));
  v.odometer = Math.max(0, Number(v.odometer) || 0);
  v.cargoMax = Math.max(1, Number(v.cargoMax) || VEHICLE_DEFAULTS.cargoMax);
  v.seats = (Array.isArray(v.seats) ? v.seats : [])
    .filter(s => s && s.id)
    .map(s => ({
      id: s.id,
      role: VEHICLE_SEAT_ROLES.includes(s.role) ? s.role : "passenger",
      occupant: typeof s.occupant === "string" ? s.occupant : null
    }));
  v.mounts = (Array.isArray(v.mounts) ? v.mounts : [])
    .filter(m => m && m.id)
    .map(m => ({
      id: m.id,
      name: String(m.name ?? ""),
      kind: VEHICLE_MOUNT_KINDS.includes(m.kind) ? m.kind : "utility",
      ac: Number(m.ac) || 0,
      speed: Number(m.speed) || 0,
      weight: Math.max(0, Number(m.weight) || 0),
      attackBonus: Number(m.attackBonus) || 0,
      damage: String(m.damage ?? ""),
      notes: String(m.notes ?? "")
    }));
  return v;
}

/** Persist the full vehicle object. */
export function setVehicleData(actor, data) {
  return actor.setFlag(MODULE_ID, FLAGS.VEHICLE, data);
}

/* ============================================= */
/*  Derived mechanics                            */
/* ============================================= */

const ratio = value => clamp(value, 0, VEHICLE_COND_MAX) / VEHICLE_COND_MAX;

/**
 * Current cargo load: total Bulk of every physical item on the vehicle plus
 * the weight of installed mounts, measured against the configured capacity.
 * Returns { value, max, ratio, pct }.
 */
export function computeLoad(actor, v) {
  let value = 0;
  for (const item of actor.items) {
    if (!PHYSICAL_TYPES.includes(item.type)) continue;
    const per = Number(item.system?.bulk?.value) || 0;
    const qty = Number(item.system?.quantity ?? 1) || 1;
    value += per * qty;
  }
  value += v.mounts.reduce((a, m) => a + (Number(m.weight) || 0), 0);
  value = Math.round(value * 10) / 10;
  const loadRatio = v.cargoMax > 0 ? value / v.cargoMax : 0;
  return { value, max: v.cargoMax, ratio: loadRatio, pct: Math.round(loadRatio * 100) };
}

/**
 * Speed multiplier from cargo weight. A fully loaded vehicle runs at 75%;
 * past capacity it degrades fast and stalls completely at 150%.
 */
export function loadFactor(loadRatio) {
  if (loadRatio <= 1) return 1 - 0.25 * loadRatio;
  return Math.max(0, 0.75 - 1.5 * (loadRatio - 1));
}

/** Sum of the mounts' speed modifiers (percent, e.g. -10 for heavy plating). */
function mountSpeedPct(v) {
  return v.mounts.reduce((a, m) => a + (Number(m.speed) || 0), 0);
}

/**
 * Effective fuel burn in L/100 km — a worn engine burns up to 2×, and a
 * heavy load adds up to +30% at full capacity (more when overloaded).
 */
export function fuelRate(v, loadRatio = 0) {
  return v.consumption * (2 - ratio(v.engine)) * (1 + 0.3 * Math.min(Math.max(loadRatio, 0), 2));
}

/**
 * Travel profile derived from current wear, cargo weight and mounts.
 * Returns { factor, kmh, flats, immobile, blockers[], loadPenaltyPct, mountPct }.
 */
export function speedProfile(v, loadRatio = 0) {
  const flats = v.wheels.filter(w => w <= 0).length;
  const tireAvg = v.wheels.length
    ? v.wheels.reduce((a, b) => a + b, 0) / (v.wheels.length * VEHICLE_COND_MAX)
    : 1;
  let tire = 0.4 + 0.6 * tireAvg;
  if (flats === 1) tire = Math.min(tire, 0.35);
  if (flats >= 2) tire = 0;

  const engine = v.engine <= 0 ? 0 : 0.5 + 0.5 * ratio(v.engine);
  const chassis = 0.7 + 0.3 * ratio(v.chassis);
  const battery = v.battery <= 0 ? 0 : 1;
  const lf = loadFactor(loadRatio);
  const mf = clamp(1 + mountSpeedPct(v) / 100, 0, 2);
  const factor = tire * engine * chassis * battery * lf * mf;

  const blockers = [];
  if (v.engine <= 0) blockers.push("engine");
  if (v.battery <= 0) blockers.push("battery");
  if (flats >= 2) blockers.push("flats");
  if (lf <= 0) blockers.push("overload");

  return {
    factor,
    kmh: Math.round(v.baseSpeed * factor),
    flats,
    immobile: factor <= 0,
    blockers,
    loadPenaltyPct: Math.round((1 - lf) * 100),
    mountPct: mountSpeedPct(v)
  };
}

/** Remaining range in km at the current fuel level, engine wear and load. */
export function fuelRangeKm(v, loadRatio = 0) {
  return Math.floor((v.fuel.value / fuelRate(v, loadRatio)) * 100);
}

/** Blowout flat-check DC for a wheel's condition (0 = no check needed). */
export function blowoutDC(wheel) {
  if (wheel >= 7) return 0;
  if (wheel >= 4) return 3;
  if (wheel >= 2) return 7;
  return 11;
}

/**
 * Probabilistic integer wear for a distance: guaranteed floor(km/per) points
 * plus one more with probability equal to the leftover fraction.
 */
function wearFor(km, kmPerPoint) {
  const raw = km / kmPerPoint;
  return Math.floor(raw) + (Math.random() < raw % 1 ? 1 : 0);
}

const round1 = n => Math.round(n * 10) / 10;

/* ============================================= */
/*  Actions                                      */
/* ============================================= */

function postChat(actor, content) {
  return ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

function reportCard(title, icon, rows, events = []) {
  const rowHtml = rows
    .map(r => `<span class="hf-vr-cell"><i class="fas ${r.icon}"></i>${r.text}</span>`)
    .join("");
  const eventHtml = events.length
    ? `<ul class="hf-vr-events">${events.map(e =>
        `<li class="${e.bad ? "hf-vr-bad" : ""}"><i class="fas ${e.icon}"></i>${e.text}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="hf-vehicle-report">
      <header><i class="fas ${icon}"></i>${title}</header>
      <div class="hf-vr-grid">${rowHtml}</div>
      ${eventHtml}
    </div>`;
}

/**
 * Drive the vehicle a number of km, consuming fuel and applying wear.
 * Posts a travel report to chat and logs the trip on the vehicle's timeline.
 */
export async function travel(actor, km) {
  km = Math.max(0, Number(km) || 0);
  if (!km) return;
  const v = getVehicleData(actor);
  const load = computeLoad(actor, v);
  const before = speedProfile(v, load.ratio);

  if (before.immobile) {
    const reason = before.blockers.map(b => loc(`Vehicle.Blocker.${b}`)).join(", ");
    ui.notifications?.warn(loc("Vehicle.Warn.Immobile", { reason }));
    return;
  }
  if (v.fuel.value <= 0) {
    ui.notifications?.warn(loc("Vehicle.Warn.NoFuel"));
    return;
  }

  // ── Fuel: how far does the tank actually get us? ──
  const rate = fuelRate(v, load.ratio);
  const rangeKm = (v.fuel.value / rate) * 100;
  const actualKm = round1(Math.min(km, rangeKm));
  const ranDry = actualKm < km - 0.05;
  const fuelUsed = round1((actualKm / 100) * rate);

  const events = [];

  // ── Wheel wear + blowout checks ──
  v.wheels = v.wheels.map(w => (w > 0 ? Math.max(0, w - wearFor(actualKm, 150)) : w));
  for (let i = 0; i < v.wheels.length; i++) {
    const w = v.wheels[i];
    if (w <= 0) {
      continue;
    }
    const dc = blowoutDC(w);
    if (!dc) continue;
    const roll = await new Roll("1d20").evaluate();
    if (roll.total <= dc) {
      v.wheels[i] = 0;
      events.push({
        icon: "fa-car-burst", bad: true,
        text: loc("Vehicle.Chat.Blowout", { n: i + 1, roll: roll.total, dc })
      });
      logEvent(actor, "blowout", loc("Vehicle.Log.Blowout", { n: i + 1 }));
    }
  }

  // ── Engine wear (slow, but a hard-run engine eventually gives out) ──
  if (v.engine > 0) {
    const engWear = wearFor(actualKm, 300);
    if (engWear) {
      v.engine = Math.max(0, v.engine - engWear);
      events.push({
        icon: "fa-oil-can", bad: v.engine <= 3,
        text: loc("Vehicle.Chat.EngineWear", { value: v.engine, max: VEHICLE_COND_MAX })
      });
      if (v.engine <= 0) logEvent(actor, "breakdown", loc("Vehicle.Log.EngineDead"));
    }
  }

  v.fuel.value = round1(Math.max(0, v.fuel.value - fuelUsed));
  v.odometer = round1(v.odometer + actualKm);

  const after = speedProfile(v, load.ratio);
  const avgKmh = Math.max(1, (before.kmh + Math.max(after.kmh, 1)) / 2);
  const hours = round1(actualKm / avgKmh);

  if (ranDry) events.push({ icon: "fa-gas-pump", bad: true, text: loc("Vehicle.Chat.RanDry", { km: actualKm }) });
  if (after.immobile) events.push({ icon: "fa-triangle-exclamation", bad: true, text: loc("Vehicle.Chat.Immobilized") });

  await setVehicleData(actor, v);

  await postChat(actor, reportCard(
    loc("Vehicle.Chat.TravelTitle", { name: actor.name }), "fa-route",
    [
      { icon: "fa-road", text: `${actualKm} km` },
      { icon: "fa-gas-pump", text: loc("Vehicle.Chat.FuelUsed", { used: fuelUsed, left: v.fuel.value }) },
      { icon: "fa-gauge-high", text: `${after.kmh} km/h` },
      { icon: "fa-clock", text: loc("Vehicle.Chat.Duration", { hours }) }
    ],
    events
  ));
  logEvent(actor, "travel", loc("Vehicle.Log.Travel", { km: actualKm, fuel: fuelUsed }));
  return { actualKm, fuelUsed, ranDry, events };
}

/** Add fuel to the tank (clamped to capacity). */
export async function refuel(actor, liters) {
  liters = Number(liters) || 0;
  if (liters <= 0) return;
  const v = getVehicleData(actor);
  const added = round1(Math.min(liters, v.fuel.max - v.fuel.value));
  if (added <= 0) {
    ui.notifications?.info(loc("Vehicle.Warn.TankFull"));
    return;
  }
  v.fuel.value = round1(v.fuel.value + added);
  await setVehicleData(actor, v);
  await postChat(actor, reportCard(
    loc("Vehicle.Chat.RefuelTitle", { name: actor.name }), "fa-gas-pump",
    [{ icon: "fa-gas-pump", text: loc("Vehicle.Chat.Refueled", { added, value: v.fuel.value, max: v.fuel.max }) }]
  ));
  logEvent(actor, "fuel", loc("Vehicle.Log.Refueled", { added }));
}

/** Swap a wheel for a spare (spare goes on at full condition). */
export async function changeWheel(actor, index) {
  const v = getVehicleData(actor);
  if (v.wheels[index] === undefined) return;
  if (v.spares <= 0) {
    ui.notifications?.warn(loc("Vehicle.Warn.NoSpares"));
    return;
  }
  if (v.wheels[index] >= VEHICLE_COND_MAX) return;
  v.spares -= 1;
  v.wheels[index] = VEHICLE_COND_MAX;
  await setVehicleData(actor, v);
  await postChat(actor, reportCard(
    loc("Vehicle.Chat.WheelChangedTitle", { name: actor.name }), "fa-screwdriver-wrench",
    [{ icon: "fa-circle-dot", text: loc("Vehicle.Chat.WheelChanged", { n: index + 1, spares: v.spares }) }]
  ));
  logEvent(actor, "repair", loc("Vehicle.Log.WheelChanged", { n: index + 1 }));
}
