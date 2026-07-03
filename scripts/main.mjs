/**
 * Hopefinder Survivor Sheet — module entry point.
 * Registers the sheet, client settings, Handlebars helpers, template
 * partials and the timeline auto-capture hooks.
 */

import { MODULE_ID, TABS } from "./config.mjs";
import { HopefinderSheet } from "./sheet.mjs";
import { HopefinderNpcSheet } from "./npc-sheet.mjs";
import { HopefinderVehicleSheet } from "./vehicle-sheet.mjs";
import { registerTimelineHooks } from "./timeline.mjs";
import { GearIntegrityManager, registerGearIntegrityHooks } from "./gear-integrity.mjs";
import { registerActionFxHooks } from "./action-fx.mjs";
import { HopefinderLicenseClient, HopefinderLicenseUI } from "./license-client.mjs";

const TEMPLATE_ROOT = `modules/${MODULE_ID}/templates`;

Hooks.once("init", () => {
  /* ── World-level license flag — set by GM after Patreon auth, read by all clients ── */
  game.settings.register(MODULE_ID, "worldLicensed", {
    scope: "world", type: Boolean, config: false, default: false
  });

  /* ── Client settings ── */
  game.settings.register(MODULE_ID, "animations", {
    name: `HOPEFINDER.Settings.Animations`,
    hint: `HOPEFINDER.Settings.AnimationsHint`,
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "uiAudio", {
    name: `HOPEFINDER.Settings.UiAudio`,
    hint: `HOPEFINDER.Settings.UiAudioHint`,
    scope: "client", config: true, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "uiAudioVolume", {
    name: `HOPEFINDER.Settings.UiAudioVolume`,
    scope: "client", config: true, type: Number, default: 40,
    range: { min: 0, max: 100, step: 5 }
  });
  game.settings.register(MODULE_ID, "chatTheme", {
    name: `HOPEFINDER.Settings.ChatTheme`,
    hint: `HOPEFINDER.Settings.ChatThemeHint`,
    scope: "client", config: true, type: Boolean, default: true,
    onChange: v => document.body.classList.toggle("hf-chat-theme", v)
  });
  game.settings.register(MODULE_ID, "highContrast", {
    name: `HOPEFINDER.Settings.HighContrast`,
    hint: `HOPEFINDER.Settings.HighContrastHint`,
    scope: "client", config: true, type: Boolean, default: false,
    onChange: v => document.body.classList.toggle("hf-high-contrast", v)
  });
  game.settings.register(MODULE_ID, "fontScale", {
    name: `HOPEFINDER.Settings.FontScale`,
    hint: `HOPEFINDER.Settings.FontScaleHint`,
    scope: "client", config: true, type: Number, default: 100,
    range: { min: 85, max: 130, step: 5 },
    onChange: v => document.documentElement.style.setProperty("--hf-font-scale", v / 100)
  });

  /* ── Sheet registration ── */
  const registrar = foundry.documents?.collections?.Actors ?? Actors;
  registrar.registerSheet("pf2e", HopefinderSheet, {
    types: ["character"],
    makeDefault: false,
    label: "Hopefinder Survivor Sheet"
  });
  registrar.registerSheet("pf2e", HopefinderNpcSheet, {
    types: ["npc"],
    makeDefault: false,
    label: "Hopefinder NPC Sheet"
  });
  registrar.registerSheet("pf2e", HopefinderVehicleSheet, {
    types: ["vehicle"],
    makeDefault: false,
    label: "Hopefinder Vehicle Sheet"
  });

  /* ── Handlebars helpers (namespaced to avoid collisions) ── */
  Handlebars.registerHelper("hfEq", (a, b) => a === b);
  Handlebars.registerHelper("hfGt", (a, b) => Number(a) > Number(b));
  Handlebars.registerHelper("hfOr", (a, b) => a || b);

  /* ── Template partials ── */
  const partials = TABS.map(t => `${TEMPLATE_ROOT}/tabs/${t.id}.hbs`);
  const loader = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
  loader(partials);

  /* ── Timeline auto-capture ── */
  registerTimelineHooks();

  /* ── Dings & Broken Gear automation ── */
  registerGearIntegrityHooks();
  game.hopefinder = { ...game.hopefinder, GearIntegrityManager };

  /* ── Weapon FX (sound + image on strikes) ── */
  registerActionFxHooks();

  console.log(`${MODULE_ID} | Hopefinder Survivor Sheet registered`);
});

Hooks.once("ready", () => {
  // Apply persisted accessibility preferences
  document.body.classList.toggle("hf-chat-theme", game.settings.get(MODULE_ID, "chatTheme"));
  document.body.classList.toggle("hf-high-contrast", game.settings.get(MODULE_ID, "highContrast"));
  document.documentElement.style.setProperty(
    "--hf-font-scale",
    game.settings.get(MODULE_ID, "fontScale") / 100
  );

  // Initialize license — if already authenticated (shared with vnd-enhanced), tokens are validated from localStorage
  HopefinderLicenseClient.instance.initialize().then(tokenValid => {
    const worldLicensed = game.settings.get(MODULE_ID, "worldLicensed");
    if (!tokenValid && !worldLicensed) {
      HopefinderLicenseUI.show();
    } else if (tokenValid && !worldLicensed && game.user?.isGM) {
      // Token is valid but the world setting hasn't caught up yet (e.g. a new GM client)
      game.settings.set(MODULE_ID, "worldLicensed", true).catch(() => {});
    }
  }).catch(() => {
    if (!game.settings.get(MODULE_ID, "worldLicensed")) HopefinderLicenseUI.show();
  });
});
