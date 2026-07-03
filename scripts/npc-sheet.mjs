/**
 * Hopefinder NPC Sheet — ActorSheet for PF2e "npc" actors.
 * A leaner dossier with the same military-HUD language as the survivor
 * sheet: profile (attributes, saves, sitrep, skills), arsenal (strikes),
 * loot and notes. All PF2e mechanics run through the system's own API via
 * the helpers inherited from HopefinderSheet.
 */

import { MODULE_ID, FLAGS, NPC_TABS, QUICK_CONDITIONS, loc } from "./config.mjs";
import { HopefinderSheet, enrich } from "./sheet.mjs";
import { deriveSheetState } from "./vitals.mjs";

const ActorSheetV1 = foundry.appv1?.sheets?.ActorSheet ?? window.ActorSheet;

export class HopefinderNpcSheet extends HopefinderSheet {

  static SHEET_TABS = NPC_TABS;

  _activeTab = "profile";

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["pf2e", "actor", "hopefinder-sheet", "hf-npc-sheet"],
      template: `modules/${MODULE_ID}/templates/npc-sheet.hbs`,
      width: 980,
      height: 720
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

    context.state = deriveSheetState(actor);
    context.tabs = this.constructor.SHEET_TABS.map(t => ({
      id: t.id,
      icon: t.icon,
      label: loc(`NpcTabs.${t.id}`),
      active: t.id === this._activeTab
    }));

    context.header = this._prepareNpcHeader(actor, system);
    context.combat = this._prepareCombat(actor, system);
    context.abilities = this._prepareAbilities(system);
    context.conditions = this._prepareConditions(actor);
    context.quickConditions = QUICK_CONDITIONS.map(slug => {
      const c = game.pf2e?.ConditionManager?.getCondition?.(slug);
      return { slug, name: c?.name ?? slug };
    });
    context.effects = this._prepareEffects(actor);
    context.strikes = this._prepareStrikes(actor);
    context.skills = this._prepareSkills(actor);
    context.gear = this._prepareInventory(actor).gear;
    context.notes = await this._prepareNotes(actor, system);

    const backdrop = actor.getFlag(MODULE_ID, FLAGS.BACKDROP) ?? {};
    context.backdrop = {
      img: backdrop.img ?? "",
      isVideo: /\.(webm|mp4)$/i.test(backdrop.img ?? ""),
      opacity: backdrop.opacity ?? 85
    };

    return context;
  }

  /* -------------------------------------------- */

  _prepareNpcHeader(actor, system) {
    const details = system.details ?? {};
    const traits = system.traits ?? {};
    const traitLabels = (traits.value ?? []).map(t => {
      const cfg = CONFIG.PF2E?.creatureTraits?.[t];
      const raw = typeof cfg === "string" ? cfg : (cfg?.label ?? t);
      return game.i18n.localize(raw);
    });
    return {
      name: actor.name,
      img: actor.img,
      portraitIsVideo: /\.(webm|mp4|ogg)$/i.test(actor.img ?? ""),
      level: details.level?.value ?? 0,
      rarity: traits.rarity ?? "common",
      rarityLabel: loc(`Rarity.${traits.rarity ?? "common"}`),
      traits: traitLabels,
      blurb: details.blurb ?? ""
    };
  }

  /* -------------------------------------------- */

  async _prepareNotes(actor, system) {
    const details = system.details ?? {};
    return {
      publicRaw: details.publicNotes ?? "",
      privateRaw: details.privateNotes ?? "",
      publicNotes: await enrich(details.publicNotes, actor),
      privateNotes: await enrich(details.privateNotes, actor)
    };
  }
}
