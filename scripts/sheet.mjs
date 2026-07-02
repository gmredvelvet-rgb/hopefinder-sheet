/**
 * Hopefinder Survivor Sheet — ActorSheet implementation.
 *
 * A tactical, cinematic character sheet for Hopefinder (PF2e chassis).
 * Architecture:
 *  - getData() builds a fully render-ready context (templates hold no logic)
 *  - a single delegated [data-action] dispatcher handles all interaction
 *  - PF2e mechanics are always invoked through the system's own API
 *    (statistics, strikes, conditions, carry types) so nothing breaks
 *  - survival mechanics (vitals, factions, timeline) live in flag-backed
 *    data layers (vitals.mjs / timeline.mjs)
 */

import {
  MODULE_ID, FLAGS, TABS, VITAL_GROUPS, PHYSICAL_TYPES, GEAR_FILTERS,
  MEDICAL_CATEGORIES, MEDICAL_KEYWORDS, PROVISION_KEYWORDS, QUICK_CONDITIONS,
  RANKS, STANDING_MIN, STANDING_MAX, THREAT_MAX, loc, signed, clamp
} from "./config.mjs";
import { prepareVitals, stepVital, setVital, deriveSheetState } from "./vitals.mjs";
import { prepareTimeline, logEvent, removeEvent, clearTimeline } from "./timeline.mjs";
import * as FX from "./fx.mjs";
import { attachTooltips, hideTooltip } from "./tooltip.mjs";
import { GearIntegrityManager } from "./gear-integrity.mjs";
import { hasActionFx } from "./action-fx.mjs";
import { WeaponFxConfig } from "./action-fx-config.mjs";
import { HopefinderLicenseClient, HopefinderLicenseUI } from "./license-client.mjs";

const ActorSheetV1 = foundry.appv1?.sheets?.ActorSheet ?? window.ActorSheet;

/** Version-safe access to core helper apps. */
function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
}
async function confirmDialog(title, content) {
  const D2 = foundry.applications?.api?.DialogV2;
  if (D2?.confirm) {
    return D2.confirm({ window: { title }, content, rejectClose: false, modal: true });
  }
  return Dialog.confirm({ title, content });
}
async function enrich(html, actor) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
  return TE.enrichHTML(html ?? "", { async: true, secrets: actor.isOwner, relativeTo: actor });
}

export class HopefinderSheet extends ActorSheetV1 {

