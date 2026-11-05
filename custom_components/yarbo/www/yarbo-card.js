/**
 * Yarbo card: a robot's status and controls, laid out like the Yarbo app.
 *
 *   type: custom:yarbo-card
 *   device_id: <Yarbo device>   # picked in the card editor (or use sn: <serial>)
 *   name: Yard Master           # optional, defaults to the device name
 *   appearance: app             # app (dark, like the Yarbo app) or theme
 *   show_map: true              # optional, the work-zone map tab
 *   show_live: true             # optional, the Smart Vision tab (admins only)
 *   image: /local/yarbo.png     # optional, replaces the drawing of the robot
 *   live_max_minutes: 5         # optional, stops the live camera automatically
 *
 * Entities are found through the integration's yarbo/devices command, by their
 * unique IDs, so the card keeps working after entity IDs are renamed.
 */

const DEFAULTS = { appearance: "app", show_map: true, show_live: true };

// Keys are "<domain>.<unique ID without the serial prefix>", see websocket_api.py.
const KEYS = {
  online: "binary_sensor.online",
  battery: "sensor.batterymsg_capacity",
  charging: "binary_sensor.batterymsg_status",
  planStatus: "sensor.statemsg_on_going_planning",
  pauseStatus: "sensor.statemsg_planning_paused",
  rechargeStatus: "sensor.statemsg_on_going_recharging",
  stuck: "binary_sensor.statemsg_stuck",
  errorCode: "sensor.statemsg_error_code",
  headType: "sensor.headmsg_head_type",
  network: "sensor.route_priority",
  wifi: "sensor.wifiinfo_signal",
  lte: "sensor.net_module_status_lte_rssi",
  halow: "sensor.halow_status_strength",
  rtk: "sensor.rtkmsg_status",
  rain: "binary_sensor.mower_head_info01_rain_sensor",
  headLight: "switch.ledinfomsg_led_head_switch",
  plan: "select.plan_select",
  start: "button.start_plan",
  pause: "button.pause_plan",
  resume: "button.resume_plan",
  stop: "button.stop_plan",
  dock: "button.recharge",
  findMe: "button.action_play_sound_button",
  refreshMap: "button.refresh_map_data",
  mapZones: "sensor.map_zones",
  tracker: "device_tracker.device_tracker",
};

const PLAN_ACTIVE = {
  Cleaning: "Working",
  "Calculating Route": "Planning route",
  "Heading to Area": "Heading to area",
  "Waypoint Navigation": "Navigating",
};
const RETURNING = new Set(["Returning on Path", "Returning in Area", "Repositioning", "Verifying"]);
const NETWORK_LABELS = { Wifi: "Wi-Fi", "4G": "4G", Halow: "HaLow" };
const MISSING = new Set(["unavailable", "unknown", ""]);
const STOP_CONFIRM_MS = 4000;

const TONES = {
  working: "var(--yc-yellow)",
  paused: "var(--yc-yellow)",
  returning: "var(--yc-yellow)",
  charging: "var(--yc-lime)",
  error: "var(--yc-red)",
};
const TONE_INKS = {
  working: "var(--yc-ink-yellow)",
  paused: "var(--yc-ink-yellow)",
  returning: "var(--yc-ink-yellow)",
  charging: "var(--yc-ink-lime)",
  error: "var(--yc-ink-red)",
};

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function icon(name) {
  return `<ha-icon icon="${name}"></ha-icon>`;
}

function headKind(headType) {
  switch (headType) {
    case "Mower":
    case "Mower Pro":
      return "mower";
    case "Snow Blower":
      return "snow";
    case "Blower":
      return "blower";
    case "Smart Cover":
      return "cover";
    default:
      return "none";
  }
}

