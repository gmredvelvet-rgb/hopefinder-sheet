/**
 * Hopefinder Survivor Sheet — License Client
 *
 * Same Patreon subscription unlocks all VNE modules, but each module holds its own
 * installation ID and token set (the server tracks installations per module).
 * All sensitive operations happen on the server; this is the client-side
 * coordinator only — it never sees the Patreon client secret.
 */

const OWN_MODULE_ID = 'hopefinder-sheet';
const API_BASE      = 'https://vnd-license.gmredvelvet.workers.dev';

const RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3-hTzuHo9lgENNQiA4-Fm7VIdalqisZ5NhqrBioXmIXSMbEhYpy1TnPkCBAdAzXAsyX1YdTYLcMADETPnERvceLsDoAWHFZzHGxoXBkOGw0ukAyHJyrwBZxCf_bY_FSbip_-XQuTS4YuyhLPVNjbGMZdVarkegh7BKwW4CR9MDb1DMtf_NxtfNqJ3MxhfAiTxIod4AWer8esisr0IekQlPLmMPA2KggzQw9rFj61B4DAVk2F_TAXPMOKyEcX_zVGpp00JTurTsfwK2023UHKO9t98R0rG17oX0rK_x2EOBiW2Nla3NChZyR4yi8zHe0vjYhprqcwozv9wN0wbANnzwIDAQAB';

// Per-module storage keys (same pattern as sf2e-cyber-sheet / starfinderdashboard).
// The server registers each module as its own installation, so tokens and the
// installation ID must NOT be shared with vnd-enhanced: reusing its installation ID
// makes /oauth/exchange reject the activation with INSTALL_CONFLICT, and reusing its
// token slots would clobber vnd-enhanced's refresh-token rotation.
const SK = {
  accessToken:    `${OWN_MODULE_ID}:at`,
  refreshToken:   `${OWN_MODULE_ID}:rt`,
  tokenExpiry:    `${OWN_MODULE_ID}:exp`,
  installationId: `${OWN_MODULE_ID}:iid`,
  tier:           `${OWN_MODULE_ID}:tier`,
  features:       `${OWN_MODULE_ID}:features`,
};

export class HopefinderLicenseClient {
  static #instance = null;

  #accessToken      = null;
  #refreshToken     = null;
  #tokenExpiry      = 0;
  #installationId   = null;
  #fingerprint      = null;
  #features         = [];
  #tier             = 'none';
  #heartbeatTimer        = null;
  #initialHeartbeatTimer = null;
  #lastHeartbeat         = 0;
  #gracePeriodMs    = 5 * 60 * 1000;
  #degraded         = false;
  #rsaPublicKey     = null;

  static get instance() {
    if (!this.#instance) this.#instance = new HopefinderLicenseClient();
    return this.#instance;
  }

  async initialize() {
    this.#installationId = this.#getOrCreateInstallationId();
    this.#fingerprint    = await this.#computeFingerprint();
    this.#loadStoredTokens();

    if (this.#accessToken && this.#isAccessTokenValid()) {
      try {
        await this.#loadVerifiedClaims();
      } catch {
        this.#clearStoredTokens();
        return false;
      }
      this.#startHeartbeat();
      return true;
    }

    if (this.#refreshToken) {
      try {
        await this.#doRefresh();
        this.#startHeartbeat();
        return true;
      } catch (e) {
        // A transient outage must never destroy a valid licence: keep the
        // credentials so the heartbeat can recover once the server is back.
        // The unconditional clear here meant that loading a world while
        // offline cost the GM their licence and a full re-authorisation.
        if (this.#isTransient(e)) {
          this.#startHeartbeat();
          return false;
        }
        this.#clearStoredTokens();
      }
    }

    return false;
  }

  hasFeature(featureName) {
    if (this.#degraded) return false;
    if (!this.#accessToken || !this.#isAccessTokenValid()) return false;
    return this.#features.includes(featureName);
  }

  get tier() { return this.#tier; }
  get isLicensed() { return this.#tier !== 'none' && !this.#degraded; }

  async startOAuth() {
    const { url } = await this.#apiCall('/oauth/start', { origin: globalThis.location.origin, moduleId: OWN_MODULE_ID });
    const popup   = window.open(url, 'vnd-patreon-auth', 'width=600,height=700,popup=yes');

    return new Promise((resolve, reject) => {
      const expectedOrigin = new URL(API_BASE).origin;

      const handler = async (event) => {
        if (event.origin !== expectedOrigin) return;
        if (event.data?.type !== 'vnd-auth-code') return;
        window.removeEventListener('message', handler);
        popup?.close();
        try {
          await this.activateWithCode(event.data.authCode);
          resolve(true);
        } catch (e) {
          reject(e);
        }
      };
      window.addEventListener('message', handler);

      const interval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(interval);
          window.removeEventListener('message', handler);
          resolve(false);
        }
      }, 1000);
    });
  }

  async activateWithCode(authCode) {
    const result = await this.#apiCall('/oauth/exchange', {
      authCode,
      installationId:  this.#installationId,
      fingerprintHash: this.#fingerprint,
      moduleId:        OWN_MODULE_ID
    });

    this.#storeTokens(result.accessToken, result.refreshToken, result.expiresIn, result.tier, result.features);
    this.#tier     = result.tier;
    this.#features = result.features ?? [];
    this.#startHeartbeat();
    Hooks.callAll('hopefinder-sheet.activate');
    game.settings?.set?.(OWN_MODULE_ID, 'worldLicensed', true).catch(() => {});
    ui.notifications?.info(`Hopefinder Survivor Sheet: Connected as ${result.tier} subscriber. Welcome!`);
  }