  /** Client-side view state (survives re-renders, not reloads). */
  _activeTab = "survivor";
  _journalTab = "notes";
  _gearFilter = "all";
  _gearSearch = "";
  _entered = false;
  _prevHP = undefined;

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["pf2e", "actor", "hopefinder-sheet"],
      template: `modules/${MODULE_ID}/templates/sheet.hbs`,
      width: 1180,
      height: 820,
      resizable: true,
      tabs: [],
      scrollY: [".hf-tab", ".hf-rail"],
      dragDrop: [{ dragSelector: "[data-item-id]", dropSelector: null }]
    });
  }

  /* ============================================= */
  /*  DATA PREPARATION                             */
  /* ============================================= */

  /** @override */
  async getData(options) {
    const context = await super.getData(options);
    const actor = this.actor;
    const system = actor.system;

    context.editable = this.isEditable;
    context.owner = actor.isOwner;
    context.actorId = actor.id;

    context.state = deriveSheetState(actor);
    context.tabs = TABS.map(t => ({
      id: t.id,
      icon: t.icon,
      label: loc(`Tabs.${t.id}`),
      active: t.id === this._activeTab
    }));

    context.header = this._prepareHeader(actor, system);
    context.combat = this._prepareCombat(actor, system);
    context.abilities = this._prepareAbilities(system);
    context.conditions = this._prepareConditions(actor);
    context.quickConditions = QUICK_CONDITIONS.map(slug => {
      const c = game.pf2e?.ConditionManager?.getCondition?.(slug);
      return { slug, name: c?.name ?? slug };
    });
    context.effects = this._prepareEffects(actor);

    context.vitalGroups = this._prepareVitalGroups(actor);

    const inventory = this._prepareInventory(actor);
    context.gear = inventory.gear;
    context.loadout = inventory.loadout;
    context.medical = inventory.medical;

    context.strikes = this._prepareStrikes(actor);
    context.skills = this._prepareSkills(actor);
    context.journal = await this._prepareJournal(actor, system);
    context.factions = this._prepareFactions(actor);
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

  _prepareHeader(actor, system) {
    const xp = system.details?.xp ?? { value: 0, max: 1000 };
    const hero = system.resources?.heroPoints ?? { value: 0, max: 3 };
    const heroMax = hero.max || 3;
    const threat = clamp(actor.getFlag(MODULE_ID, FLAGS.THREAT) ?? 0, 0, THREAT_MAX);

    return {
      name: actor.name,
      img: actor.img,
      portraitIsVideo: /\.(webm|mp4|ogg)$/i.test(actor.img ?? ""),
      callsign: actor.getFlag(MODULE_ID, FLAGS.CALLSIGN) ?? "",
      archetype: actor.getFlag(MODULE_ID, FLAGS.ARCHETYPE) ?? "",
      level: system.details?.level?.value ?? 1,
      className: actor.class?.name ?? "",
      backgroundName: actor.background?.name ?? "",
      ancestryName: actor.ancestry?.name ?? "",
      heritageName: actor.heritage?.name ?? "",
      xp: {
        value: xp.value ?? 0,
        max: xp.max || 1000,
        pct: clamp(Math.round(((xp.value ?? 0) / (xp.max || 1000)) * 100), 0, 100)
      },
      hope: {
        value: hero.value ?? 0,
        max: heroMax,
        pips: Array.from({ length: heroMax }, (_, i) => ({ index: i + 1, filled: i < (hero.value ?? 0) }))
      },
      threat: {
        value: threat,
        max: THREAT_MAX,
        pips: Array.from({ length: THREAT_MAX }, (_, i) => ({ index: i + 1, filled: i < threat }))
      }
    };
  }

  /* -------------------------------------------- */

  _prepareCombat(actor, system) {
    const attrs = system.attributes ?? {};
    const hp = attrs.hp ?? {};
    const hpPct = hp.max > 0 ? clamp(Math.round((hp.value / hp.max) * 100), 0, 100) : 0;

    const dying = attrs.dying ?? {};
    const wounded = attrs.wounded ?? {};
    const perception = actor.perception ?? system.perception ?? {};
    const heldShield = actor.heldShield;

    const saves = ["fortitude", "reflex", "will"].map(key => {
      const stat = actor.saves?.[key];
      const mod = stat?.mod ?? system.saves?.[key]?.value ?? 0;
      const rank = stat?.rank ?? 0;
      return {
        key,
        label: loc(`Saves.${key}`),
        mod,
        modStr: signed(mod),
        rank,
        rankLabel: loc(`Rank.${RANKS[rank] ?? "untrained"}`)
      };
    });

    return {
      hp: {
        value: hp.value ?? 0,
        max: hp.max ?? 0,
        temp: hp.temp ?? 0,
        pct: hpPct,
        low: hpPct <= 25,
        sp: hp.sp ?? null
      },
      bruises: GearIntegrityManager.getBruises(actor),
      ac: attrs.ac?.value ?? "—",
      shield: heldShield ? {
        id: heldShield.id,
        name: heldShield.name,
        img: heldShield.img,
        ac: heldShield.system.acBonus ?? 0,
        hp: heldShield.system.hp?.value ?? 0,
        maxHp: heldShield.system.hp?.max ?? 0,
        raised: attrs.shield?.raised ?? false,
        broken: heldShield.isBroken ?? false
      } : null,
      saves,
      perception: {
        mod: perception.mod ?? 0,
        modStr: signed(perception.mod ?? 0),
        rank: perception.rank ?? 0,
        rankLabel: loc(`Rank.${RANKS[perception.rank ?? 0] ?? "untrained"}`)
      },
      speed: {
        land: attrs.speed?.total ?? attrs.speed?.value ?? 0,
        others: (attrs.speed?.otherSpeeds ?? []).map(s => ({
          label: s.label ?? s.type,
          value: s.total ?? s.value ?? 0
        }))
      },
      dying: {
        value: dying.value ?? 0,
        max: dying.max ?? 4,
        pips: Array.from({ length: dying.max ?? 4 }, (_, i) => ({ index: i + 1, filled: i < (dying.value ?? 0) }))
      },
      wounded: {
        value: wounded.value ?? 0,
        max: wounded.max ?? 3,
        pips: Array.from({ length: wounded.max ?? 3 }, (_, i) => ({ index: i + 1, filled: i < (wounded.value ?? 0) }))
      },
      immunities: (attrs.immunities ?? []).map(i => i.label ?? i.type ?? ""),
      resistances: (attrs.resistances ?? []).map(r => `${r.label ?? r.type ?? ""} ${r.value ?? ""}`.trim()),
      weaknesses: (attrs.weaknesses ?? []).map(w => `${w.label ?? w.type ?? ""} ${w.value ?? ""}`.trim()),
      senses: (actor.perception?.senses?.contents ?? []).map(s => s.label ?? s.type ?? ""),
      languages: (system.details?.languages?.value ?? []).map(l => {
        const cfg = CONFIG.PF2E?.languages?.[l];
        const raw = typeof cfg === "string" ? cfg : (cfg?.label ?? l);
        return game.i18n.localize(raw);
      })
    };
  }

  /* -------------------------------------------- */

  _prepareAbilities(system) {
    const order = ["str", "dex", "con", "int", "wis", "cha"];
    return order.flatMap(key => {
      const ab = system.abilities?.[key];
      if (!ab) return [];
      const mod = ab.mod ?? 0;
      return [{
        key,
        label: loc(`Abilities.${key}`),
        mod,
        modStr: signed(mod)
      }];
    });
  }

  /* -------------------------------------------- */

  _prepareConditions(actor) {
    const active = actor.conditions?.active ?? [];
    return active.map(c => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      img: c.img,
      value: c.system?.value?.value ?? null,
      valued: c.system?.value?.isValued ?? false
    }));
  }

  _prepareEffects(actor) {
    return actor.itemTypes?.effect?.map(e => ({
      id: e.id,
      name: e.name,
      img: e.img,
      badge: e.system?.badge?.value ?? null,
      unidentified: e.system?.unidentified ?? false
    })) ?? [];
  }

  /* -------------------------------------------- */

  _prepareVitalGroups(actor) {
    const all = prepareVitals(actor);
    return VITAL_GROUPS.map(g => ({
      id: g,
      label: loc(`VitalGroups.${g}`),
      vitals: all.filter(v => v.group === g)
    }));
  }

  /* -------------------------------------------- */

  /** One pass over the actor's items → gear grid, loadout, medical bay. */
  _prepareInventory(actor) {
    const favorites = actor.getFlag(MODULE_ID, FLAGS.FAVORITES) ?? [];
    const items = [];
    const supplies = [];
    const provisions = [];
    const loadout = { armor: null, held: [], worn: [] };

    for (const item of actor.items) {
      if (!PHYSICAL_TYPES.includes(item.type)) continue;
      const sys = item.system ?? {};
      const carryType = sys.equipped?.carryType ?? "stowed";
      const equipped = carryType === "held" || carryType === "worn";
      const hpMax = sys.hp?.max ?? 0;
      const hpVal = sys.hp?.value ?? 0;
      const integrityPct = hpMax > 0 ? clamp(Math.round((hpVal / hpMax) * 100), 0, 100) : null;
      const broken = GearIntegrityManager.isBroken(item);
      const destroyed = GearIntegrityManager.isDestroyed(item);
      let condition = null;
      if (integrityPct !== null) {
        if (destroyed) condition = "destroyed";
        else if (broken) condition = "broken";
        else if (integrityPct <= 25) condition = "critical";
        else if (integrityPct <= 50) condition = "damaged";
        else if (integrityPct <= 75) condition = "worn";
        else condition = "good";
      }
      const resistance = item.type === "armor" ? {
        base: GearIntegrityManager.getBaseResistance(item).value ?? 0,
        effective: GearIntegrityManager.getEffectiveResistance(item)
      } : null;
      const bulkRaw = Number(sys.bulk?.value ?? 0);
      const category = sys.category ?? "";
      const isMedical = item.type === "consumable" &&
        (MEDICAL_CATEGORIES.includes(category) || MEDICAL_KEYWORDS.test(item.name));
      const isProvision = PROVISION_KEYWORDS.test(item.name);

      const ctx = {
        id: item.id,
        name: item.name,
        img: item.img,
        type: item.type,
        typeLabel: loc(`ItemType.${item.type}`),
        quantity: sys.quantity ?? 1,
        stackable: sys.quantity !== undefined,
        bulk: bulkRaw === 0 ? "—" : (bulkRaw < 1 ? "L" : String(bulkRaw)),
        carryType,
        equipped,
        invested: item.isInvested ?? null,
        rarity: sys.traits?.rarity ?? "common",
        level: sys.level?.value ?? 0,
        uses: sys.uses?.max ? { value: sys.uses.value ?? 0, max: sys.uses.max } : null,
        integrityPct,
        condition,
        broken,
        destroyed,
        resistance,
        favorite: favorites.includes(item.id),
        isContainer: item.type === "backpack",
        containerContents: item.type === "backpack" ? (item.contents?.size ?? 0) : null,
        canEquip: ["weapon", "shield", "armor", "equipment"].includes(item.type) && !destroyed,
        canConsume: item.type === "consumable",
        isMedical,
        isProvision,
        filterType: item.type === "backpack" || item.type === "kit" ? "container"
          : item.type === "shield" ? "weapon"
          : item.type === "treasure" || item.type === "book" ? "equipment"
          : item.type,
        searchKey: `${item.name} ${(sys.traits?.value ?? []).join(" ")}`.toLowerCase()
      };
      items.push(ctx);

      if (isMedical) supplies.push(ctx);
      else if (isProvision && ["consumable", "equipment"].includes(item.type)) provisions.push(ctx);

      // Loadout column
      if (item.type === "armor" && carryType === "worn") loadout.armor = ctx;
      else if (carryType === "held") loadout.held.push(ctx);
      else if (carryType === "worn") loadout.worn.push(ctx);
    }

    items.sort((a, b) => Number(b.equipped) - Number(a.equipped) || a.name.localeCompare(b.name));

    const bulkData = actor.inventory?.bulk ?? {};
    const bulkValue = bulkData.value?.normal ?? bulkData.value ?? 0;
    const bulkMax = bulkData.max?.normal ?? bulkData.max ?? 0;
    const encumberedAt = bulkData.encumberedAfter ?? bulkData.encumberedAt ?? 0;
    const coins = actor.inventory?.coins ?? {};

    return {
      gear: {
        items,
        filters: GEAR_FILTERS.map(f => ({
          id: f.id,
          label: loc(`GearFilters.${f.id}`),
          active: f.id === this._gearFilter
        })),
        search: this._gearSearch,
        bulk: {
          value: bulkValue,
          max: bulkMax,
          encumberedAt,
          pct: bulkMax > 0 ? clamp(Math.round((bulkValue / bulkMax) * 100), 0, 100) : 0,
          isEncumbered: bulkData.isEncumbered ?? false
        },
        coins: { pp: coins.pp ?? 0, gp: coins.gp ?? 0, sp: coins.sp ?? 0, cp: coins.cp ?? 0 }
      },
      loadout,
      medical: {
        supplies,
        provisions,
        medicine: (() => {
          const stat = actor.skills?.medicine ?? actor.skills?.med;
          return stat ? {
            mod: signed(stat.mod ?? 0),
            rank: stat.rank ?? 0,
            rankLabel: loc(`Rank.${RANKS[stat.rank ?? 0] ?? "untrained"}`)
          } : null;
        })()
      }
    };
  }

  /* -------------------------------------------- */

  _prepareStrikes(actor) {
    const actions = actor.system.actions ?? [];
    const strikes = [];
    actions.forEach((a, idx) => {
      if (a.type !== "strike") return;
      const item = a.item;
      const sys = item?.system ?? {};
      const isUnarmed = a.slug === "basic-unarmed" || sys.category === "unarmed";
      const hpMax = sys.hp?.max ?? 0;
      const integrityPct = hpMax > 0 ? clamp(Math.round(((sys.hp?.value ?? 0) / hpMax) * 100), 0, 100) : null;
      const broken = item ? GearIntegrityManager.isBroken(item) : false;
      const destroyed = item ? GearIntegrityManager.isDestroyed(item) : false;

      let damagePreview = "";
      const dmg = sys.damage ?? {};
      if (dmg.dice && dmg.die) {
        damagePreview = `${dmg.dice}${dmg.die}${dmg.modifier ? signed(dmg.modifier) : ""} ${dmg.damageType ?? ""}`.trim();
      }

      const ammoOptions = (a.ammunition?.compatible ?? []).map(c => ({
        id: c.id,
        label: c.label,
        selected: c.id === (a.ammunition?.selected?.id ?? sys.selectedAmmoId)
      }));
      const selectedAmmoId = a.ammunition?.selected?.id ?? sys.selectedAmmoId ?? null;
      const ammoItem = selectedAmmoId ? actor.items.get(selectedAmmoId) : null;

      strikes.push({
        idx,
        slug: a.slug,
        label: a.label,
        img: a.imageUrl ?? item?.img ?? "icons/skills/melee/unarmed-punch-fist.webp",
        itemId: item?.id ?? null,
        ready: a.ready ?? true,
        isUnarmed,
        isRanged: item?.isRanged ?? !!sys.range,
        range: sys.range ?? null,
        reload: sys.reload?.value || null,
        damagePreview,
        integrityPct,
        broken,
        destroyed,
        traits: (a.traits ?? []).map(t => t.label ?? t.name ?? String(t)).slice(0, 6),
        variants: (a.variants ?? []).map((v, vi) => ({ idx: vi, label: v.label })),
        hasAmmo: ammoOptions.length > 0 || !!sys.reload?.value,
        ammoOptions,
        ammoCount: ammoItem?.system?.quantity ?? null,
        ammoName: ammoItem?.name ?? null,
        auxiliary: (a.auxiliaryActions ?? []).map((aux, ai) => ({
          idx: ai,
          label: aux.label ?? aux.action ?? "",
          glyph: aux.glyph ?? ""
        })),
        hasFx: item ? hasActionFx(item) : false
      });
    });
    return strikes;
  }

  /* -------------------------------------------- */

  _prepareSkills(actor) {
    const out = [];
    const skills = actor.skills ?? {};
    for (const [key, stat] of Object.entries(skills)) {
      if (!stat) continue;
      const rank = stat.rank ?? 0;
      out.push({
        key,
        label: stat.label ?? key,
        mod: stat.mod ?? 0,
        modStr: signed(stat.mod ?? 0),
        rank,
        rankLabel: loc(`Rank.${RANKS[rank] ?? "untrained"}`),
        attribute: (stat.attribute ?? stat.ability ?? "").toUpperCase(),
        lore: stat.lore ?? false,
        rankPips: Array.from({ length: 4 }, (_, i) => ({ filled: i < rank }))
      });
    }
    return out.sort((a, b) => Number(a.lore) - Number(b.lore) || a.label.localeCompare(b.label));
  }

  /* -------------------------------------------- */

  async _prepareJournal(actor, system) {
    const bio = system.details?.biography ?? {};
    const contacts = actor.getFlag(MODULE_ID, FLAGS.CONTACTS) ?? [];
    const objectives = actor.getFlag(MODULE_ID, FLAGS.OBJECTIVES) ?? [];
    return {
      activeTab: this._journalTab,
      notes: await enrich(bio.campaignNotes, actor),
      story: await enrich(bio.backstory, actor),
      appearance: await enrich(bio.appearance, actor),
      allies: await enrich(bio.allies, actor),
      enemies: await enrich(bio.enemies, actor),
      contacts,
      objectives: objectives.map(o => ({ ...o, done: !!o.done })),
      objectivesDone: objectives.filter(o => o.done).length
    };
  }

  /* -------------------------------------------- */

  _prepareFactions(actor) {
    const factions = actor.getFlag(MODULE_ID, FLAGS.FACTIONS) ?? [];
    const STANDING_IDS = ["hostile", "unfriendly", "wary", "neutral", "friendly", "trusted", "allied"];
    return factions.map(f => {
      const standing = clamp(f.standing ?? 0, STANDING_MIN, STANDING_MAX);
      const standingId = STANDING_IDS[standing + 3];
      return {
        id: f.id,
        name: f.name ?? "",
        notes: f.notes ?? "",
        standing,
        standingId,
        standingLabel: loc(`Standing.${standingId}`),
        cells: Array.from({ length: 7 }, (_, i) => {
          const v = i - 3;
          return { value: v, active: v === standing, negative: v < 0, positive: v > 0 };
        })
      };
    });
  }

  /* ============================================= */
  /*  RENDERING & LISTENERS                        */
  /* ============================================= */

  /** @override */
  async close(options) {
    hideTooltip();
    return super.close(options);
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    if (!game.settings.get(MODULE_ID, "worldLicensed")) {
      this._injectLicenseOverlay(html);
      return;
    }

    const root = html[0]?.closest(".hopefinder-sheet") ?? html[0];
    const content = html[0];

    // ── View-state restoration (tab, filters, search) ──
    this._restoreViewState(content);

    // ── Global delegated action dispatcher ──
    content.addEventListener("click", ev => this._dispatch(ev, "click"));
    content.addEventListener("contextmenu", ev => this._dispatch(ev, "context"));
    content.addEventListener("change", ev => this._dispatchChange(ev));
    content.addEventListener("input", ev => {
      const search = ev.target.closest("[data-action='gear-search']");
      if (search) {
        this._gearSearch = search.value.trim().toLowerCase();
        this._applyGearFilter(content);
      }
    });

    // ── Premium tooltips ──
    attachTooltips(content, this.actor);

    // ── HP change FX ──
    const hp = this.actor.system.attributes?.hp ?? {};
    if (this._prevHP !== undefined && this._prevHP !== hp.value) {
      const delta = hp.value - this._prevHP;
      FX.screenFlash(content, delta < 0 ? "damage" : "heal");
      FX.countTween(content.querySelector(".hf-hp-num"), this._prevHP, hp.value);
      if (delta < 0) {
        FX.shake(content.querySelector(".hf-portrait-frame"), Math.min(8, 3 + Math.abs(delta) / 5));
        if (Math.abs(delta) / (hp.max || 1) >= 0.25) FX.sfxAlert();
      }
    }
    this._prevHP = hp.value;

    // ── Entrance animation (first render only) ──
    if (!this._entered) {
      this._entered = true;
      FX.sheetEnter(content);
    }
  }

  /** Blocks interaction with an opaque Patreon-connect overlay until the world is licensed. */
  _injectLicenseOverlay(html) {
    const root = html[0]?.closest(".hopefinder-sheet") ?? html[0];
    if (!root) return;
    root.style.position = "relative";

    const overlay = document.createElement("div");
    overlay.className = "hf-license-overlay";
    overlay.innerHTML = `
      <div class="hf-license-box">
        <div class="hf-license-icon"><i class="fas fa-lock"></i></div>
        <h2>${loc("License.Title")}</h2>
        <p>${loc("License.Body")}</p>
        <button type="button" class="hf-btn hf-license-connect">${loc("License.Connect")}</button>
        <button type="button" class="hf-btn hf-btn--ghost hf-license-code">${loc("License.HaveCode")}</button>
      </div>
    `;

    overlay.querySelector(".hf-license-connect").addEventListener("click", async () => {
      const btn = overlay.querySelector(".hf-license-connect");
      btn.textContent = loc("License.Connecting");
      btn.disabled = true;
      try {
        const success = await HopefinderLicenseClient.instance.startOAuth();
        if (success) this.render(true);
        else { btn.textContent = loc("License.Connect"); btn.disabled = false; }
      } catch (e) {
        btn.textContent = loc("License.Connect"); btn.disabled = false;
        ui.notifications?.error(`Hopefinder Survivor Sheet: ${e.message}`);
      }
    });

    overlay.querySelector(".hf-license-code").addEventListener("click", () => {
      HopefinderLicenseUI.showCodeInput();
    });

    root.appendChild(overlay);
  }

  /* -------------------------------------------- */

  _restoreViewState(content) {
    // Active tab
    for (const nav of content.querySelectorAll(".hf-nav-item")) {
      nav.classList.toggle("active", nav.dataset.tab === this._activeTab);
    }
    for (const tab of content.querySelectorAll(".hf-tab")) {
      tab.classList.toggle("active", tab.dataset.tab === this._activeTab);
    }
    // Journal sub-tab
    for (const st of content.querySelectorAll("[data-journal-tab]")) {
      st.classList.toggle("active", st.dataset.journalTab === this._journalTab);
    }
    for (const sp of content.querySelectorAll("[data-journal-panel]")) {
      sp.classList.toggle("active", sp.dataset.journalPanel === this._journalTab);
    }
    // Gear filter + search
    this._applyGearFilter(content);
    const search = content.querySelector("[data-action='gear-search']");
    if (search && this._gearSearch) search.value = this._gearSearch;
  }

  _applyGearFilter(content) {
    const filter = this._gearFilter;
    const query = this._gearSearch;
    for (const chip of content.querySelectorAll("[data-action='gear-filter']")) {
      chip.classList.toggle("active", chip.dataset.filter === filter);
    }
    let visible = 0;
    for (const card of content.querySelectorAll(".hf-gear-grid .hf-card")) {
      const matchesFilter =
        filter === "all" ||
        (filter === "favorites" ? card.dataset.fav === "true" : card.dataset.filterType === filter);
      const matchesSearch = !query || (card.dataset.search ?? "").includes(query);
      const show = matchesFilter && matchesSearch;
      card.classList.toggle("hf-hidden", !show);
      if (show) visible++;
    }
    const empty = content.querySelector(".hf-gear-empty");
    if (empty) empty.classList.toggle("hf-hidden", visible > 0);
  }

  /* ============================================= */
  /*  ACTION DISPATCH                              */
  /* ============================================= */

  _dispatch(ev, mode) {
    const el = ev.target.closest("[data-action]");
    if (!el || !ev.currentTarget.contains(el)) return;
    const action = el.dataset.action;

    // Actions that respond to right-click get "-alt" semantics
    if (mode === "context") {
      if (["pip-hope", "pip-dying", "pip-wounded", "pip-threat", "condition-badge"].includes(action)) {
        ev.preventDefault();
        this._onAction(action, el, ev, true);
      }
      return;
    }
    if (el.dataset.noclick === "true") return;
    this._onAction(action, el, ev, false);
  }

  _dispatchChange(ev) {
    const el = ev.target.closest("[data-change]");
    if (!el) return;
    this._onInputChange(el.dataset.change, el, ev);
  }

  /* -------------------------------------------- */

  async _onAction(action, el, ev, alt) {
    const actor = this.actor;
    const itemId = el.closest("[data-item-id]")?.dataset.itemId;
    const item = itemId ? actor.items.get(itemId) : null;

    switch (action) {
      /* ── Navigation ── */
      case "tab": {
        const tab = el.dataset.tab;
        if (!tab || tab === this._activeTab) return;
        const order = TABS.map(t => t.id);
        const dir = order.indexOf(tab) > order.indexOf(this._activeTab) ? 1 : -1;
        this._activeTab = tab;
        const content = el.closest(".hf-root");
        this._restoreViewState(content);
        FX.tabSwitch(content.querySelector(`.hf-tab[data-tab="${tab}"]`), dir);
        FX.sfxThunk();
        return;
      }
      case "journal-tab": {
        this._journalTab = el.dataset.journalTab;
        this._restoreViewState(el.closest(".hf-root"));
        FX.sfxTick();
        return;
      }
      case "gear-filter": {
        this._gearFilter = el.dataset.filter;
        this._applyGearFilter(el.closest(".hf-root"));
        FX.press(el); FX.sfxTick();
        return;
      }

      /* ── Rolls (PF2e statistics) ── */
      case "roll-ability": {
        if (!this.isEditable) return;
        FX.rollPulse(el); FX.sfxTick();
        const stat = actor.getStatistic?.(el.dataset.ability);
        return stat?.roll?.({ event: ev });
      }
      case "roll-save": {
        FX.rollPulse(el); FX.sfxTick();
        return actor.saves?.[el.dataset.save]?.roll?.({ event: ev });
      }
      case "roll-skill": {
        FX.rollPulse(el); FX.sfxTick();
        return actor.skills?.[el.dataset.skill]?.roll?.({ event: ev });
      }
      case "roll-perception": {
        FX.rollPulse(el); FX.sfxTick();
        return actor.perception?.roll?.({ event: ev });
      }
      case "roll-initiative": {
        FX.rollPulse(el); FX.sfxTick();
        return actor.initiative?.roll?.({ event: ev });
      }

      /* ── Strikes ── */
      case "strike-attack": {
        FX.rollPulse(el); FX.sfxThunk();
        const strike = actor.system.actions?.[Number(el.dataset.idx)];
        const variant = Number(el.dataset.variant) || 0;
        return strike?.variants?.[variant]?.roll?.({ event: ev });
      }
      case "strike-damage": {
        FX.rollPulse(el); FX.sfxTick();
        return actor.system.actions?.[Number(el.dataset.idx)]?.damage?.({ event: ev });
      }
      case "strike-critical": {
        FX.rollPulse(el); FX.sfxTick();
        return actor.system.actions?.[Number(el.dataset.idx)]?.critical?.({ event: ev });
      }
      case "strike-aux": {
        FX.press(el); FX.sfxThunk();
        const strike = actor.system.actions?.[Number(el.dataset.idx)];
        const aux = strike?.auxiliaryActions?.[Number(el.dataset.aux)];
        return aux?.execute?.();
      }
      case "weapon-fx-config": {
        if (!this.isEditable || !item) return;
        FX.press(el); FX.sfxTick();
        return new WeaponFxConfig(item).render(true);
      }

      /* ── HP / resource pips ── */
      case "hp-adjust": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const hp = actor.system.attributes.hp;
        const delta = Number(el.dataset.delta) || 0;
        return actor.update({ "system.attributes.hp.value": clamp(hp.value + delta, 0, hp.max) });
      }
      case "pip-hope": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const cur = actor.system.resources?.heroPoints?.value ?? 0;
        const n = Number(el.dataset.index);
        const value = alt ? Math.max(0, cur - 1) : (n === cur ? n - 1 : n);
        return actor.update({ "system.resources.heroPoints.value": Math.max(0, value) });
      }
      case "pip-dying": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxAlert();
        const cur = actor.system.attributes?.dying?.value ?? 0;
        const n = Number(el.dataset.index);
        const value = alt ? Math.max(0, cur - 1) : (n === cur ? n - 1 : n);
        return actor.update({ "system.attributes.dying.value": Math.max(0, value) });
      }
      case "pip-wounded": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const cur = actor.system.attributes?.wounded?.value ?? 0;
        const n = Number(el.dataset.index);
        const value = alt ? Math.max(0, cur - 1) : (n === cur ? n - 1 : n);
        return actor.update({ "system.attributes.wounded.value": Math.max(0, value) });
      }
      case "pip-threat": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const cur = actor.getFlag(MODULE_ID, FLAGS.THREAT) ?? 0;
        const n = Number(el.dataset.index);
        const value = alt ? Math.max(0, cur - 1) : (n === cur ? n - 1 : n);
        return actor.setFlag(MODULE_ID, FLAGS.THREAT, clamp(value, 0, THREAT_MAX));
      }

      /* ── Conditions & effects ── */
      case "condition-add": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const slug = el.dataset.slug;
        await actor.increaseCondition?.(slug);
        logEvent(actor, "condition", loc("Timeline.ConditionGained", { condition: el.dataset.name ?? slug }));
        return;
      }
      case "condition-badge": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const slug = el.dataset.slug;
        return alt ? actor.decreaseCondition?.(slug) : actor.increaseCondition?.(slug);
      }
      case "condition-remove": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        return actor.decreaseCondition?.(el.dataset.slug, { forceRemove: true });
      }
      case "effect-open": return item?.sheet.render(true);
      case "effect-remove": {
        if (!this.isEditable || !item) return;
        FX.sfxTick();
        return item.delete();
      }

      /* ── Vitals ── */
      case "vital-step": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        FX.meterPulse(el.closest(".hf-vital")?.querySelector(".hf-vital-meter"));
        return stepVital(actor, el.dataset.vital, Number(el.dataset.delta) || 0);
      }
      case "vital-seg": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const key = el.dataset.vital;
        const index = Number(el.dataset.index);
        const current = Number(el.closest(".hf-vital")?.dataset.value ?? 0);
        // Clicking the topmost filled segment clears down one step
        const value = (index + 1 === current) ? index : index + 1;
        FX.meterPulse(el.closest(".hf-vital-meter"));
        return setVital(actor, key, value);
      }
      case "bruise-step": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        return GearIntegrityManager.addBruise(actor, Number(el.dataset.delta) || 0);
      }

      /* ── Inventory ── */
      case "item-open": return item?.sheet.render(true);
      case "item-chat": {
        FX.sfxTick();
        return item?.toMessage?.(ev) ?? item?.toChat?.();
      }
      case "item-delete": {
        if (!this.isEditable || !item) return;
        const ok = await confirmDialog(
          loc("Dialog.DeleteTitle"),
          `<p>${loc("Dialog.DeleteBody", { item: foundry.utils.escapeHTML(item.name) })}</p>`
        );
        if (ok) {
          FX.sfxAlert();
          await item.delete();
        }
        return;
      }
      case "item-equip": {
        if (!this.isEditable || !item) return;
        FX.press(el); FX.sfxThunk();
        await this._cycleCarryType(item);
        logEvent(actor, "equip", loc("Timeline.Equipped", { item: item.name }));
        return;
      }
      case "item-favorite": {
        if (!this.isEditable || !item) return;
        FX.press(el); FX.sfxTick();
        const favs = actor.getFlag(MODULE_ID, FLAGS.FAVORITES) ?? [];
        const next = favs.includes(item.id) ? favs.filter(f => f !== item.id) : [...favs, item.id];
        return actor.setFlag(MODULE_ID, FLAGS.FAVORITES, next);
      }
      case "item-qty": {
        if (!this.isEditable || !item) return;
        FX.sfxTick();
        const q = Math.max(0, (item.system.quantity ?? 1) + (Number(el.dataset.delta) || 0));
        return item.update({ "system.quantity": q });
      }
      case "item-use": {
        if (!this.isEditable || !item) return;
        FX.rollPulse(el); FX.sfxThunk();
        if (typeof item.consume === "function") {
          await item.consume();
        } else if (typeof game.pf2e?.rollItemMacro === "function") {
          await game.pf2e.rollItemMacro(item.uuid, ev);
        }
        logEvent(actor, "item_use", loc("Timeline.Used", { item: item.name }));
        return;
      }
      case "item-repair": {
        if (!item) return;
        FX.sfxTick();
        return GearIntegrityManager.runRepair(actor, item, { event: ev });
      }
      case "armor-resistance": {
        if (!this.isEditable || !item) return;
        FX.sfxTick();
        return this._openResistanceConfig(item);
      }

      /* ── Medical quick actions ── */
      case "medic-action": {
        FX.rollPulse(el); FX.sfxThunk();
        return this._usePF2eAction(el.dataset.slug);
      }

      /* ── Header / misc ── */
      case "portrait": {
        if (!this.isEditable) return;
        const FP = getFilePicker();
        return new FP({
          type: "image",
          current: actor.img,
          callback: path => actor.update({ img: path })
        }).browse();
      }
      case "rest": {
        FX.sfxThunk();
        const rest = game.pf2e?.actions?.restForTheNight;
        if (typeof rest === "function") return rest({ actors: [actor] });
        return;
      }
      case "backdrop-config": return this._openBackdropConfig();
      case "open-item-doc": {
        // Class / background pills → open the granting item
        const doc = actor[el.dataset.doc];
        return doc?.sheet?.render(true);
      }

      /* ── Factions ── */
      case "faction-add": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const factions = actor.getFlag(MODULE_ID, FLAGS.FACTIONS) ?? [];
        factions.push({ id: foundry.utils.randomID(), name: "", standing: 0, notes: "" });
        return actor.setFlag(MODULE_ID, FLAGS.FACTIONS, factions);
      }
      case "faction-remove": {
        if (!this.isEditable) return;
        const factions = (actor.getFlag(MODULE_ID, FLAGS.FACTIONS) ?? [])
          .filter(f => f.id !== el.dataset.id);
        FX.sfxTick();
        return actor.setFlag(MODULE_ID, FLAGS.FACTIONS, factions);
      }
      case "faction-standing": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const factions = actor.getFlag(MODULE_ID, FLAGS.FACTIONS) ?? [];
        const f = factions.find(x => x.id === el.dataset.id);
        if (!f) return;
        f.standing = clamp(Number(el.dataset.value), STANDING_MIN, STANDING_MAX);
        await actor.setFlag(MODULE_ID, FLAGS.FACTIONS, factions);
        if (f.name) logEvent(actor, "faction", loc("Timeline.FactionShift", { faction: f.name }));
        return;
      }

      /* ── Objectives & contacts ── */
      case "objective-add": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const list = actor.getFlag(MODULE_ID, FLAGS.OBJECTIVES) ?? [];
        list.push({ id: foundry.utils.randomID(), text: "", done: false });
        return actor.setFlag(MODULE_ID, FLAGS.OBJECTIVES, list);
      }
      case "objective-toggle": {
        if (!this.isEditable) return;
        FX.press(el); FX.sfxTick();
        const list = actor.getFlag(MODULE_ID, FLAGS.OBJECTIVES) ?? [];
        const o = list.find(x => x.id === el.dataset.id);
        if (!o) return;
        o.done = !o.done;
        return actor.setFlag(MODULE_ID, FLAGS.OBJECTIVES, list);
      }
      case "objective-remove": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const list = (actor.getFlag(MODULE_ID, FLAGS.OBJECTIVES) ?? [])
          .filter(x => x.id !== el.dataset.id);
        return actor.setFlag(MODULE_ID, FLAGS.OBJECTIVES, list);
      }
      case "contact-add": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const list = actor.getFlag(MODULE_ID, FLAGS.CONTACTS) ?? [];
        list.push({ id: foundry.utils.randomID(), name: "", where: "", status: "" });
        return actor.setFlag(MODULE_ID, FLAGS.CONTACTS, list);
      }
      case "contact-remove": {
        if (!this.isEditable) return;
        FX.sfxTick();
        const list = (actor.getFlag(MODULE_ID, FLAGS.CONTACTS) ?? [])
          .filter(x => x.id !== el.dataset.id);
        return actor.setFlag(MODULE_ID, FLAGS.CONTACTS, list);
      }

      /* ── Timeline ── */
      case "tl-remove": {
        if (!this.isEditable) return;
        FX.sfxTick();
        return removeEvent(actor, Number(el.dataset.t));
      }
      case "tl-clear": {
        if (!this.isEditable) return;
        const ok = await confirmDialog(loc("Dialog.ClearLogTitle"), `<p>${loc("Dialog.ClearLogBody")}</p>`);
        if (ok) {
          FX.sfxAlert();
          await clearTimeline(actor);
        }
        return;
      }
      case "tl-note": {
        if (!this.isEditable) return;
        const input = el.closest(".hf-tl-composer")?.querySelector("input");
        const text = input?.value.trim();
        if (!text) return;
        FX.sfxTick();
        input.value = "";
        return logEvent(actor, "note", text);
      }
    }
  }

  /* -------------------------------------------- */

  async _onInputChange(change, el) {
    const actor = this.actor;
    switch (change) {
      case "hp-input": {
        const hp = actor.system.attributes.hp;
        const raw = String(el.value).trim();
        let value;
        if (/^[+-]/.test(raw)) value = hp.value + (Number(raw) || 0);
        else value = Number(raw);
        if (!Number.isFinite(value)) { el.value = hp.value; return; }
        return actor.update({ "system.attributes.hp.value": clamp(Math.round(value), 0, hp.max) });
      }
      case "vital-input": {
        return setVital(actor, el.dataset.vital, Number(el.value) || 0);
      }
      case "callsign": return actor.setFlag(MODULE_ID, FLAGS.CALLSIGN, String(el.value).trim());
      case "archetype": return actor.setFlag(MODULE_ID, FLAGS.ARCHETYPE, String(el.value).trim());
      case "ammo-select": {
        const strike = actor.system.actions?.[Number(el.dataset.idx)];
        const weapon = strike?.item;
        if (weapon) return weapon.update({ "system.selectedAmmoId": el.value || null });
        return;
      }
      case "faction-field": {
        const factions = actor.getFlag(MODULE_ID, FLAGS.FACTIONS) ?? [];
        const f = factions.find(x => x.id === el.dataset.id);
        if (!f) return;
        f[el.dataset.field] = el.value;
        return actor.setFlag(MODULE_ID, FLAGS.FACTIONS, factions);
      }
      case "contact-field": {
        const list = actor.getFlag(MODULE_ID, FLAGS.CONTACTS) ?? [];
        const c = list.find(x => x.id === el.dataset.id);
        if (!c) return;
        c[el.dataset.field] = el.value;
        return actor.setFlag(MODULE_ID, FLAGS.CONTACTS, list);
      }
      case "objective-text": {
        const list = actor.getFlag(MODULE_ID, FLAGS.OBJECTIVES) ?? [];
        const o = list.find(x => x.id === el.dataset.id);
        if (!o) return;
        o.text = el.value;
        return actor.setFlag(MODULE_ID, FLAGS.OBJECTIVES, list);
      }
      case "item-qty-input": {
        const item = actor.items.get(el.closest("[data-item-id]")?.dataset.itemId);
        if (!item) return;
        return item.update({ "system.quantity": Math.max(0, Number(el.value) || 0) });
      }
    }
  }

  /* ============================================= */
  /*  PF2e INTEGRATION HELPERS                     */
  /* ============================================= */

  /** Cycle an item's carry state through the PF2e API. */
  async _cycleCarryType(item) {
    const actor = this.actor;
    const sys = item.system;
    const carry = sys.equipped?.carryType ?? "stowed";
    if (carry !== "worn" && carry !== "held" && GearIntegrityManager.isDestroyed(item)) {
      ui.notifications?.warn(loc("Warn.CannotEquipDestroyed", { item: item.name }));
      return;
    }
    const change = async opts => {
      if (typeof actor.changeCarryType === "function") {
        return actor.changeCarryType(item, opts);
      }
      return item.update({
        "system.equipped.carryType": opts.carryType,
        "system.equipped.handsHeld": opts.handsHeld ?? 0,
        ...(opts.inSlot !== undefined ? { "system.equipped.inSlot": opts.inSlot } : {})
      });
    };

    if (item.type === "armor") {
      return carry === "worn"
        ? change({ carryType: "stowed", handsHeld: 0 })
        : change({ carryType: "worn", handsHeld: 0 });
    }
    if (item.type === "weapon" || item.type === "shield") {
      const hands = /two/.test(sys.usage?.value ?? "") ? 2 : 1;
      return carry === "held"
        ? change({ carryType: "stowed", handsHeld: 0 })
        : change({ carryType: "held", handsHeld: hands });
    }
    // Generic equipment: worn ↔ stowed
    return carry === "worn"
      ? change({ carryType: "stowed", handsHeld: 0 })
      : change({ carryType: "worn", handsHeld: 0 });
  }

  /** Invoke a PF2e system action by slug, with legacy fallback. */
  async _usePF2eAction(slug, options = {}) {
    const actions = game.pf2e?.actions;
    if (!actions) return;
    const modern = typeof actions.get === "function" ? actions.get(slug) : null;
    if (modern?.use) {
      return modern.use({ actors: [this.actor], event: options.event });
    }
    const legacyName = slug.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (typeof actions[legacyName] === "function") {
      return actions[legacyName]({ actors: [this.actor], event: options.event });
    }
    ui.notifications?.warn(loc("Warn.ActionUnavailable", { action: slug }));
  }

  /* -------------------------------------------- */

  /** Armor Resistance (damage reduction) editor — not a native PF2e field. */
  async _openResistanceConfig(item) {
    const current = GearIntegrityManager.getBaseResistance(item);
    const content = `
      <form class="hf-resistance-form">
        <div class="form-group">
          <label>${loc("Dialog.ResistanceValue")}</label>
          <input type="number" name="value" min="0" value="${current.value ?? 0}">
        </div>
        <div class="form-group">
          <label>${loc("Dialog.ResistanceTypes")}</label>
          <input type="text" name="types" value="${foundry.utils.escapeHTML(current.types ?? "")}" placeholder="bludgeoning, piercing, slashing">
        </div>
        <div class="form-group">
          <label><input type="checkbox" name="helmet" ${current.helmet ? "checked" : ""}> ${loc("Dialog.Helmet")}</label>
        </div>
      </form>`;
    const apply = formEl => {
      const data = new FormData(formEl);
      return GearIntegrityManager.setBaseResistance(item, {
        value: data.get("value"),
        types: data.get("types"),
        helmet: data.get("helmet") === "on"
      });
    };
    const D2 = foundry.applications?.api?.DialogV2;
    if (D2?.wait) {
      return D2.wait({
        window: { title: `${loc("Dialog.SetResistanceTitle")} — ${item.name}` },
        content,
        buttons: [{
          action: "save", label: loc("Backdrop.Save"), icon: "fas fa-check", default: true,
          callback: (event, button) => apply(button.form ?? event.currentTarget.closest("dialog").querySelector("form"))
        }]
      });
    }
    return new Dialog({
      title: `${loc("Dialog.SetResistanceTitle")} — ${item.name}`,
      content,
      buttons: { save: { icon: '<i class="fas fa-check"></i>', label: loc("Backdrop.Save"), callback: html => apply((html[0] ?? html).querySelector("form")) } },
      default: "save"
    }).render(true);
  }

  /* -------------------------------------------- */

  /** Per-actor cinematic backdrop configuration. */
  async _openBackdropConfig() {
    const actor = this.actor;
    const current = actor.getFlag(MODULE_ID, FLAGS.BACKDROP) ?? {};
    const content = `
      <form class="hf-backdrop-form">
        <div class="form-group">
          <label>${loc("Backdrop.Path")}</label>
          <div class="form-fields">
            <input type="text" name="img" value="${current.img ?? ""}" placeholder="path/to/image.webp">
            <button type="button" class="hf-browse" title="${loc("Backdrop.Browse")}">
              <i class="fas fa-folder-open"></i>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label>${loc("Backdrop.Opacity")}</label>
          <input type="range" name="opacity" min="20" max="100" step="5" value="${current.opacity ?? 85}">
        </div>
      </form>`;

    const apply = html => {
      const form = (html instanceof HTMLElement ? html : html[0]).querySelector("form") ??
        (html instanceof HTMLElement ? html : html[0]).closest("form");
      const root = form ?? (html instanceof HTMLElement ? html : html[0]);
      const img = root.querySelector("[name=img]")?.value?.trim() ?? "";
      const opacity = Number(root.querySelector("[name=opacity]")?.value ?? 85);
      return actor.setFlag(MODULE_ID, FLAGS.BACKDROP, { img, opacity });
    };
    const bindBrowse = root => {
      root.querySelector(".hf-browse")?.addEventListener("click", () => {
        const FP = getFilePicker();
        new FP({
          type: "imagevideo",
          current: root.querySelector("[name=img]")?.value ?? "",
          callback: path => { root.querySelector("[name=img]").value = path; }
        }).browse();
      });
    };

    const D2 = foundry.applications?.api?.DialogV2;
    if (D2) {
      return D2.wait({
        window: { title: loc("Backdrop.Title") },
        content,
        buttons: [
          {
            action: "save", label: loc("Backdrop.Save"), icon: "fas fa-check", default: true,
            callback: (event, button) => apply(button.form ?? event.currentTarget.closest("dialog"))
          },
          {
            action: "clear", label: loc("Backdrop.Clear"), icon: "fas fa-trash",
            callback: () => actor.setFlag(MODULE_ID, FLAGS.BACKDROP, { img: "", opacity: 85 })
          }
        ],
        render: (event, dialog) => bindBrowse(dialog.element ?? dialog)
      });
    }
    return new Dialog({
      title: loc("Backdrop.Title"),
      content,
      buttons: {
        save: { icon: '<i class="fas fa-check"></i>', label: loc("Backdrop.Save"), callback: apply },
        clear: {
          icon: '<i class="fas fa-trash"></i>', label: loc("Backdrop.Clear"),
          callback: () => actor.setFlag(MODULE_ID, FLAGS.BACKDROP, { img: "", opacity: 85 })
        }
      },
      default: "save",
      render: html => bindBrowse(html[0] ?? html)
    }).render(true);
  }
}