function signalBars(rssi) {
  if (!Number.isFinite(rssi)) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

// ---- Drawing of the robot ---------------------------------------------------

const HEADS = {
  mower: `
    <path class="rb-arm" d="M244 118 L262 134"/>
    <path class="rb-body" d="M252 132 H318 Q338 132 344 148 L348 160 Q350 172 338 172 H252 Z"/>
    <path class="rb-lid" d="M252 132 H318 Q338 132 344 148 H252 Z"/>
    <rect class="rb-yellow" x="268" y="154" width="50" height="6" rx="3"/>
    <circle class="rb-tire" cx="336" cy="170" r="6"/>`,
  snow: `
    <path class="rb-chute" d="M300 104 C300 82 302 66 314 56 L330 50"/>
    <path class="rb-yellow" d="M326 42 L342 48 L333 57 Z"/>
    <rect class="rb-body" x="258" y="104" width="66" height="66" rx="12"/>
    <rect class="rb-yellow" x="268" y="114" width="46" height="46" rx="10"/>
    <circle class="rb-body" cx="291" cy="137" r="13"/>
    <path class="rb-spiral" d="M291 126 a11 11 0 0 1 0 22 a7 7 0 0 1 0 -14"/>
    <rect class="rb-steel" x="254" y="167" width="76" height="5" rx="2.5"/>`,
  blower: `
    <rect class="rb-body" x="258" y="100" width="50" height="56" rx="12"/>
    <circle class="rb-yellow" cx="283" cy="126" r="17"/>
    <circle class="rb-body" cx="283" cy="126" r="9"/>
    <path class="rb-spoke" d="M283 117 V135 M274 126 H292"/>
    <path class="rb-lid" d="M296 148 L344 164 Q351 167 348 174 L300 172 Q291 170 292 160 Z"/>`,
  cover: `
    <path class="rb-lid" d="M96 62 V44 Q96 36 104 36 H210 Q218 36 218 44 V62 Z"/>
    <rect class="rb-yellow" x="112" y="44" width="62" height="5" rx="2.5"/>
    <rect class="rb-lid" x="254" y="96" width="10" height="30" rx="4"/>`,
  none: `<rect class="rb-lid" x="254" y="96" width="10" height="30" rx="4"/>`,
};

function robotSvg(kind, { moving, light }) {
  return `
    <svg viewBox="20 20 340 162" role="img" aria-label="Yarbo robot">
      <defs>
        <radialGradient id="yc-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" style="stop-color: var(--yc-tone, transparent); stop-opacity: 0.55"/>
          <stop offset="1" style="stop-color: var(--yc-tone, transparent); stop-opacity: 0"/>
        </radialGradient>
        <linearGradient id="yc-beam" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#fff8d6" stop-opacity="0.75"/>
          <stop offset="1" stop-color="#fff8d6" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <ellipse cx="190" cy="172" rx="170" ry="24" fill="url(#yc-glow)"/>
      <ellipse class="rb-shadow" cx="190" cy="175" rx="150" ry="6"/>
      ${light ? `<polygon class="rb-beam" points="256,105 360,74 360,144" fill="url(#yc-beam)"/>` : ""}
      <line class="rb-antenna" x1="86" y1="66" x2="86" y2="30"/>
      <line class="rb-antenna" x1="104" y1="64" x2="104" y2="42"/>
      <circle class="rb-tip" cx="86" cy="30" r="3"/>
      <circle class="rb-tip" cx="104" cy="42" r="3"/>
      <rect class="rb-track" x="40" y="120" width="220" height="52" rx="26"/>
      <rect class="rb-tread${moving ? " moving" : ""}" x="43" y="123" width="214" height="46" rx="23"/>
      <circle class="rb-wheel" cx="66" cy="146" r="18"/>
      <circle class="rb-wheel" cx="234" cy="146" r="18"/>
      <circle class="rb-hub" cx="66" cy="146" r="6"/>
      <circle class="rb-hub" cx="234" cy="146" r="6"/>
      <circle class="rb-roller" cx="110" cy="158" r="6"/>
      <circle class="rb-roller" cx="150" cy="158" r="6"/>
      <circle class="rb-roller" cx="190" cy="158" r="6"/>
      <rect class="rb-cover" x="96" y="133" width="108" height="20" rx="10"/>
      <line class="rb-stripe" x1="110" y1="143" x2="190" y2="143"/>
      <rect class="rb-body" x="54" y="84" width="200" height="42" rx="12"/>
      <rect class="rb-yellow" x="168" y="90" width="82" height="32" rx="9"/>
      <rect class="rb-vent" x="182" y="98" width="4" height="16" rx="2"/>
      <rect class="rb-vent" x="192" y="98" width="4" height="16" rx="2"/>
      <rect class="rb-vent" x="202" y="98" width="4" height="16" rx="2"/>
      <rect class="rb-yellow" x="62" y="94" width="26" height="8" rx="4"/>
      <path class="rb-lid" d="M70 86 Q76 64 100 62 H214 Q240 62 248 86 Z"/>
      <path class="rb-shine" d="M94 70 Q102 66 112 66 H208"/>
      <rect class="rb-estop" x="140" y="55" width="24" height="9" rx="3"/>
      <rect class="rb-camera" x="236" y="70" width="12" height="11" rx="4"/>
      <circle class="rb-lens" cx="242" cy="75.5" r="2.6"/>
      <rect class="rb-led${light ? " on" : ""}" x="246" y="102" width="8" height="6" rx="2"/>
      ${HEADS[kind] || HEADS.none}
    </svg>`;
}

// ---- Work-zone map ------------------------------------------------------------

const MAP_W = 360;
const MAP_H = 225;
const MAP_PAD = 16;
const POLYGON_CLASSES = { areas: "area", nogozones: "nogo", novisionzones: "novision", elec_fence: "fence" };
const POLYGON_ORDER = ["elec_fence", "areas", "novisionzones", "nogozones"];

function mapSvg(geojson, robot) {
  const features = (geojson && geojson.features) || [];
  const coords = [];
  const collect = (c) => {
    if (typeof c[0] === "number") coords.push(c);
    else c.forEach(collect);
  };
  features.forEach((f) => f.geometry && collect(f.geometry.coordinates));
  if (robot) coords.push(robot);
  if (!coords.length) return "";

  const lat0 = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = coords.map((c) => c[0] * k);
  const ys = coords.map((c) => -c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(Math.max(...xs) - minX, 1e-7);
  const h = Math.max(Math.max(...ys) - minY, 1e-7);
  const scale = Math.min((MAP_W - 2 * MAP_PAD) / w, (MAP_H - 2 * MAP_PAD) / h);
  const offX = (MAP_W - w * scale) / 2;
  const offY = (MAP_H - h * scale) / 2;
  const pt = (c) => [offX + (c[0] * k - minX) * scale, offY + (-c[1] - minY) * scale];
  const line = (ring) =>
    ring.map((c, i) => `${i ? "L" : "M"}${pt(c).map((n) => n.toFixed(1)).join(" ")}`).join("");

  const byType = (type) => features.filter((f) => f.properties && f.properties.zone_type === type);
  let shapes = "";
  const names = [];
  // Markers that zone names keep clear of: [x, y, radius].
  const markers = [];
  for (const type of POLYGON_ORDER) {
    for (const f of byType(type)) {
      if (!f.geometry || f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0] || [];
      shapes += `<path class="${POLYGON_CLASSES[type]}" d="${line(ring)}Z"/>`;
      const name = f.properties.name;
      if (type === "areas" && name && ring.length) {
        const [cx, cy] = pt([
          ring.reduce((s, c) => s + c[0], 0) / ring.length,
          ring.reduce((s, c) => s + c[1], 0) / ring.length,
        ]);
        names.push([cx, cy, String(name)]);
      }
    }
  }
  for (const type of ["pathways", "sidewalks", "deadends"]) {
    for (const f of byType(type)) {
      if (!f.geometry || f.geometry.type !== "LineString") continue;
      shapes += `<path class="path${type === "deadends" ? " deadend" : ""}" d="${line(f.geometry.coordinates)}"/>`;
    }
  }
  for (const f of byType("charging")) {
    if (!f.geometry || f.geometry.type !== "Point") continue;
    const [x, y] = pt(f.geometry.coordinates);
    markers.push([x, y, 10]);
    shapes += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="dock" r="8"/>
      <path class="dock-bolt" d="M1 -5 L-3 1 H0 L-1 5 L3 -1 H0 Z"/></g>`;
  }
  let robotMark = "";
  if (robot) {
    const [x, y] = pt(robot);
    markers.push([x, y, 14]);
    robotMark = `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
      <circle class="robot-pulse" r="12"/><circle class="robot-dot" r="6"/></g>`;
  }
  const labels = names
    .map(([x, y, name]) => {
      const ly = labelY(x, y, name, markers);
      return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}">${esc(name)}</text>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 ${MAP_W} ${MAP_H}" role="img" aria-label="Work-zone map">
      <defs>
        <pattern id="yc-grid" width="18" height="18" patternUnits="userSpaceOnUse">
          <path d="M18 0H0V18" class="grid"/>
        </pattern>
      </defs>
      <rect width="${MAP_W}" height="${MAP_H}" fill="url(#yc-grid)"/>
      ${shapes}${labels}${robotMark}
    </svg>`;
}

// Moves a zone name up or down until it clears the dock and the robot.
function labelY(x, y, name, markers) {
  const halfW = name.length * 3.2 + 3;
  const halfH = 7;
  const clear = (ly) =>
    ly - halfH >= 0 &&
    ly + halfH <= MAP_H &&
    markers.every(([mx, my, r]) => Math.abs(x - mx) >= halfW + r || Math.abs(ly - my) >= halfH + r);
  for (const dy of [0, -16, 16, -26, 26, -36, 36]) {
    if (clear(y + dy)) return y + dy;
  }
  return y;
}

// ---- Card ---------------------------------------------------------------------

const STYLE = `
  :host {
    display: block;
    --yc-yellow: #fcc419;
    --yc-on-yellow: #1c1700;
    --yc-lime: #b6f03d;
    --yc-red: #ff5f57;
    --yc-gray: #8b8c93;
  }
  :host([appearance="app"]) {
    --yc-bg: #0e0f12;
    --yc-surface: #1a1b20;
    --yc-surface-2: #26272d;
    --yc-line: rgba(255, 255, 255, 0.07);
    --yc-text: #f5f5f7;
    --yc-text-2: #9c9da4;
    --yc-fill: #e9e9ee;
    --yc-ink-yellow: var(--yc-yellow);
    --yc-ink-lime: var(--yc-lime);
    --yc-ink-red: var(--yc-red);
    --primary-text-color: var(--yc-text);
    --secondary-text-color: var(--yc-text-2);
    color-scheme: dark;
  }
  :host([appearance="theme"]) {
    --yc-bg: var(--ha-card-background, var(--card-background-color, #fff));
    --yc-surface: color-mix(in srgb, var(--primary-text-color, #212121) 5%, transparent);
    --yc-surface-2: color-mix(in srgb, var(--primary-text-color, #212121) 10%, transparent);
    --yc-line: var(--divider-color, rgba(127, 127, 127, 0.2));
    --yc-text: var(--primary-text-color, #212121);
    --yc-text-2: var(--secondary-text-color, #727272);
    --yc-fill: color-mix(in srgb, var(--primary-text-color, #212121) 35%, transparent);
    --yc-ink-yellow: color-mix(in srgb, var(--yc-yellow) 62%, var(--primary-text-color, #212121));
    --yc-ink-lime: color-mix(in srgb, #7fc21b 72%, var(--primary-text-color, #212121));
    --yc-ink-red: color-mix(in srgb, var(--yc-red) 78%, var(--primary-text-color, #212121));
  }
  ha-card {
    overflow: hidden;
    background: var(--yc-bg);
    color: var(--yc-text);
    container: yc / inline-size;
  }
  :host([appearance="app"]) ha-card {
    border: 1px solid var(--yc-line);
    font-family: Poppins, var(--ha-font-family-body, Roboto, sans-serif);
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px 18px 20px;
    background: radial-gradient(110% 60% at 38% 40%,
      color-mix(in srgb, var(--yc-tone, transparent) 16%, transparent), transparent 64%);
    transition: background 0.4s ease;
  }
  button, select { font: inherit; color: inherit; }
  button:focus-visible, select:focus-visible {
    outline: 2px solid var(--yc-yellow);
    outline-offset: 2px;
  }
  button:disabled { opacity: 0.38; cursor: not-allowed; box-shadow: none; }
  ha-icon { display: inline-flex; }

  /* Header */
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .title { min-width: 0; }
  .name {
    font-size: 1.45rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sub { margin-top: 4px; font-size: 0.82rem; line-height: 1.35; color: var(--yc-text-2); }
  .dot {
    display: inline-block; width: 7px; height: 7px; margin: 0 6px 1px 1px; vertical-align: middle;
    border-radius: 50%; background: var(--yc-gray);
  }
  .dot.on {
    background: var(--yc-lime);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--yc-lime) 22%, transparent);
  }
  .seg {
    display: flex; gap: 2px; padding: 3px; flex: none; border-radius: 999px;
    background: var(--yc-surface); border: 1px solid var(--yc-line);
  }
  .seg button {
    width: 38px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 999px;
    background: transparent; color: var(--yc-text-2); cursor: pointer; --mdc-icon-size: 18px;
    transition: background 0.2s, color 0.2s;
  }
  .seg button[aria-selected="true"] { background: var(--yc-text); color: var(--yc-bg); }

  /* Home view */
  .hero {
    display: grid; grid-template-columns: minmax(0, 1fr) 64px; align-items: center; gap: 12px;
  }
  .stage { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
  .robot { width: 100%; max-width: 380px; transition: filter 0.4s, opacity 0.4s; }
  .robot svg, .robot img {
    display: block; width: 100%; height: auto; max-height: 200px; object-fit: contain;
  }
  .robot.offline { filter: grayscale(1); opacity: 0.45; }
  .state { text-align: center; }
  .label { font-size: 1.1rem; font-weight: 600; color: var(--yc-tone-ink, var(--yc-text)); }
  .detail { margin-top: 2px; min-height: 1.2em; font-size: 0.82rem; color: var(--yc-text-2); }

  .rail { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .rail.offline { opacity: 0.55; }
  .tile {
    display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 0; border: 0;
    background: none; color: var(--yc-text-2); font-size: 0.68rem; cursor: pointer;
  }
  .tile-icon {
    position: relative; width: 44px; height: 44px; display: grid; place-items: center;
    border-radius: 50%; background: var(--yc-surface-2); border: 1px solid var(--yc-line);
    color: var(--yc-text); --mdc-icon-size: 20px;
  }
  .tile-icon[data-level]::after {
    content: ""; position: absolute; top: 1px; right: 1px; width: 9px; height: 9px;
    border-radius: 50%; border: 2px solid var(--yc-bg);
  }
  .tile-icon[data-level="good"]::after { background: var(--yc-lime); }
  .tile-icon[data-level="fair"]::after { background: var(--yc-yellow); }
  .tile-icon[data-level="poor"]::after { background: var(--yc-red); }

  .battery {
    --yc-fill-color: var(--yc-fill);
    width: 58px; height: 120px; padding: 0; display: flex; flex-direction: column; cursor: pointer;
    border-radius: 29px; background: var(--yc-surface-2); border: 1px solid var(--yc-line);
  }
  .battery.charging { --yc-fill-color: var(--yc-lime); }
  .battery.low { --yc-fill-color: var(--yc-red); }
  .battery-text {
    display: flex; flex-direction: column; align-items: center; padding: 10px 0 4px;
    line-height: 1.15;
  }
  .battery-value {
    display: flex; align-items: center; font-weight: 600; font-size: 0.95rem;
    --mdc-icon-size: 13px;
  }
  .battery-value small { font-size: 0.62rem; font-weight: 500; margin-left: 1px; }
  .battery-caption { font-size: 0.6rem; color: var(--yc-text-2); }
  .battery-track {
    position: relative; flex: 1; margin: 4px; overflow: hidden; border-radius: 25px;
    background: var(--yc-surface);
  }
  .battery-fill {
    position: absolute; left: 0; right: 0; bottom: 0; height: var(--level, 0%);
    border-radius: inherit; transition: height 0.6s ease, width 0.6s ease;
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--yc-fill-color) 55%, transparent), var(--yc-fill-color));
  }
  .battery.charging .battery-fill { animation: yc-breathe 2.4s ease-in-out infinite; }

  .banner {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 16px;
    font-size: 0.85rem; --mdc-icon-size: 18px;
    background: color-mix(in srgb, var(--yc-red) 14%, transparent); color: var(--yc-ink-red);
  }

  /* Map view */
  .map {
    position: relative; aspect-ratio: 16 / 10; display: grid; place-items: center; overflow: hidden;
    border-radius: 20px; background: var(--yc-surface); border: 1px solid var(--yc-line);
  }
  .map svg { display: block; width: 100%; height: 100%; }
  .map .grid { fill: none; stroke: var(--yc-text); stroke-opacity: 0.06; }
  .map .area {
    fill: color-mix(in srgb, var(--yc-yellow) 15%, transparent); stroke: var(--yc-yellow);
    stroke-width: 1.5; stroke-linejoin: round;
  }
  .map .nogo {
    fill: color-mix(in srgb, var(--yc-red) 22%, transparent); stroke: var(--yc-red); stroke-width: 1.2;
  }
  .map .novision {
    fill: color-mix(in srgb, var(--yc-text-2) 20%, transparent); stroke: var(--yc-text-2);
    stroke-dasharray: 3 3;
  }
  .map .fence { fill: none; stroke: var(--yc-text-2); stroke-width: 1.2; stroke-dasharray: 6 4; }
  .map .path {
    fill: none; stroke: var(--yc-text); stroke-opacity: 0.55; stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .map .deadend { stroke-dasharray: 2 4; }
  .map .dock { fill: var(--yc-lime); stroke: var(--yc-bg); stroke-width: 2; }
  .map .dock-bolt { fill: #10140a; }
  .map .robot-dot { fill: var(--yc-yellow); stroke: #fff; stroke-width: 2.5; }
  .map .robot-pulse {
    fill: var(--yc-yellow); opacity: 0.3; transform-box: fill-box; transform-origin: center;
    animation: yc-ping 1.8s ease-out infinite;
  }
  .map text {
    font-size: 10px; font-weight: 600; fill: var(--yc-text); text-anchor: middle;
    dominant-baseline: middle; paint-order: stroke; stroke: var(--yc-bg); stroke-width: 3px;
    stroke-linejoin: round;
  }
  .map-empty {
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px;
    text-align: center; font-size: 0.88rem; color: var(--yc-text-2); --mdc-icon-size: 32px;
  }
  .map-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px;
    font-size: 0.78rem; color: var(--yc-text-2);
  }

  /* Live view */
  .live {
    --primary-color: var(--yc-yellow);
    --text-primary-color: var(--yc-on-yellow);
    --yarbo-button-radius: 999px;
    --yarbo-tile-radius: 16px;
    padding: 14px 16px; border-radius: 20px;
    background: var(--yc-surface); border: 1px solid var(--yc-line);
  }

  /* Action bar */
  .bar {
    position: relative; display: grid; grid-template-columns: 56px minmax(0, 1fr) 56px;
    column-gap: 10px; row-gap: 7px; margin: 0 8px;
  }
  .bar::before {
    content: ""; position: absolute; top: -8px; left: -8px; right: -8px; height: 72px;
    border-radius: 36px; background: var(--yc-surface); border: 1px solid var(--yc-line);
  }
  .bar > * { position: relative; }
  .round {
    width: 56px; height: 56px; display: grid; place-items: center; padding: 0; border: 0;
    border-radius: 50%; background: var(--yc-surface-2); color: var(--yc-text); cursor: pointer;
    --mdc-icon-size: 26px; transition: transform 0.12s ease, box-shadow 0.2s;
  }
  .round.primary {
    background: var(--yc-yellow); color: var(--yc-on-yellow);
    box-shadow: 0 6px 18px color-mix(in srgb, var(--yc-yellow) 35%, transparent);
  }
  .round:not(:disabled):active, .stop:not(:disabled):active { transform: scale(0.94); }
  .plan {
    position: relative; height: 56px; display: flex; align-items: center; border-radius: 999px;
    background: var(--yc-surface-2);
  }
  .plan select {
    width: 100%; height: 100%; padding: 0 40px 0 20px; border: 0; border-radius: 999px;
    appearance: none; -webkit-appearance: none; background: transparent; cursor: pointer;
    font-weight: 600; font-size: 0.95rem; text-overflow: ellipsis;
  }
  .plan ha-icon {
    position: absolute; right: 16px; pointer-events: none; color: var(--yc-text-2);
    --mdc-icon-size: 20px;
  }
  .plan.disabled { opacity: 0.38; }
  .plan.disabled select { cursor: not-allowed; }
  .stop {
    width: 100%; height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 0; border-radius: 999px; cursor: pointer; font-weight: 600; --mdc-icon-size: 20px;
    background: color-mix(in srgb, var(--yc-red) 18%, var(--yc-surface-2)); color: var(--yc-ink-red);
    transition: background 0.2s, color 0.2s, transform 0.12s ease;
  }
  .stop.armed { background: var(--yc-red); color: #fff; }
  .cap {
    overflow: hidden; text-align: center; white-space: nowrap; text-overflow: ellipsis;
    font-size: 0.72rem; color: var(--yc-text-2);
  }

  .quick { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  .quick:empty { display: none; }
  .chip {
    height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px;
    border-radius: 999px; border: 1px solid var(--yc-line); background: var(--yc-surface);
    font-size: 0.8rem; cursor: pointer; --mdc-icon-size: 16px;
  }
  .chip.on {
    background: color-mix(in srgb, var(--yc-yellow) 18%, var(--yc-surface));
    border-color: color-mix(in srgb, var(--yc-yellow) 45%, transparent);
    color: var(--yc-ink-yellow);
  }
  .busy { pointer-events: none; animation: yc-busy 1s ease-in-out infinite; }

  .placeholder {
    padding: 28px 8px; text-align: center; color: var(--yc-text-2); font-size: 0.9rem;
    display: flex; flex-direction: column; align-items: center; gap: 8px; --mdc-icon-size: 36px;
  }

  .toast {
    position: absolute; left: 16px; right: 16px; bottom: 16px; z-index: 2; padding: 11px 14px;
    border-radius: 14px; background: #2b2c31; color: #fff; font-size: 0.84rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); opacity: 0; transform: translateY(8px);
    pointer-events: none; transition: opacity 0.2s, transform 0.2s;
  }
  .toast.show { opacity: 1; transform: none; }

  /* Robot drawing */
  .rb-shadow { fill: #000; opacity: 0.4; }
  .rb-track { fill: #141518; stroke: #2a2b30; stroke-width: 1; }
  .rb-tread { fill: none; stroke: #2e2f35; stroke-width: 5; stroke-dasharray: 6 5; }
  .rb-tread.moving { animation: yc-tread 0.5s linear infinite; }
  .rb-wheel { fill: #222327; stroke: #3a3b41; stroke-width: 2; }
  .rb-hub, .rb-yellow { fill: #fcc419; }
  .rb-roller { fill: #2a2b30; }
  .rb-cover { fill: #1b1c20; }
  .rb-stripe { stroke: #fcc419; stroke-width: 2.5; stroke-linecap: round; }
  .rb-body { fill: #202127; }
  .rb-lid { fill: #2d2e34; }
  .rb-shine { fill: none; stroke: rgba(255, 255, 255, 0.14); stroke-width: 2; stroke-linecap: round; }
  .rb-vent { fill: rgba(0, 0, 0, 0.22); }
  .rb-estop { fill: #e5484d; }
  .rb-antenna { stroke: #3b3c43; stroke-width: 3; stroke-linecap: round; }
  .rb-tip { fill: #3b3c43; }
  .rb-camera { fill: #17181c; stroke: #3b3c43; stroke-width: 1; }
  .rb-lens { fill: #5b8cff; opacity: 0.85; }
  .rb-led { fill: #cfd6e4; }
  .rb-led.on { fill: #fffbe6; filter: drop-shadow(0 0 4px #fff3b0); }
  .rb-beam { opacity: 0.55; }
  .rb-arm { stroke: #3b3c43; stroke-width: 6; stroke-linecap: round; }
  .rb-tire { fill: #17181c; }
  .rb-chute { fill: none; stroke: #2d2e34; stroke-width: 12; stroke-linecap: round; }
  .rb-spiral { fill: none; stroke: #fcc419; stroke-width: 2; }
  .rb-steel { fill: #3b3c43; }
  .rb-spoke { stroke: #fcc419; stroke-width: 2; stroke-linecap: round; }

  @keyframes yc-tread { to { stroke-dashoffset: -11; } }
  @keyframes yc-ping { from { transform: scale(0.6); opacity: 0.45; } to { transform: scale(2); opacity: 0; } }
  @keyframes yc-breathe { 50% { filter: brightness(1.18); } }
  @keyframes yc-busy { 50% { opacity: 0.55; } }

  @container yc (max-width: 340px) {
    .card { padding: 16px 14px 18px; }
    .name { font-size: 1.25rem; }
    .seg button { width: 32px; }
    .hero { grid-template-columns: minmax(0, 1fr); }
    .rail { flex-direction: row; justify-content: center; gap: 16px; }
    .battery { width: 112px; height: 48px; flex-direction: row; align-items: center; }
    .battery-text { padding: 0 0 0 14px; align-items: flex-start; }
    .battery-track { height: 38px; flex: 1; }
    .battery-fill { top: 0; right: auto; height: auto; width: var(--level, 0%); }
    .bar { grid-template-columns: 48px minmax(0, 1fr) 48px; column-gap: 8px; margin: 0 6px; }
    .bar::before { top: -6px; left: -6px; right: -6px; height: 60px; }
    .round { width: 48px; height: 48px; --mdc-icon-size: 22px; }
    .plan, .stop { height: 48px; }
    .plan select { padding: 0 30px 0 14px; font-size: 0.88rem; }
    .plan ha-icon { right: 10px; }
    .stop { font-size: 0.88rem; gap: 6px; }
    .cap { font-size: 0.66rem; overflow: visible; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
`;

class YarboCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("yarbo-card-editor");
  }

  static getStubConfig(hass) {
    const device = Object.values((hass && hass.devices) || {}).find(
      (entry) => entry.manufacturer === "Yarbo"
    );
    return { device_id: device ? device.id : "" };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "home";
    this._html = {};
    this._busy = new Set();
    this._loadToken = 0;
    this._shown = null;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration.");
    const appearance = config.appearance ?? DEFAULTS.appearance;
    if (!["app", "theme"].includes(appearance)) {
      throw new Error("appearance must be app or theme.");
    }
    this._config = { ...DEFAULTS, ...config, appearance };
    this.setAttribute("appearance", appearance);
    this._device = undefined;
    this._loadError = null;
    this._map = undefined;
    this._mapStamp = undefined;
    this._view = "home";
    this._build();
    if (this._hass) this._loadDevice();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (this._needsLoad()) this._loadDevice();
    if (this._live) this._live.hass = hass;
    this._update();
  }

  getCardSize() {
    return 7;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  disconnectedCallback() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    clearTimeout(this._toastTimer);
    clearTimeout(this._stopTimer);
  }

  connectedCallback() {
    if (this._config && this._hass && this._needsLoad()) this._loadDevice();
  }

  // ---- Data ----

  _needsLoad() {
    // A failed load waits for its retry timer rather than retrying on every state change.
    return this._device === undefined && !this._loading && !this._retryTimer;
  }

  async _loadDevice() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    const { device_id: deviceId, sn } = this._config;
    if (!deviceId && !sn) {
      this._device = null;
      this._update(true);
      return;
    }
    const token = ++this._loadToken;
    this._loading = true;
    try {
      const { devices } = await this._hass.callWS({ type: "yarbo/devices" });
      if (token !== this._loadToken) return;
      this._device =
        devices.find((d) => (deviceId && d.device_id === deviceId) || (sn && d.sn === sn)) || null;
      this._loadError = this._device
        ? null
        : "This Yarbo isn't set up in Home Assistant. Pick it again in the card editor.";
    } catch (err) {
      if (token !== this._loadToken) return;
      this._device = undefined;
      this._loadError =
        err && err.code === "unknown_command"
          ? "The Yarbo integration isn't loaded yet."
          : (err && err.message) || "Could not load the Yarbo device.";
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this._loadDevice();
      }, 30000);
    } finally {
      if (token === this._loadToken) this._loading = false;
    }
    this._update(true);
  }

  _entityId(key) {
    return this._device && this._device.entities[KEYS[key]];
  }

  _stateObj(key) {
    const id = this._entityId(key);
    return id ? this._hass.states[id] : undefined;
  }

  _state(key) {
    const obj = this._stateObj(key);
    return obj && !MISSING.has(obj.state) ? obj.state : undefined;
  }

  _on(key) {
    return this._state(key) === "on";
  }

  _num(key) {
    const value = parseFloat(this._state(key));
    return Number.isFinite(value) ? value : undefined;
  }

  _usable(key) {
    const obj = this._stateObj(key);
    return Boolean(obj) && obj.state !== "unavailable";
  }

  // ---- View model ----

  _model() {
    const online = this._on("online");
    const battery = this._num("battery");
    const charging = this._on("charging");
    const planStatus = this._state("planStatus") || "";
    const pauseStatus = this._state("pauseStatus") || "";
    const recharge = this._state("rechargeStatus") || "";
    const headType = this._state("headType");
    const planObj = this._stateObj("plan");
    const plan = this._state("plan");
    const planActive = planStatus in PLAN_ACTIVE;
    const paused = planActive && pauseStatus && pauseStatus !== "Not Paused";
    const errorCode = this._num("errorCode");

    let mode = "standby";
    let label = "Standby";
    let detail = this._on("rain") ? "Rain detected" : "Ready";
    if (!online) {
      mode = "offline";
      label = "Offline";
      const since = this._stateObj("online");
      detail = since ? this._since(since.last_changed) : "";
    } else if (this._on("stuck")) {
      mode = "error";
      label = "Stuck";
      detail = "Check the robot";
    } else if (planStatus.startsWith("Error")) {
      mode = "error";
      label = planStatus.replace(/^Error:\s*/, "") || "Plan error";
      detail = plan || "";
    } else if (recharge.startsWith("Error")) {
      mode = "error";
      label = "Couldn't dock";
      detail = recharge.replace(/^Error:\s*/, "");
    } else if (paused) {
      mode = "paused";
      label = "Paused";
      detail = pauseStatus === "Manual Pause" ? plan || "" : pauseStatus;
    } else if (planActive) {
      mode = "working";
      label = PLAN_ACTIVE[planStatus];
      detail = plan || "";
    } else if (RETURNING.has(recharge)) {
      mode = "returning";
      label = "Returning to dock";
      detail = recharge;
    } else if (charging) {
      mode = "charging";
      label = battery >= 100 ? "Fully charged" : "Charging";
      detail = "On the dock";
    } else if (recharge === "Charging") {
      mode = "charging";
      label = "Docked";
      detail = "On the dock";
    }

    const network = this._state("network");
    const rssiKey = { Wifi: "wifi", "4G": "lte", Halow: "halow" }[network];
    const bars = signalBars(rssiKey ? this._num(rssiKey) : undefined);
    const rtk = this._state("rtk");
    const tracker = this._stateObj("tracker");
    const robotPos =
      tracker && Number.isFinite(tracker.attributes.latitude) && tracker.state !== "unavailable"
        ? [tracker.attributes.longitude, tracker.attributes.latitude]
        : null;

    return {
      online,
      battery,
      charging,
      mode,
      label,
      detail,
      head: headKind(headType),
      headType: headType && headType !== "None" ? headType : "",
      planActive,
      paused,
      plan,
      plans: (planObj && planObj.attributes.options) || [],
      errorCode: errorCode && errorCode !== 0 ? errorCode : undefined,
      network,
      rssiKey,
      bars,
      rtk,
      robotPos,
      light: this._on("headLight"),
    };
  }

  _since(iso) {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds < 60) return "";
    const rtf = new Intl.RelativeTimeFormat(this._hass.locale?.language, { numeric: "auto" });
    if (seconds < 3600) return `Last seen ${rtf.format(-Math.round(seconds / 60), "minute")}`;
    if (seconds < 86400) return `Last seen ${rtf.format(-Math.round(seconds / 3600), "hour")}`;
    return `Last seen ${rtf.format(-Math.round(seconds / 86400), "day")}`;
  }

  // ---- Rendering ----

  _build() {
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="card">
          <div class="head" data-region="head"></div>
          <div class="body" data-region="body"></div>
          <div data-region="actions"></div>
          <div class="quick" data-region="quick"></div>
          <div class="toast" role="status" aria-live="polite"></div>
        </div>
      </ha-card>`;
    this._card = this.shadowRoot.querySelector(".card");
    this._toastEl = this.shadowRoot.querySelector(".toast");
    this._regions = {};
    for (const el of this.shadowRoot.querySelectorAll("[data-region]")) {
      this._regions[el.dataset.region] = el;
    }
    this._html = {};
    this._shown = null;
    this._removeLive();
  }

  _setRegion(name, html) {
    if (this._html[name] === html) return;
    this._html[name] = html;
    this._regions[name].innerHTML = html;
  }

  _update(force = false) {
    if (!this._config || !this._hass || !this._regions) return;

    if (!this._device) {
      const text = !this._config.device_id && !this._config.sn
        ? "Choose your Yarbo in the card editor."
        : this._loadError || "Loading…";
      this._card.style.removeProperty("--yc-tone");
      this._setRegion("head", "");
      this._setRegion("body", `<div class="placeholder">${icon("mdi:robot-mower-outline")}<span>${esc(text)}</span></div>`);
      this._setRegion("actions", "");
      this._setRegion("quick", "");
      return;
    }

    // Skip work when none of this robot's entities changed.
    const shown = Object.values(this._device.entities).map((id) => this._hass.states[id]);
    const unchanged =
      this._shown &&
      shown.length === this._shown.length &&
      shown.every((s, i) => s === this._shown[i]);
    if (!force && unchanged) return;
    this._shown = shown;

    const m = this._model();
    const tone = TONES[m.mode];
    if (tone) {
      this._card.style.setProperty("--yc-tone", tone);
      this._card.style.setProperty("--yc-tone-ink", TONE_INKS[m.mode]);
    } else {
      this._card.style.removeProperty("--yc-tone");
      this._card.style.removeProperty("--yc-tone-ink");
    }

    const views = this._views();
    if (!views.includes(this._view)) this._view = "home";
    this._setRegion("head", this._headHtml(m, views));
    if (this._view === "home") this._setRegion("body", this._homeHtml(m));
    else if (this._view === "map") {
      this._maybeLoadMap();
      this._setRegion("body", this._mapHtml(m));
    } else this._showLive();
    this._setRegion("actions", this._actionsHtml(m));
    this._setRegion("quick", this._quickHtml(m));
  }

  _views() {
    const views = ["home"];
    if (this._config.show_map && this._entityId("mapZones")) views.push("map");
    if (this._config.show_live && this._hass.user && this._hass.user.is_admin) views.push("live");
    return views;
  }

  _headHtml(m, views) {
    const name = this._config.name || this._device.name || "Yarbo";
    const sub = [this._device.model, m.headType].filter(Boolean).map(esc).join(" · ");
    const icons = { home: "mdi:home-variant-outline", map: "mdi:map-outline", live: "mdi:video-outline" };
    const titles = { home: "Robot", map: "Map", live: "Live camera" };
    const seg =
      views.length > 1
        ? `<div class="seg" role="tablist">${views
            .map(
              (v) => `<button type="button" role="tab" data-action="view" data-view="${v}"
                aria-selected="${v === this._view}" aria-label="${titles[v]}" title="${titles[v]}">${icon(icons[v])}</button>`
            )
            .join("")}</div>`
        : "";
    return `
      <div class="title">
        <div class="name">${esc(name)}</div>
        <div class="sub"><span class="dot${m.online ? " on" : ""}"></span>${m.online ? "Online" : "Offline"}${sub ? ` · ${sub}` : ""}</div>
      </div>${seg}`;
  }

  _homeHtml(m) {
    const image = this._config.image
      ? `<img src="${esc(this._config.image)}" alt="">`
      : robotSvg(m.head, { moving: m.mode === "working" || m.mode === "returning", light: m.light });

    const netIcon =
      m.network === "4G"
        ? m.bars ? `mdi:signal-cellular-${Math.min(m.bars, 3)}` : "mdi:signal-cellular-outline"
        : m.network === "Halow"
          ? "mdi:access-point-network"
          : m.bars ? `mdi:wifi-strength-${m.bars}` : "mdi:wifi-strength-off-outline";
    // Signal dots would show stale readings while the robot is offline.
    const netLevel = !m.online ? "" : m.bars >= 3 ? "good" : m.bars === 2 ? "fair" : m.bars === 1 ? "poor" : "";
    const netLabel = NETWORK_LABELS[m.network] || "Network";
    const rtkLevel = (m.online && { Strong: "good", Medium: "fair", Weak: "poor" }[m.rtk]) || "";

    const tiles = [];
    if (this._entityId("network")) {
      tiles.push(`
        <button type="button" class="tile" data-action="more" data-key="${m.rssiKey || "network"}"
          aria-label="Network: ${esc(netLabel)}">
          <span class="tile-icon"${netLevel ? ` data-level="${netLevel}"` : ""}>${icon(netIcon)}</span>
          <span>${esc(netLabel)}</span>
        </button>`);
    }
    if (this._entityId("rtk")) {
      tiles.push(`
        <button type="button" class="tile" data-action="more" data-key="rtk"
          aria-label="RTK signal: ${esc(m.rtk || "unknown")}">
          <span class="tile-icon"${rtkLevel ? ` data-level="${rtkLevel}"` : ""}>${icon(m.rtk ? "mdi:crosshairs-gps" : "mdi:crosshairs-question")}</span>
          <span>RTK</span>
        </button>`);
    }
    if (this._entityId("battery")) {
      const level = m.battery === undefined ? 0 : Math.max(0, Math.min(100, Math.round(m.battery)));
      const low = m.battery !== undefined && m.battery < 20 && !m.charging;
      tiles.push(`
        <button type="button" class="battery${m.charging ? " charging" : ""}${low ? " low" : ""}"
          data-action="more" data-key="battery" style="--level: ${level}%"
          aria-label="Battery ${m.battery === undefined ? "unknown" : `${level}%`}${m.charging ? ", charging" : ""}">
          <span class="battery-text">
            <span class="battery-value">${m.charging ? icon("mdi:lightning-bolt") : ""}${m.battery === undefined ? "–" : level}<small>%</small></span>
            <span class="battery-caption">Battery</span>
          </span>
          <span class="battery-track"><span class="battery-fill"></span></span>
        </button>`);
    }

    const banner =
      m.errorCode !== undefined && m.mode !== "offline"
        ? `<div class="banner">${icon("mdi:alert-circle-outline")}<span>The robot reported error code ${esc(m.errorCode)}.</span></div>`
        : "";

    return `
      <div class="hero">
        <div class="stage">
          <div class="robot${m.mode === "offline" ? " offline" : ""}">${image}</div>
          <div class="state">
            <div class="label">${esc(m.label)}</div>
            <div class="detail">${esc(m.detail)}</div>
          </div>
        </div>
        <div class="rail${m.online ? "" : " offline"}">${tiles.join("")}</div>
      </div>${banner}`;
  }

  _mapHtml(m) {
    let content;
    if (this._map === undefined) {
      content = `<div class="map-empty">${icon("mdi:map-clock-outline")}<span>Loading the map…</span></div>`;
    } else if (this._map === null) {
      content = `<div class="map-empty">${icon("mdi:map-search-outline")}<span>No map yet. Refresh it once the robot is online.</span></div>`;
    } else {
      content =
        mapSvg(this._map, m.robotPos) ||
        `<div class="map-empty">${icon("mdi:map-search-outline")}<span>The map has no zones yet.</span></div>`;
    }
    const caption = m.robotPos
      ? "Yellow dot: robot"
      : this._entityId("tracker")
        ? "Robot position appears with an RTK fix"
        : "";
    const refresh = this._entityId("refreshMap")
      ? `<button type="button" class="chip${this._busy.has("refreshMap") ? " busy" : ""}" data-action="press" data-key="refreshMap"
          ${m.online ? "" : "disabled"}>${icon("mdi:refresh")}Refresh map</button>`
      : "";
    return `<div class="map">${content}</div><div class="map-foot"><span>${caption}</span>${refresh}</div>`;
  }

  _actionsHtml(m) {
    const active = m.planActive;
    const primary = m.paused
      ? { key: "resume", icon: "mdi:play", cap: "Resume" }
      : active
        ? { key: "pause", icon: "mdi:pause", cap: "Pause" }
        : { key: "start", icon: "mdi:play", cap: "Start" };
    const primaryOk =
      m.online && this._usable(primary.key) && (primary.key !== "start" || Boolean(m.plan));
    const dockOk =
      m.online && this._usable("dock") && m.mode !== "charging" && m.mode !== "returning";

    let middle;
    let middleCap;
    if (active) {
      const armed = Boolean(this._stopArmed);
      middle = `<button type="button" class="stop${armed ? " armed" : ""}${this._busy.has("stop") ? " busy" : ""}"
        data-action="stop" ${m.online && this._usable("stop") ? "" : "disabled"}>
        ${icon("mdi:power")}<span>${armed ? "Tap again to end" : "End plan"}</span></button>`;
      middleCap = esc(m.plan || "Plan");
    } else {
      const options = m.plans
        .map((p) => `<option value="${esc(p)}"${p === m.plan ? " selected" : ""}>${esc(p)}</option>`)
        .join("");
      const prompt = m.plans.length ? "Choose a plan" : "No plans";
      const planOk = m.online && m.plans.length && this._usable("plan");
      middle = `<label class="plan${planOk ? "" : " disabled"}">
        <select data-action="plan" aria-label="Plan" ${planOk ? "" : "disabled"}>
          ${m.plan ? "" : `<option value="" selected disabled>${prompt}</option>`}${options}
        </select>${icon("mdi:chevron-down")}</label>`;
      middleCap = "Plan";
    }

    return `
      <div class="bar">
        <button type="button" class="round primary${this._busy.has(primary.key) ? " busy" : ""}"
          data-action="press" data-key="${primary.key}" aria-label="${primary.cap}" title="${primary.cap}"
          ${primaryOk ? "" : "disabled"}>${icon(primary.icon)}</button>
        ${middle}
        <button type="button" class="round${this._busy.has("dock") ? " busy" : ""}" data-action="press"
          data-key="dock" aria-label="Return to charge" title="Return to charge"
          ${dockOk ? "" : "disabled"}>${icon("mdi:home-lightning-bolt-outline")}</button>
        <span class="cap">${primary.cap}</span>
        <span class="cap">${middleCap}</span>
        <span class="cap">Recharge</span>
      </div>`;
  }

  _quickHtml(m) {
    const chips = [];
    if (this._entityId("headLight")) {
      chips.push(`<button type="button" class="chip${m.light ? " on" : ""}${this._busy.has("headLight") ? " busy" : ""}"
        data-action="toggle" data-key="headLight" aria-pressed="${m.light}"
        ${m.online && this._usable("headLight") ? "" : "disabled"}>${icon("mdi:car-light-high")}Lights</button>`);
    }
    if (this._entityId("findMe")) {
      chips.push(`<button type="button" class="chip${this._busy.has("findMe") ? " busy" : ""}"
        data-action="press" data-key="findMe"
        ${m.online && this._usable("findMe") ? "" : "disabled"}>${icon("mdi:volume-high")}Find robot</button>`);
    }
    return chips.join("");
  }

  // ---- Live view ----

  _showLive() {
    if (this._live && this._live.isConnected) return;
    this._html.body = undefined;
    const holder = document.createElement("div");
    holder.className = "live";
    this._regions.body.replaceChildren(holder);
    this._html.body = "live";
    if (!customElements.get("yarbo-smart-vision-card")) {
      holder.textContent = "The live view isn't loaded. Reload the page and try again.";
      return;
    }
    const player = document.createElement("yarbo-smart-vision-card");
    player.setConfig({
      sn: this._device.sn,
      embedded: true,
      title: "Live camera",
      ...(this._config.live_max_minutes ? { max_minutes: this._config.live_max_minutes } : {}),
    });
    player.hass = this._hass;
    holder.appendChild(player);
    this._live = player;
  }

  _removeLive() {
    if (this._live) this._live.remove();
    this._live = null;
  }

  // ---- Map ----

  async _maybeLoadMap() {
    const sensor = this._stateObj("mapZones");
    const stamp = sensor ? sensor.last_updated : "";
    if (this._mapLoading || (this._map !== undefined && stamp === this._mapStamp)) return;
    this._mapLoading = true;
    this._mapStamp = stamp;
    const sn = this._device.sn;
    try {
      const result = await this._hass.callWS({ type: "yarbo/map_zones", sn });
      if (this._device && this._device.sn === sn) this._map = result.geojson;
    } catch (err) {
      if (this._device && this._device.sn === sn) this._map = null;
    } finally {
      this._mapLoading = false;
    }
    if (this._view === "map") this._update(true);
  }

  // ---- Events ----

  _onClick(ev) {
    const el = ev.target.closest("[data-action]");
    if (!el || el.disabled || el.tagName === "SELECT") return;
    const { action, key } = el.dataset;
    if (action === "view") {
      if (el.dataset.view === this._view) return;
      this._view = el.dataset.view;
      if (this._view !== "live") this._removeLive();
      this._update(true);
    } else if (action === "press") {
      this._call(key, "button", "press");
    } else if (action === "toggle") {
      this._call(key, "switch", "toggle");
    } else if (action === "stop") {
      this._onStop();
    } else if (action === "more") {
      const entityId = this._entityId(key);
      if (!entityId) return;
      const event = new Event("hass-more-info", { bubbles: true, composed: true });
      event.detail = { entityId };
      this.dispatchEvent(event);
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (el.dataset.action !== "plan" || !el.value) return;
    this._call("plan", "select", "select_option", { option: el.value });
  }

  _onStop() {
    clearTimeout(this._stopTimer);
    if (!this._stopArmed) {
      this._stopArmed = true;
      this._stopTimer = setTimeout(() => {
        this._stopArmed = false;
        this._update(true);
      }, STOP_CONFIRM_MS);
      this._update(true);
      return;
    }
    this._stopArmed = false;
    this._call("stop", "button", "press");
  }

  async _call(key, domain, service, data = {}) {
    const entityId = this._entityId(key);
    if (!entityId || this._busy.has(key)) return;
    this._busy.add(key);
    this._update(true);
    try {
      await this._hass.callService(domain, service, { entity_id: entityId, ...data });
    } catch (err) {
      this._toast((err && err.message) || "The robot didn't accept the command.");
    } finally {
      this._busy.delete(key);
      this._update(true);
    }
  }

  _toast(text) {
    clearTimeout(this._toastTimer);
    this._toastEl.textContent = text;
    this._toastEl.classList.add("show");
    this._toastTimer = setTimeout(() => this._toastEl.classList.remove("show"), 6000);
  }
}

// ---- Editor ---------------------------------------------------------------------

const EDITOR_SCHEMA = [
  { name: "device_id", required: true, selector: { device: { filter: { integration: "yarbo" } } } },
  { name: "name", selector: { text: {} } },
  {
    name: "appearance",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "app", label: "Yarbo app (dark)" },
          { value: "theme", label: "Match my dashboard theme" },
        ],
      },
    },
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "show_map", selector: { boolean: {} } },
      { name: "show_live", selector: { boolean: {} } },
    ],
  },
  { name: "image", selector: { text: {} } },
];

const EDITOR_LABELS = {
  device_id: "Yarbo",
  name: "Name (optional)",
  appearance: "Appearance",
  show_map: "Map tab",
  show_live: "Live camera tab (admins)",
  image: "Robot picture URL (optional)",
};

class YarboCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] ?? schema.name;
      this._form.addEventListener("value-changed", (ev) => this._changed(ev.detail.value));
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = { ...DEFAULTS, ...this._config };
  }

  _changed(value) {
    const config = { ...this._config, ...value };
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (config[key] === fallback) delete config[key];
    }
    for (const key of ["name", "image"]) {
      if (!config[key]) delete config[key];
    }
    this._config = config;
    const event = new Event("config-changed", { bubbles: true, composed: true });
    event.detail = { config };
    this.dispatchEvent(event);
  }
}

if (!customElements.get("yarbo-card")) customElements.define("yarbo-card", YarboCard);
if (!customElements.get("yarbo-card-editor")) {
  customElements.define("yarbo-card-editor", YarboCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "yarbo-card")) {
  window.customCards.push({
    type: "yarbo-card",
    name: "Yarbo",
    description: "Status, controls, map and live camera for a Yarbo robot, styled like the Yarbo app.",
    preview: true,
    documentationURL: "https://github.com/kkrankall/YarboHA#yarbo-card",
  });
}