  async releaseInstallation() {
    try {
      await this.#apiCall('/license/release', { installationId: this.#installationId });
      this.#clearStoredTokens();
      this.#stopHeartbeat();
      game.settings?.set?.(OWN_MODULE_ID, 'worldLicensed', false).catch(() => {});
      ui.notifications?.info('Hopefinder Survivor Sheet: Installation slot released.');
    } catch (e) {
      ui.notifications?.error(`Hopefinder Survivor Sheet: Failed to release slot — ${e.message}`);
    }
  }

  #loadStoredTokens() {
    this.#accessToken  = localStorage.getItem(SK.accessToken);
    this.#refreshToken = localStorage.getItem(SK.refreshToken);
    this.#tokenExpiry  = Number.parseInt(localStorage.getItem(SK.tokenExpiry) ?? '0', 10);
    const rawFeatures  = JSON.parse(localStorage.getItem(SK.features) ?? '[]');
    this.#features     = Array.isArray(rawFeatures) ? rawFeatures : [];
    this.#tier         = localStorage.getItem(SK.tier) ?? 'none';
  }

  #storeTokens(at, rt, expiresIn, tier, features) {
    const expiry = Date.now() + expiresIn * 1000;
    this.#accessToken  = at;
    this.#refreshToken = rt;
    this.#tokenExpiry  = expiry;
    this.#tier         = tier;
    this.#features     = features ?? [];

    localStorage.setItem(SK.accessToken,  at);
    localStorage.setItem(SK.refreshToken, rt);
    localStorage.setItem(SK.tokenExpiry,  String(expiry));
    localStorage.setItem(SK.tier,         tier);
    localStorage.setItem(SK.features,     JSON.stringify(features ?? []));
  }

  #clearStoredTokens() {
    this.#accessToken  = null;
    this.#refreshToken = null;
    this.#tokenExpiry  = 0;
    this.#tier         = 'none';
    this.#features     = [];
    Object.values(SK).forEach(k => localStorage.removeItem(k));
  }

  #isAccessTokenValid() {
    return !!this.#accessToken && this.#tokenExpiry > Date.now() + 60_000;
  }

  async #loadVerifiedClaims() {
    const claims    = await this.#verifyAndParseJwt(this.#accessToken);
    this.#tier      = claims.tier     ?? 'none';
    this.#features  = claims.features ?? [];
  }

  #getOrCreateInstallationId() {
    let iid = localStorage.getItem(SK.installationId);
    if (!iid) {
      iid = crypto.randomUUID();
      localStorage.setItem(SK.installationId, iid);
    }
    return iid;
  }

  async #computeFingerprint() {
    const components = [
      game.world?.id ?? 'unknown',
      game.version ?? '',
      this.#installationId,
      navigator.language,
      navigator.hardwareConcurrency,
      screen.width, screen.height, screen.colorDepth,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      await this.#canvasFingerprint()
    ].join('|');

    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(components));
    return btoa(String.fromCodePoint(...new Uint8Array(buf)));
  }

  async #canvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 50;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('vnd-fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('vnd-fp', 4, 17);
      return canvas.toDataURL().slice(-32);
    } catch { return 'no-canvas'; }
  }

  // Serialises token rotation. The server revokes the old refresh token the
  // moment it is used and treats a second presentation as reuse — a critical
  // SECURITY_VIOLATION that revokes the whole token family. Two overlapping
  // refreshes were enough to trigger it and push the GM back through Patreon.
  #refreshInFlight = null;

  async #doRefresh() {
    this.#refreshInFlight ??= this.#doRefreshOnce()
      .finally(() => { this.#refreshInFlight = null; });
    return this.#refreshInFlight;
  }

  // Transport hiccups are safe to retry and must never destroy tokens;
  // anything else is a definitive verdict from the licence server.
  #isTransient(e) {
    if (!(e instanceof HopefinderLicenseError)) return true;
    return ['NETWORK_ERROR', 'INTERNAL_ERROR', 'RATE_LIMITED', 'NOT_FOUND', 'API_ERROR'].includes(e.code);
  }

  async #doRefreshOnce() {
    const result = await this.#apiCall('/token/refresh', {
      refreshToken:    this.#refreshToken,
      fingerprintHash: this.#fingerprint
    });
    this.#storeTokens(result.accessToken, result.refreshToken, result.expiresIn, result.tier, result.features);
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    const INTERVAL = 15 * 60 * 1000;
    this.#lastHeartbeat = Date.now();
    this.#initialHeartbeatTimer = setTimeout(() => {
      this.#initialHeartbeatTimer = null;
      this.#doHeartbeat();
    }, 60_000);
    this.#heartbeatTimer = setInterval(() => this.#doHeartbeat(), INTERVAL);
  }

  #stopHeartbeat() {
    if (this.#initialHeartbeatTimer) {
      clearTimeout(this.#initialHeartbeatTimer);
      this.#initialHeartbeatTimer = null;
    }
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  async #doHeartbeat() {
    try {
      const result = await this.#apiCall('/heartbeat', {
        installationId:  this.#installationId,
        fingerprintHash: this.#fingerprint
      });
      this.#storeTokens(result.accessToken, this.#refreshToken, result.expiresIn, result.tier, result.features);
      this.#lastHeartbeat = Date.now();
      this.#degraded = false;
    } catch {
      this.#handleHeartbeatFailure();
    }
  }

  #handleHeartbeatFailure() {
    const timeSinceLast = Date.now() - this.#lastHeartbeat;
    if (timeSinceLast > this.#gracePeriodMs) {
      if (!this.#degraded) {
        this.#degraded = true;
        if (game.user?.isGM) {
          game.settings?.set?.(OWN_MODULE_ID, 'worldLicensed', false).catch(() => {});
          ui.notifications?.warn('Hopefinder Survivor Sheet: License server unreachable. Sheet locked until reconnected.');
        }
      }
    }
  }

  async #apiCall(endpoint, body, method = 'POST') {
    const nonce     = crypto.randomUUID();
    const timestamp = Date.now();

    const init = {
      method,
      headers: {
        'Content-Type':       'application/json',
        'X-Installation-ID':  this.#installationId ?? '',
      }
    };

    if (this.#accessToken) init.headers['Authorization'] = `Bearer ${this.#accessToken}`;
    if (method === 'POST' && body !== null) init.body = JSON.stringify({ ...body, nonce, timestamp });

    const url  = `${API_BASE}${endpoint}`;
    // fetch() rejects on DNS failure / offline / server down — a transport
    // problem, never an auth verdict. Callers must not burn tokens over it.
    let resp;
    try {
      resp = await fetch(url, init);
    } catch {
      throw new HopefinderLicenseError('License server unreachable', 'NETWORK_ERROR');
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Network error', code: 'NETWORK_ERROR' }));
      throw new HopefinderLicenseError(err.error ?? 'Request failed', err.code ?? 'API_ERROR');
    }

    const data = await resp.json();

    if (data.sig && data.payload) {
      await this.#verifyResponseSig(data.payload, data.sig);
      return data.payload;
    }

    return data;
  }

  async #importRsaPublicKey() {
    if (this.#rsaPublicKey) return this.#rsaPublicKey;
    const keyBytes = Uint8Array.from(
      atob(RSA_PUBLIC_KEY.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.codePointAt(0)
    );
    this.#rsaPublicKey = await crypto.subtle.importKey(
      'spki', keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    return this.#rsaPublicKey;
  }

  async #verifyResponseSig(payload, jwt) {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new HopefinderLicenseError('Malformed response token', 'SIGNATURE_INVALID');

    const [hdr, body, sig] = parts;
    const key  = await this.#importRsaPublicKey();
    const data = new TextEncoder().encode(`${hdr}.${body}`);
    const sigBytes = Uint8Array.from(
      atob(sig.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.codePointAt(0)
    );

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, data);
    if (!valid) throw new HopefinderLicenseError('Server response verification failed', 'SIGNATURE_INVALID');

    const claims = JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')));
    const now    = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) throw new HopefinderLicenseError('Response token expired', 'REPLAY_DETECTED');

    const payloadHash = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(JSON.stringify(payload))
    );
    const expectedPh = btoa(String.fromCodePoint(...new Uint8Array(payloadHash)))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    if (claims.ph !== expectedPh) throw new HopefinderLicenseError('Response payload tampered', 'SIGNATURE_INVALID');
  }

  async #verifyAndParseJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new HopefinderLicenseError('Malformed JWT', 'INVALID_TOKEN');

    const [hdr, body, sig] = parts;
    const key  = await this.#importRsaPublicKey();
    const data = new TextEncoder().encode(`${hdr}.${body}`);
    const sigBytes = Uint8Array.from(
      atob(sig.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.codePointAt(0)
    );

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, data);
    if (!valid) throw new HopefinderLicenseError('JWT signature invalid', 'INVALID_TOKEN');

    const payload = JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) throw new HopefinderLicenseError('JWT expired', 'TOKEN_EXPIRED');
    return payload;
  }
}

