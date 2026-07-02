/**
 * Hopefinder Survivor Sheet — Weapon FX configuration dialog.
 * Per-roll-type (attack1/2/3, damage, critical) Playlist + Track picker,
 * plus a single shared action image for the weapon.
 */

import { MODULE_ID, loc } from "./config.mjs";
import { ROLL_TYPES, ROLL_LABEL_KEYS, ROLL_ICONS, getActionFx, setActionFxSound, setActionFxImage, playActionSound } from "./action-fx.mjs";

const FormApplicationV1 = foundry.appv1?.api?.FormApplication ?? FormApplication;

function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
}

export class WeaponFxConfig extends FormApplicationV1 {
  constructor(item, options = {}) {
    super(item, options);
    this.item = item;
    this._activeTab = "attack1";

    const fx = getActionFx(item);
    this._tabPlaylists = {};
    for (const key of ROLL_TYPES) this._tabPlaylists[key] = fx.sounds?.[key]?.playlist ?? "";
  }

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "hf-weapon-fx-config",
      title: loc("ActionFx.ConfigTitle"),
      template: `modules/${MODULE_ID}/templates/dialogs/weapon-fx-config.hbs`,
      classes: ["hopefinder-sheet", "hf-fx-config"],
      width: 380,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false
    });
  }

  /** @override */
  async getData() {
    const fx = getActionFx(this.item);
    const playlists = game.playlists?.contents ?? [];

    const tabs = ROLL_TYPES.map(key => {
      const cfg = fx.sounds?.[key] ?? {};
      const playlistId = this._tabPlaylists[key] ?? cfg.playlist ?? "";
      const playlist = playlistId ? game.playlists.get(playlistId) : null;
      const volume = cfg.volume ?? 0.8;
      return {
        key,
        label: loc(ROLL_LABEL_KEYS[key]),
        icon: ROLL_ICONS[key],
        active: key === this._activeTab,
        playlistId,
        trackId: cfg.track ?? "",
        volume,
        volumePct: Math.round(volume * 100),
        tracks: playlist ? playlist.sounds.contents : [],
        hasSound: !!(playlistId && cfg.track)
      };
    });

    return {
      itemName: this.item.name,
      tabs,
      playlists,
      image: fx.image ?? ""
    };
  }

  /** @override */
  async _updateObject(event, formData) {
    for (const key of ROLL_TYPES) {
      await setActionFxSound(this.item, key, {
        playlist: formData[`${key}.playlist`] || "",
        track: formData[`${key}.track`] || "",
        volume: Number.parseFloat(formData[`${key}.volume`]) || 0.8
      });
    }
    await setActionFxImage(this.item, formData.image ?? "");
    ui.notifications.info(loc("ActionFx.Saved", { item: this.item.name }));
    this.close();
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find(".hf-fx-tab").on("click", ev => {
      this._activeTab = ev.currentTarget.dataset.tab;
      this.render();
    });

    html.find("select[data-field='playlist']").on("change", ev => {
      const tab = ev.currentTarget.closest("[data-tab-panel]").dataset.tabPanel;
      this._tabPlaylists[tab] = ev.target.value;
      this.render();
    });

    html.find("input[data-field='volume']").on("input", ev => {
      const panel = ev.currentTarget.closest("[data-tab-panel]");
      panel.querySelector(".hf-fx-vol-val").textContent = `${Math.round(ev.target.value * 100)}%`;
    });

    html.find(".hf-fx-preview").on("click", ev => {
      const panel = ev.currentTarget.closest("[data-tab-panel]");
      const playlistId = panel.querySelector("[data-field='playlist']").value;
      const trackId = panel.querySelector("[data-field='track']").value;
      const volume = Number.parseFloat(panel.querySelector("[data-field='volume']").value) || 0.8;
      if (playlistId && trackId) playActionSound(playlistId, trackId, volume);
      else ui.notifications.warn(loc("ActionFx.PickFirst"));
    });

    html.find(".hf-fx-clear-tab").on("click", async ev => {
      const tab = ev.currentTarget.dataset.clearTab;
      this._tabPlaylists[tab] = "";
      await setActionFxSound(this.item, tab, { playlist: "", track: "", volume: 0.8 });
      this.render();
    });

    html.find(".hf-fx-clear-all").on("click", async () => {
      for (const key of ROLL_TYPES) {
        this._tabPlaylists[key] = "";
        await setActionFxSound(this.item, key, { playlist: "", track: "", volume: 0.8 });
      }
      this.render();
    });

    html.find(".hf-fx-img-pick").on("click", () => {
      const hidden = html.find("[name='image']")[0];
      const preview = html.find(".hf-fx-img-preview")[0];
      const FP = getFilePicker();
      new FP({
        type: "image",
        current: hidden?.value || "",
        callback: path => {
          if (hidden) hidden.value = path;
          if (preview) { preview.src = path; preview.style.display = ""; }
        }
      }).browse();
    });

    html.find(".hf-fx-img-clear").on("click", () => {
      const hidden = html.find("[name='image']")[0];
      const preview = html.find(".hf-fx-img-preview")[0];
      if (hidden) hidden.value = "";
      if (preview) { preview.src = ""; preview.style.display = "none"; }
    });
  }
}
