/**
 * Yarbo Smart Vision card: plays the robot's live camera feed in a dashboard.
 *
 *   type: custom:yarbo-smart-vision-card
 *   sn: <robot serial number>
 *   max_minutes: 5     # optional, stops the feed automatically
 *   mode: live         # optional, Agora channel mode: live or rtc
 *
 * The feed only runs after pressing Start, and stops when the card leaves the
 * screen or the time limit is reached: Smart Vision uses the robot's battery, and
 * its monthly allowance when it is on 4G.
 */
const AGORA_SDK_URL =
  "https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@4.24.9/AgoraRTC_N-production.js";
const AGORA_SDK_INTEGRITY =
  "sha384-Qs9FiOQ2W7uHpqsCgOvkWGtIkVwMN4FCnMcOE0Wp0RdGw1kk0BON1p6phuDG4ImM";
const ENCRYPTION_MODE = "aes-128-gcm2";
const DEFAULT_MAX_MINUTES = 5;
const NO_VIDEO_TIMEOUT_MS = 20000;

let agoraSdkPromise;

function loadAgoraSdk() {
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
  if (!agoraSdkPromise) {
    agoraSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = AGORA_SDK_URL;
      script.integrity = AGORA_SDK_INTEGRITY;
      script.crossOrigin = "anonymous";
      script.onload = () => {
        window.AgoraRTC.setLogLevel(3);
        window.AgoraRTC.disableLogUpload();
        resolve(window.AgoraRTC);
      };
      script.onerror = () => {
        agoraSdkPromise = undefined;
        reject(new Error("Could not load the Agora video SDK."));
      };
      document.head.appendChild(script);
    });
  }
  return agoraSdkPromise;
}

function decodeSalt(salt) {
  try {
    return Uint8Array.from(atob(salt), (char) => char.charCodeAt(0));
  } catch (err) {
    throw new Error("The Yarbo video service sent an unreadable encryption salt.");
  }
}

class YarboSmartVisionCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._session = 0;
    this._client = null;
    this._timers = [];
    this._onVisibilityChange = () => {
      if (document.hidden && this._client) this._stop();
    };
  }

  static getStubConfig() {
    return { sn: "" };
  }

  setConfig(config) {
    if (!config.sn) throw new Error("Set sn to the robot's serial number.");
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  getCardSize() {
    return 5;
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this._stop();
  }

  _render() {
    // embedded: true drops the card frame, for use inside the Yarbo card.
    const frame = this._config.embedded ? "div" : "ha-card";
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { display: block; padding: 16px; }
        .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .title { font-size: 1.2em; }
        .videos { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
        .videos:not(:empty) { margin-top: 12px; }
        .tile {
          aspect-ratio: 16 / 9; background: #000; overflow: hidden;
          border-radius: var(--yarbo-tile-radius, 8px);
        }
        .status { margin-top: 12px; color: var(--secondary-text-color); }
        .status:empty { display: none; }
        button {
          padding: 8px 16px; border: none; cursor: pointer; font: inherit;
          border-radius: var(--yarbo-button-radius, 8px);
          background: var(--primary-color); color: var(--text-primary-color);
        }
        button:disabled { opacity: 0.5; cursor: default; }
      </style>
      <${frame}>
        <div class="header">
          <span class="title"></span>
          <button type="button">Start</button>
        </div>
        <div class="videos"></div>
        <div class="status" role="status"></div>
      </${frame}>
    `;
    this._button = this.shadowRoot.querySelector("button");
    this._videos = this.shadowRoot.querySelector(".videos");
    this._status = this.shadowRoot.querySelector(".status");
    this.shadowRoot.querySelector(".title").textContent = this._config.title || "Smart Vision";
    this._button.addEventListener("click", () => {
      if (this._client) this._stop();
      else this._start();
    });
  }

  _setStatus(text) {
    this._status.textContent = text;
  }

  _setButton(label, disabled = false) {
    this._button.textContent = label;
    this._button.disabled = disabled;
  }

  _fetchCredentials() {
    return this._hass.callWS({
      type: "yarbo/smart_vision/credentials",
      sn: this._config.sn,
    });
  }

  async _start() {
    const session = ++this._session;
    this._setButton("Connecting", true);
    this._setStatus("");

    let client;
    try {
      const credentials = await this._fetchCredentials();
      const AgoraRTC = await loadAgoraSdk();
      if (session !== this._session) return;

      const mode = this._config.mode || "live";
      client = AgoraRTC.createClient({ mode, codec: "vp8" });
      this._client = client;
      this._attachClientEvents(client, session);
      if (mode === "live") await client.setClientRole("audience");
      if (credentials.encrypt_key && credentials.encrypt_salt) {
        client.setEncryptionConfig(
          ENCRYPTION_MODE,
          credentials.encrypt_key,
          decodeSalt(credentials.encrypt_salt)
        );
      }
      await client.join(
        credentials.app_id,
        credentials.channel,
        credentials.token,
        credentials.uid ?? null
      );
      if (session !== this._session) {
        await client.leave();
        return;
      }

      this._setButton("Stop");
      this._setStatus("Connected, waiting for video.");
      this._startTimers(session);
    } catch (err) {
      if (session !== this._session) return;
      await this._stop();
      this._setStatus(
        err && err.code === "unauthorized"
          ? "Only Home Assistant admins can open this feed."
          : (err && err.message) || "The feed could not be started."
      );
    }
  }

  _attachClientEvents(client, session) {
    client.on("user-published", async (user, mediaType) => {
      if (mediaType !== "video") return;
      try {
        await client.subscribe(user, "video");
        if (session !== this._session) return;
        this._showVideo(user);
      } catch (err) {
        if (session === this._session) this._setStatus(err.message);
      }
    });
    client.on("user-unpublished", (user, mediaType) => {
      if (mediaType !== "video" || session !== this._session) return;
      this._removeVideo(user);
      if (!this._videos.children.length) this._setStatus("The robot stopped sending video.");
    });
    client.on("token-privilege-will-expire", async () => {
      try {
        const credentials = await this._fetchCredentials();
        if (session === this._session) await client.renewToken(credentials.token);
      } catch (err) {
        if (session === this._session) this._setStatus(err.message);
      }
    });
    client.on("token-privilege-did-expire", async () => {
      if (session !== this._session) return;
      await this._stop();
      this._setStatus("The video session expired. Press Start to continue.");
    });
    client.on("connection-state-change", async (state, previous, reason) => {
      if (state !== "DISCONNECTED" || reason === "LEAVE" || session !== this._session) return;
      await this._stop();
      this._setStatus(`The feed was disconnected${reason ? ` (${reason})` : ""}.`);
    });
  }

  _startTimers(session) {
    const maxMinutes = this._config.max_minutes ?? DEFAULT_MAX_MINUTES;
    this._timers.push(
      setTimeout(() => {
        if (session !== this._session || this._videos.children.length) return;
        this._setStatus(
          "Connected, but the robot isn't sending video. It may be asleep, or Smart Vision may be unavailable on its connection."
        );
      }, NO_VIDEO_TIMEOUT_MS),
      setTimeout(async () => {
        if (session !== this._session) return;
        await this._stop();
        this._setStatus(`Stopped after ${maxMinutes} minutes. Press Start to continue.`);
      }, maxMinutes * 60000)
    );
  }

  _showVideo(user) {
    this._removeVideo(user);
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.uid = String(user.uid);
    this._videos.appendChild(tile);
    user.videoTrack.play(tile, { fit: "contain" });
    this._setStatus("");
  }

  _removeVideo(user) {
    if (user.videoTrack) user.videoTrack.stop();
    for (const tile of this._videos.children) {
      if (tile.dataset.uid === String(user.uid)) tile.remove();
    }
  }

  async _stop() {
    this._session++;
    this._timers.forEach(clearTimeout);
    this._timers = [];
    const client = this._client;
    this._client = null;
    if (this._videos) this._videos.replaceChildren();
    if (this._button) this._setButton("Start");
    if (this._status) this._setStatus("");
    if (!client) return;
    try {
      client.removeAllListeners();
      await client.leave();
    } catch (err) {
      console.warn("Yarbo Smart Vision: leaving the channel failed", err);
    }
  }
}

customElements.define("yarbo-smart-vision-card", YarboSmartVisionCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "yarbo-smart-vision-card",
  name: "Yarbo Smart Vision",
  description: "Live camera feed from a Yarbo robot.",
});