export class HopefinderLicenseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HopefinderLicenseError';
    this.code = code;
  }
}

export class HopefinderLicenseUI {
  static show() {
    if (!game.user?.isGM) return;

    const id = 'hopefinder-sheet-license-prompt';
    if (document.getElementById(id)) return;

    const el = document.createElement('div');
    el.id = id;
    el.className = 'hf-license-widget';
    el.innerHTML = `
      <div class="hf-license-widget-head">
        <i class="fas fa-lock"></i>
        <strong>Hopefinder Survivor Sheet</strong>
      </div>
      <p class="hf-license-widget-body">
        Connect your Patreon account to unlock the character sheet.
      </p>
      <div style="margin-bottom:12px;padding:10px 12px;border-radius:6px;
                  border:1px solid #c89b3c55;background:#c89b3c14;font-size:.85rem;line-height:1.45">
        <strong style="color:#c89b3c">Why am I being asked to reconnect?</strong><br/>
        We changed how Patreon subscriptions are verified, so activations made before the change no longer validate. Reconnecting your account once puts it right. This is not a new charge and not a price change: your Patreon subscription is untouched, you will not be billed again, and you keep your installation slots. Only the authorisation is renewed.
      </div>
      <div class="hf-license-widget-actions">
        <button type="button" class="hf-btn hf-license-widget-connect">Connect Patreon</button>
        <button type="button" class="hf-btn hf-btn--ghost hf-license-widget-code">I have an auth code</button>
        <button type="button" class="hf-license-widget-dismiss">Dismiss</button>
      </div>
    `;

    el.querySelector('.hf-license-widget-connect').addEventListener('click', async () => {
      const btn = el.querySelector('.hf-license-widget-connect');
      btn.textContent = 'Opening Patreon...';
      btn.disabled = true;
      try {
        const success = await HopefinderLicenseClient.instance.startOAuth();
        if (success) el.remove();
        else { btn.textContent = 'Connect Patreon'; btn.disabled = false; }
      } catch (e) {
        btn.textContent = 'Connect Patreon'; btn.disabled = false;
        ui.notifications?.error(`Hopefinder Survivor Sheet: ${e.message}`);
      }
    });

    el.querySelector('.hf-license-widget-code').addEventListener('click', () => {
      HopefinderLicenseUI.showCodeInput();
      el.remove();
    });

    el.querySelector('.hf-license-widget-dismiss').addEventListener('click', () => el.remove());

    document.body.appendChild(el);
  }

