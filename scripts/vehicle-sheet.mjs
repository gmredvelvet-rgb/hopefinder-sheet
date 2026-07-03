/**
 * Hopefinder Vehicle Sheet — ActorSheet for PF2e "vehicle" actors.
 * Same HUD language as the survivor sheet, but the vital signs are the
 * machine's: wheels, fuel, engine, battery and chassis. All wear data lives
 * in flags (vehicle.mjs); PF2e's own vehicle attributes (HP, AC, hardness)
 * are read straight from the system.
 */

import {
  MODULE_ID, FLAGS, VEHICLE_TABS, VEHICLE_SYSTEMS, VEHICLE_COND_MAX,
  VEHICLE_SEAT_ROLES, VEHICLE_MOUNT_KINDS, VEHICLE_MOUNT_ICONS, loc, clamp
} from "./config.mjs";
import { HopefinderSheet } from "./sheet.mjs";
import { severityOf } from "./vitals.mjs";
import { prepareTimeline } from "./timeline.mjs";
import {
  getVehicleData, setVehicleData, speedProfile, fuelRate, fuelRangeKm,
  computeLoad, blowoutDC, travel, refuel, changeWheel
} from "./vehicle.mjs";
import * as FX from "./fx.mjs";

const ActorSheetV1 = foundry.appv1?.sheets?.ActorSheet ?? window.ActorSheet;
const WHEEL_DEF = { kind: "good", max: VEHICLE_COND_MAX };

export class HopefinderVehicleSheet extends HopefinderSheet {

  static SHEET_TABS = VEHICLE_TABS;

