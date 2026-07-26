# Hopefinder Survivor Sheet

A cinematic, tactical survivor character sheet for **Hopefinder** on the **Pathfinder 2e** system for Foundry VTT (v12–v14). Military-HUD design language: carbon black, industrial steel, olive drab, amber and emergency red. No parchment, no fantasy — pure survival.

## Features

- **Survivor** — dossier with level, XP, archetype, threat level, Hope (hero points), dying/wounded trackers, abilities, saves, sitrep (senses, languages, IWR) and quick strikes.
- **Vital Signs** — flag-backed biomonitor: bleeding, infection, trauma, hunger, thirst, fatigue, sleep, temperature, stress, addiction and morale. Each with a segmented tactical gauge; the *whole interface retints* as the survivor deteriorates (stable → wounded → critical → down, plus infected/bleeding overlays).
- **Gear** — Tarkov-style card grid with live search, category filters, favorites, durability bars, quantity steppers, carry-state cycling through the PF2e API, load/encumbrance meter and currency.
- **Arsenal** — weapon systems cards: MAP attack variants, damage/critical, base damage preview, traits, range/reload, ammo selector with remaining count, PF2e auxiliary actions (Reload, Draw…), repair.
- **Medical** — field triage (Treat Wounds / First Aid via PF2e actions), medical supplies with one-click Apply (native `consume()`), and detected provisions.
- **Skills** — training matrix cards with rank pips; click to roll.
- **Journal** — ProseMirror field notes, survivor story, appearance, allies/enemies, contact registry and objective checklist.
- **Factions** — standing board (-3 hostile … +3 allied) with notes.
- **Timeline** — automatic operations log (damage, healing, going down, level-ups, loot, item use, condition/loadout changes) plus manual entries.
- **Premium tooltips** — image, rarity, stats, traits and enriched description excerpt on any item.
- **FX engine** — Web Animations API (no libraries), optional synthesized UI audio (no files), honors `prefers-reduced-motion`.
- **Accessibility** — high-contrast mode, text scaling, keyboard-focusable controls, animation kill-switch.

## Requirements

| Requirement | Detail |
|---|---|
| Foundry VTT | **v12** minimum, **v13** verified. |
| Game system | **Pathfinder 2e** (`pf2e`). |
| Subscription | An **active, qualifying Patreon** subscription to [GM RedVelvet](https://www.patreon.com/gmredvelvet), for as long as you use the module — see [Licensing](#licensing). Only the **GM** authorises; players never see a prompt. |
| Internet | Required while playing. The licence is verified periodically against a licence server. |

## Installation

1. The folder **must be named `hopefinder-sheet`** (the module id). If it is `hopefinder sheet`, rename it.
2. Enable *Hopefinder Survivor Sheet* in your world (requires the PF2e system).
3. On a character: **Sheet Configuration → This Sheet → Hopefinder Survivor Sheet**.

Or install from the manifest URL:

```
https://github.com/gmredvelvet-rgb/hopefinder-sheet/releases/latest/download/module.json
```

## Licensing

Hopefinder Survivor Sheet requires an active, qualifying **Patreon** subscription to [GM RedVelvet](https://www.patreon.com/gmredvelvet).

**Only the GM authorises.** On their first load the GM is prompted to connect their Patreon account, which unlocks the module for everyone in the world. Players never see a prompt and never need an account of their own. If popups are blocked — common on phones — use the **auth-code** flow instead: connect on any device, copy the code, and paste it in.

### What happens if the subscription lapses

**Please read this before subscribing.** This is a subscription, not a one-off purchase, and the module re-checks it periodically against a licence server. Plainly:

- **If the subscription lapses, the sheet locks.** It is covered by an activation panel and cannot be used until the subscription is active again.
- **Your characters are not locked.** The sheet is registered alongside the system's default one, never in place of it, so you can switch any actor back through *Sheet Configuration* and keep playing immediately.
- **Nothing is altered or lost.** Foundry, your world, your actors and your items are untouched, and the survival stats stay where they live — in actor flags under `hopefinder-sheet`, with the PF2e data model never modified. No data is withheld and no content becomes unopenable. Resubscribing turns the sheet straight back on.
- **An internet connection is required while playing.** Verification is periodic, so a client that cannot reach the licence server locks the sheet until it can. Fully offline or air-gapped games are not supported.

If a perpetual licence is what you need, this is not that today. I would rather say so here than have anyone find out mid-campaign.

## Integration notes

- All PF2e mechanics run through the system API (`getStatistic`, `saves`, `skills`, strikes/variants, `increaseCondition`, `changeCarryType`, `consume`, `game.pf2e.actions`). Rule elements, effects, macros and drag & drop keep working.
- Survival stats live in actor flags under `hopefinder-sheet` — the PF2e data model is never modified.
- Nothing breaks if you switch back to the default PF2e sheet.

## Architecture

```
scripts/
  main.mjs      entry: registration, settings, partials, hooks
  config.mjs    constants & definitions (single source of truth)
  sheet.mjs     HopefinderSheet (ActorSheet) — context prep + action dispatch
  vitals.mjs    survival data layer (actor flags) + sheet-state derivation
  timeline.mjs  event log data layer + auto-capture hooks
  fx.mjs        motion (WAAPI) + synthesized UI audio
  tooltip.mjs   shared premium tooltip engine
templates/      sheet.hbs + tabs/*.hbs (logic-free)
styles/         core (tokens/layout) · components · tabs · fx (states)
lang/           en, es
```