  static showCodeInput() {
    const D2 = foundry.applications?.api?.DialogV2;
    const content = `
      <div style="margin-bottom:12px;padding:10px 12px;border-radius:6px;
                  border:1px solid #c89b3c55;background:#c89b3c14;font-size:.85rem;line-height:1.45">
        <strong style="color:#c89b3c">Why am I being asked to reconnect?</strong><br/>
        We changed how Patreon subscriptions are verified, so activations made before the change no longer validate. Reconnecting your account once puts it right. This is not a new charge and not a price change: your Patreon subscription is untouched, you will not be billed again, and you keep your installation slots. Only the authorisation is renewed.
      </div>
      <p style="margin-bottom:12px;font-size:.9rem">
        Paste the code shown after connecting your Patreon account.
      </p>
      <input id="hf-auth-code-input" type="text" class="hf-license-code-input"
        placeholder="Paste auth code here..."/>
    `;

    const activate = async code => {
      if (!code) return;
      try {
        await HopefinderLicenseClient.instance.activateWithCode(code);
      } catch (e) {
        ui.notifications?.error(`Hopefinder Survivor Sheet: ${e.message}`);
      }
    };

    if (D2) {
      D2.wait({
        window: { title: 'Hopefinder Survivor Sheet — Enter Auth Code' },
        content,
        buttons: [{
          action: 'activate',
          label: 'Activate',
          icon: 'fas fa-key',
          callback: (event, button) => button.form.querySelector('#hf-auth-code-input').value.trim()
        }, { action: 'cancel', label: 'Cancel' }],
        rejectClose: false
      }).then(result => { if (result && result !== 'cancel') activate(result); });
      return;
    }

    new Dialog({
      title: 'Hopefinder Survivor Sheet — Enter Auth Code',
      content,
      buttons: {
        activate: {
          label: '<i class="fas fa-key"></i> Activate',
          callback: html => activate(html.find('#hf-auth-code-input').val().trim())
        },
        cancel: { label: 'Cancel' }
      }
    }).render(true, { width: 420 });
  }
}