  _activeTab = "status";

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["pf2e", "actor", "hopefinder-sheet", "hf-vehicle-sheet"],
      template: `modules/${MODULE_ID}/templates/vehicle-sheet.hbs`,
      width: 1040,
      height: 760
    });
  }

  /* ============================================= */
  /*  DATA PREPARATION                             */
  /* ============================================= */

  /** @override */
  async getData(options) {
    const context = await ActorSheetV1.prototype.getData.call(this, options);
    const actor = this.actor;
    const system = actor.system;

    context.editable = this.isEditable;
    context.owner = actor.isOwner;
    context.actorId = actor.id;

    const v = getVehicleData(actor);
    const load = computeLoad(actor, v);
    const profile = speedProfile(v, load.ratio);

    context.state = this._prepareState(actor, v, profile);
    context.tabs = this.constructor.SHEET_TABS.map(t => ({
      id: t.id,
      icon: t.icon,
      label: loc(`VehicleTabs.${t.id}`),
      active: t.id === this._activeTab
    }));

    context.header = this._prepareVehicleHeader(actor, system);
    context.structure = this._prepareStructure(system, v);
    context.vehicle = this._prepareVehicle(v, profile, load);
    context.crew = this._prepareCrew(v);
    context.cargo = this._prepareInventory(actor).gear;
    context.timeline = prepareTimeline(actor);

    const backdrop = actor.getFlag(MODULE_ID, FLAGS.BACKDROP) ?? {};
    context.backdrop = {
      img: backdrop.img ?? "",
      isVideo: /\.(webm|mp4)$/i.test(backdrop.img ?? ""),
      opacity: backdrop.opacity ?? 85
    };

    return context;
  }

  /* -------------------------------------------- */

  /** Global lamp/theme state — the vehicle's "am I dying" readout. */
  _prepareState(actor, v, profile) {
    const hp = actor.system.attributes?.hp ?? {};
    const worstSystem = Math.min(v.engine, v.battery, v.chassis, ...v.wheels) / VEHICLE_COND_MAX;
    const hpRatio = hp.max > 0 ? hp.value / hp.max : 1;
    const worst = Math.min(worstSystem, hpRatio);

    let id = "stable";
    let key = "operational";
    if (profile.immobile || (hp.max > 0 && hp.value <= 0)) { id = "down"; key = "immobile"; }
    else if (worst <= 0.3) { id = "critical"; key = "critical"; }
    else if (worst <= 0.6) { id = "wounded"; key = "damaged"; }

    return { id, label: loc(`Vehicle.State.${key}`), classes: `hf-state-${id}` };
  }

  _prepareVehicleHeader(actor, system) {
    const details = system.details ?? {};
    return {
      name: actor.name,
      img: actor.img,
      portraitIsVideo: /\.(webm|mp4|ogg)$/i.test(actor.img ?? ""),
      level: details.level?.value ?? 0,
      crew: details.crew ?? "",
      passengers: details.passengers ?? "",
      pilotingCheck: details.pilotingCheck ?? "",
      speedFeet: details.speed ?? null
    };
  }

  _prepareStructure(system, v) {
    const attrs = system.attributes ?? {};
    const hp = attrs.hp ?? {};
    const hpPct = hp.max > 0 ? clamp(Math.round((hp.value / hp.max) * 100), 0, 100) : 0;
    // Hardness is a plain number in current PF2e, an object in some builds
    const hardnessIsObject = typeof attrs.hardness === "object" && attrs.hardness !== null;
    const acBonus = v.mounts.reduce((a, m) => a + (Number(m.ac) || 0), 0);
    return {
      acBonus,
      hp: {
        value: hp.value ?? 0,
        max: hp.max ?? 0,
        pct: hpPct,
        low: hpPct <= 25,
        brokenThreshold: hp.brokenThreshold ?? null
      },
      ac: attrs.ac?.value ?? 0,
      hardness: hardnessIsObject ? (attrs.hardness.value ?? 0) : (attrs.hardness ?? 0),
      hardnessPath: hardnessIsObject ? "system.attributes.hardness.value" : "system.attributes.hardness",
      collisionDC: attrs.collisionDC?.value ?? null
    };
  }

  /** Render-ready wear & travel context. */
  _prepareVehicle(v, profile, load) {
    const meter = (value, defOverride) => ({
      value,
      max: VEHICLE_COND_MAX,
      pct: Math.round((value / VEHICLE_COND_MAX) * 100),
      severity: severityOf(defOverride ?? WHEEL_DEF, value),
      segments: Array.from({ length: VEHICLE_COND_MAX }, (_, i) => ({ index: i, filled: i < value }))
    });

    const wheels = v.wheels.map((w, i) => ({
      ...meter(w),
      index: i,
      label: loc("Vehicle.Wheel", { n: i + 1 }),
      stateLabel: this._wheelStateLabel(w),
      flat: w <= 0,
      atRisk: w > 0 && blowoutDC(w) > 0,
      canChange: w < VEHICLE_COND_MAX
    }));

    const systems = VEHICLE_SYSTEMS.map(def => ({
      ...meter(v[def.key]),
      key: def.key,
      icon: def.icon,
      label: loc(`Vehicle.System.${def.key}`),
      hint: loc(`Vehicle.SystemHint.${def.key}`),
      statusLabel: loc(`Severity.${severityOf(WHEEL_DEF, v[def.key])}`)
    }));

    const rate = Math.round(fuelRate(v, load.ratio) * 10) / 10;
    const fuelPct = clamp(Math.round((v.fuel.value / v.fuel.max) * 100), 0, 100);

    return {
      wheels,
      systems,
      spares: v.spares,
      odometer: v.odometer,
      baseSpeed: v.baseSpeed,
      fuel: {
        value: v.fuel.value,
        max: v.fuel.max,
        pct: fuelPct,
        low: fuelPct <= 20,
        base: v.consumption,
        rate,
        strained: rate > v.consumption + 0.05,
        range: fuelRangeKm(v, load.ratio)
      },
      load: {
        value: load.value,
        max: load.max,
        pct: load.pct,
        barPct: clamp(load.pct, 0, 100),
        over: load.ratio > 1,
        penaltyPct: profile.loadPenaltyPct
      },
      profile: {
        kmh: profile.kmh,
        pct: Math.round(profile.factor * 100),
        immobile: profile.immobile,
        flats: profile.flats,
        mountPct: profile.mountPct,
        blockers: profile.blockers.map(b => loc(`Vehicle.Blocker.${b}`))
      }
    };
  }

  /* -------------------------------------------- */

  /** Seats (with resolved occupants) and mounts, render-ready. */
  _prepareCrew(v) {
    const seats = v.seats.map(s => {
      let occ = null;
      if (s.occupant) {
        try { occ = fromUuidSync(s.occupant); } catch { occ = null; }
      }
      return {
        id: s.id,
        role: s.role,
        roleLabel: loc(`Vehicle.Role.${s.role}`),
        roleIcon: { driver: "fa-truck-fast", gunner: "fa-person-rifle", passenger: "fa-user" }[s.role] ?? "fa-user",
        roleOptions: VEHICLE_SEAT_ROLES.map(r => ({
          id: r, label: loc(`Vehicle.Role.${r}`), selected: r === s.role
        })),
        occupied: !!occ,
        name: occ?.name ?? "",
        img: occ?.img ?? ""
      };
    });

    const mounts = v.mounts.map(m => ({
      id: m.id,
      name: m.name || loc("Vehicle.Mount.Unnamed"),
      kind: m.kind,
      kindLabel: loc(`Vehicle.MountKind.${m.kind}`),
      icon: VEHICLE_MOUNT_ICONS[m.kind] ?? "fa-toolbox",
      isWeapon: m.kind === "weapon",
      ac: m.ac,
      speed: m.speed,
      weight: m.weight,
      attackBonus: m.attackBonus,
      attackBonusStr: (m.attackBonus >= 0 ? "+" : "") + m.attackBonus,
      damage: m.damage,
      notes: m.notes
    }));

    return { seats, mounts };
  }

  _wheelStateLabel(w) {
    if (w <= 0) return loc("Vehicle.WheelState.flat");
    if (w <= 1) return loc("Vehicle.WheelState.critical");
    if (w <= 3) return loc("Vehicle.WheelState.risky");
    if (w <= 6) return loc("Vehicle.WheelState.worn");
    return loc("Vehicle.WheelState.good");
  }

  /* ============================================= */
  /*  ACTIONS                                      */
  /* ============================================= */

  /** @override — vehicle actions first, everything else falls through. */
  async _onAction(action, el, ev, alt) {
    const actor = this.actor;

    switch (action) {
      case "vehicle-travel": {
        if (!this.isEditable) return;
        const input = el.closest(".hf-console")?.querySelector("[data-ref='travel-km']");
        const km = Number(input?.value) || 0;
        if (km <= 0) return;
        FX.rollPulse(el); FX.sfxThunk();
        await travel(actor, km);
        if (input) input.value = "";
        return;
      }
      case "travel-preset": {
        const input = el.closest(".hf-console")?.querySelector("[data-ref='travel-km']");
        if (input) input.value = el.dataset.km;
        FX.press(el); FX.sfxTick();
        return;
      }
      case "vehicle-refuel": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        return this._openRefuelDialog();
      }
      case "vehicle-config": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        return this._openVehicleConfig();
      }
      case "wheel-change": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxThunk();
        return changeWheel(actor, Number(el.dataset.index));
      }
      case "wheel-step": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const v = getVehicleData(actor);
        const i = Number(el.dataset.index);
        if (v.wheels[i] === undefined) return;
        v.wheels[i] = clamp(v.wheels[i] + (Number(el.dataset.delta) || 0), 0, VEHICLE_COND_MAX);
        return setVehicleData(actor, v);
      }
      case "wheel-seg": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const v = getVehicleData(actor);
        const i = Number(el.dataset.index);
        const seg = Number(el.dataset.seg);
        if (v.wheels[i] === undefined) return;
        v.wheels[i] = clamp(seg + 1 === v.wheels[i] ? seg : seg + 1, 0, VEHICLE_COND_MAX);
        return setVehicleData(actor, v);
      }
      case "system-step": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const v = getVehicleData(actor);
        const key = el.dataset.system;
        if (!VEHICLE_SYSTEMS.some(s => s.key === key)) return;
        v[key] = clamp(v[key] + (Number(el.dataset.delta) || 0), 0, VEHICLE_COND_MAX);
        return setVehicleData(actor, v);
      }
      case "system-seg": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const v = getVehicleData(actor);
        const key = el.dataset.system;
        const seg = Number(el.dataset.seg);
        if (!VEHICLE_SYSTEMS.some(s => s.key === key)) return;
        v[key] = clamp(seg + 1 === v[key] ? seg : seg + 1, 0, VEHICLE_COND_MAX);
        return setVehicleData(actor, v);
      }
      case "spare-step": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const v = getVehicleData(actor);
        v.spares = Math.max(0, v.spares + (Number(el.dataset.delta) || 0));
        return setVehicleData(actor, v);
      }
      case "fuel-step": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const v = getVehicleData(actor);
        v.fuel.value = clamp(Math.round((v.fuel.value + (Number(el.dataset.delta) || 0)) * 10) / 10, 0, v.fuel.max);
        return setVehicleData(actor, v);
      }

      /* ── Seats ── */
      case "seat-add": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const v = getVehicleData(actor);
        v.seats.push({ id: foundry.utils.randomID(), role: "passenger", occupant: null });
        return setVehicleData(actor, v);
      }
      case "seat-remove": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const v = getVehicleData(actor);
        v.seats = v.seats.filter(s => s.id !== el.closest("[data-seat-id]")?.dataset.seatId);
        return setVehicleData(actor, v);
      }
      case "seat-eject": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const v = getVehicleData(actor);
        const seat = v.seats.find(s => s.id === el.closest("[data-seat-id]")?.dataset.seatId);
        if (!seat) return;
        seat.occupant = null;
        return setVehicleData(actor, v);
      }
      case "seat-open": {
        const v = getVehicleData(actor);
        const seat = v.seats.find(s => s.id === el.closest("[data-seat-id]")?.dataset.seatId);
        if (!seat?.occupant) return;
        let occ = null;
        try { occ = fromUuidSync(seat.occupant); } catch { occ = null; }
        return occ?.sheet?.render(true);
      }

      /* ── Mounts (attachments) ── */
      case "mount-add": {
        if (!this.isEditable) return;
        FX.sfxTick();
        return this._openMountConfig(null);
      }
      case "mount-edit": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const v = getVehicleData(actor);
        const mount = v.mounts.find(m => m.id === el.closest("[data-mount-id]")?.dataset.mountId);
        return mount ? this._openMountConfig(mount) : undefined;
      }
      case "mount-remove": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const v = getVehicleData(actor);
        v.mounts = v.mounts.filter(m => m.id !== el.closest("[data-mount-id]")?.dataset.mountId);
        return setVehicleData(actor, v);
      }
      case "mount-attack": {
        FX.rollPulse(el); FX.sfxThunk();
        const v = getVehicleData(actor);
        const mount = v.mounts.find(m => m.id === el.closest("[data-mount-id]")?.dataset.mountId);
        if (!mount) return;
        const roll = await new Roll(`1d20 + ${Number(mount.attackBonus) || 0}`).evaluate();
        return roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `<b>${foundry.utils.escapeHTML(mount.name || loc("Vehicle.Mount.Unnamed"))}</b> — ${loc("Vehicle.Mount.Attack")}`
        });
      }
      case "mount-damage": {
        FX.rollPulse(el); FX.sfxTick();
        const v = getVehicleData(actor);
        const mount = v.mounts.find(m => m.id === el.closest("[data-mount-id]")?.dataset.mountId);
        if (!mount?.damage) return;
        let roll;
        try {
          roll = await new Roll(mount.damage).evaluate();
        } catch {
          ui.notifications?.warn(loc("Vehicle.Warn.InvalidDamage", { formula: mount.damage }));
          return;
        }
        return roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `<b>${foundry.utils.escapeHTML(mount.name || loc("Vehicle.Mount.Unnamed"))}</b> — ${loc("Vehicle.Mount.Damage")}`
        });
      }
    }

    return super._onAction(action, el, ev, alt);
  }

  /* -------------------------------------------- */

  /** Drop an Actor from the sidebar onto a seat to assign it. */
  async _onDrop(event) {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    const data = TE.getDragEventData(event);
    const seatEl = event.target?.closest?.("[data-seat-id]");
    if (data?.type === "Actor" && seatEl && this.isEditable && data.uuid) {
      const v = getVehicleData(this.actor);
      const seat = v.seats.find(s => s.id === seatEl.dataset.seatId);
      if (!seat) return;
      seat.occupant = data.uuid;
      FX.sfxThunk();
      return setVehicleData(this.actor, v);
    }
    return super._onDrop(event);
  }

  /** @override */
  async _onInputChange(change, el, ev) {
    if (change === "fuel-input") {
      const v = getVehicleData(this.actor);
      const value = Number(el.value);
      if (!Number.isFinite(value)) { el.value = v.fuel.value; return; }
      v.fuel.value = clamp(Math.round(value * 10) / 10, 0, v.fuel.max);
      return setVehicleData(this.actor, v);
    }
    if (change === "seat-role") {
      const v = getVehicleData(this.actor);
      const seat = v.seats.find(s => s.id === el.closest("[data-seat-id]")?.dataset.seatId);
      if (!seat || !VEHICLE_SEAT_ROLES.includes(el.value)) return;
      seat.role = el.value;
      return setVehicleData(this.actor, v);
    }
    return super._onInputChange(change, el, ev);
  }

  /* ============================================= */
  /*  DIALOGS                                      */
  /* ============================================= */

  async _openRefuelDialog() {
    const actor = this.actor;
    const v = getVehicleData(actor);
    const missing = Math.round((v.fuel.max - v.fuel.value) * 10) / 10;
    const content = `
      <form class="hf-refuel-form">
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.RefuelAmount", { missing })}</label>
          <input type="number" name="liters" min="0" step="0.5" value="${missing}">
        </div>
      </form>`;
    const apply = form => refuel(actor, Number(new FormData(form).get("liters")) || 0);

    const D2 = foundry.applications?.api?.DialogV2;
    if (D2?.wait) {
      return D2.wait({
        window: { title: `${loc("Vehicle.Dialog.RefuelTitle")} — ${actor.name}` },
        content,
        buttons: [{
          action: "save", label: loc("Vehicle.Dialog.Refuel"), icon: "fas fa-gas-pump", default: true,
          callback: (event, button) => apply(button.form ?? event.currentTarget.closest("dialog").querySelector("form"))
        }]
      });
    }
    return new Dialog({
      title: `${loc("Vehicle.Dialog.RefuelTitle")} — ${actor.name}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-gas-pump"></i>', label: loc("Vehicle.Dialog.Refuel"),
          callback: html => apply((html[0] ?? html).querySelector("form"))
        }
      },
      default: "save"
    }).render(true);
  }

  /* -------------------------------------------- */

  async _openVehicleConfig() {
    const actor = this.actor;
    const v = getVehicleData(actor);
    const details = actor.system.details ?? {};
    const field = (name, label, value, opts = "", type = "number") => `
      <div class="form-group">
        <label>${label}</label>
        <input type="${type}" name="${name}" value="${foundry.utils.escapeHTML(String(value))}" ${opts}>
      </div>`;
    const content = `
      <form class="hf-vehicle-config-form">
        ${field("fuelMax", loc("Vehicle.Dialog.FuelMax"), v.fuel.max, 'min="1" step="1"')}
        ${field("consumption", loc("Vehicle.Dialog.Consumption"), v.consumption, 'min="0.5" step="0.5"')}
        ${field("baseSpeed", loc("Vehicle.Dialog.BaseSpeed"), v.baseSpeed, 'min="1" step="1"')}
        ${field("wheelCount", loc("Vehicle.Dialog.WheelCount"), v.wheels.length, 'min="1" max="12" step="1"')}
        ${field("spares", loc("Vehicle.Dialog.Spares"), v.spares, 'min="0" step="1"')}
        ${field("cargoMax", loc("Vehicle.Dialog.CargoMax"), v.cargoMax, 'min="1" step="1"')}
        <hr>
        ${field("level", loc("Vehicle.Dialog.Level"), details.level?.value ?? 0, 'min="0" max="30" step="1"')}
        ${field("crew", loc("Vehicle.Crew"), details.crew ?? "", "", "text")}
        ${field("passengers", loc("Vehicle.Passengers"), details.passengers ?? "", "", "text")}
      </form>`;

    const apply = async form => {
      const data = new FormData(form);
      const next = getVehicleData(actor);
      next.fuel.max = Math.max(1, Number(data.get("fuelMax")) || next.fuel.max);
      next.fuel.value = Math.min(next.fuel.value, next.fuel.max);
      next.consumption = Math.max(0.1, Number(data.get("consumption")) || next.consumption);
      next.baseSpeed = Math.max(1, Number(data.get("baseSpeed")) || next.baseSpeed);
      next.spares = Math.max(0, Math.round(Number(data.get("spares")) || 0));
      next.cargoMax = Math.max(1, Number(data.get("cargoMax")) || next.cargoMax);
      const count = clamp(Math.round(Number(data.get("wheelCount")) || next.wheels.length), 1, 12);
      if (count !== next.wheels.length) {
        next.wheels = Array.from({ length: count }, (_, i) => next.wheels[i] ?? VEHICLE_COND_MAX);
      }
      await actor.update({
        "system.details.level.value": Math.max(0, Math.round(Number(data.get("level")) || 0)),
        "system.details.crew": String(data.get("crew") ?? "").trim(),
        "system.details.passengers": String(data.get("passengers") ?? "").trim()
      });
      return setVehicleData(actor, next);
    };

    const D2 = foundry.applications?.api?.DialogV2;
    if (D2?.wait) {
      return D2.wait({
        window: { title: `${loc("Vehicle.Dialog.ConfigTitle")} — ${actor.name}` },
        content,
        buttons: [{
          action: "save", label: loc("Backdrop.Save"), icon: "fas fa-check", default: true,
          callback: (event, button) => apply(button.form ?? event.currentTarget.closest("dialog").querySelector("form"))
        }]
      });
    }
    return new Dialog({
      title: `${loc("Vehicle.Dialog.ConfigTitle")} — ${actor.name}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-check"></i>', label: loc("Backdrop.Save"),
          callback: html => apply((html[0] ?? html).querySelector("form"))
        }
      },
      default: "save"
    }).render(true);
  }

  /* -------------------------------------------- */

  /** Create or edit a mount (attachment): weapon, armor plating or utility. */
  async _openMountConfig(mount) {
    const actor = this.actor;
    const m = mount ?? {
      id: null, name: "", kind: "weapon", ac: 0, speed: 0, weight: 0,
      attackBonus: 0, damage: "", notes: ""
    };
    const esc = foundry.utils.escapeHTML;
    const kindOptions = VEHICLE_MOUNT_KINDS.map(k =>
      `<option value="${k}" ${k === m.kind ? "selected" : ""}>${loc(`Vehicle.MountKind.${k}`)}</option>`
    ).join("");
    const content = `
      <form class="hf-mount-form">
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountName")}</label>
          <input type="text" name="name" value="${esc(m.name)}" placeholder="${loc("Vehicle.Dialog.MountNamePh")}">
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountKind")}</label>
          <select name="kind">${kindOptions}</select>
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountAC")}</label>
          <input type="number" name="ac" value="${m.ac}" step="1">
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountSpeed")}</label>
          <input type="number" name="speed" value="${m.speed}" step="5" min="-90" max="50">
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountWeight")}</label>
          <input type="number" name="weight" value="${m.weight}" step="0.5" min="0">
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountAttack")}</label>
          <input type="number" name="attackBonus" value="${m.attackBonus}" step="1">
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountDamage")}</label>
          <input type="text" name="damage" value="${esc(m.damage)}" placeholder="3d6">
        </div>
        <div class="form-group">
          <label>${loc("Vehicle.Dialog.MountNotes")}</label>
          <input type="text" name="notes" value="${esc(m.notes)}">
        </div>
      </form>`;

    const apply = form => {
      const data = new FormData(form);
      const v = getVehicleData(actor);
      const next = {
        id: m.id ?? foundry.utils.randomID(),
        name: String(data.get("name") ?? "").trim(),
        kind: VEHICLE_MOUNT_KINDS.includes(data.get("kind")) ? data.get("kind") : "utility",
        ac: Number(data.get("ac")) || 0,
        speed: clamp(Number(data.get("speed")) || 0, -90, 50),
        weight: Math.max(0, Number(data.get("weight")) || 0),
        attackBonus: Number(data.get("attackBonus")) || 0,
        damage: String(data.get("damage") ?? "").trim(),
        notes: String(data.get("notes") ?? "").trim()
      };
      const idx = v.mounts.findIndex(x => x.id === next.id);
      if (idx >= 0) v.mounts[idx] = next;
      else v.mounts.push(next);
      return setVehicleData(actor, v);
    };

    const title = `${loc("Vehicle.Dialog.MountTitle")} — ${actor.name}`;
    const D2 = foundry.applications?.api?.DialogV2;
    if (D2?.wait) {
      return D2.wait({
        window: { title },
        content,
        buttons: [{
          action: "save", label: loc("Backdrop.Save"), icon: "fas fa-check", default: true,
          callback: (event, button) => apply(button.form ?? event.currentTarget.closest("dialog").querySelector("form"))
        }]
      });
    }
    return new Dialog({
      title,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-check"></i>', label: loc("Backdrop.Save"),
          callback: html => apply((html[0] ?? html).querySelector("form"))
        }
      },
      default: "save"
    }).render(true);
  }
}
