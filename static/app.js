const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { room: null, callsign: null, adminToken: null, agentToken: null, socket: null, span: "day", traffic: [], filter: "all", scene: null };
const THEME_KEY = "moonbird:theme";

function setTheme(theme) {
  const selected = ["light", "dark", "night"].includes(theme) ? theme : "light";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem(THEME_KEY, selected);
  $$('[data-theme-option]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.themeOption === selected)));
  applySceneTheme();
}

setTheme(localStorage.getItem(THEME_KEY) || "light");
$$('[data-theme-option]').forEach((button) => button.addEventListener("click", () => setTheme(button.dataset.themeOption)));

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || `Request failed (${response.status})`);
  return payload;
}

function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function stationPayload(values) { return values.location_mode === "grid" ? { grid_square: values.grid_square.trim().toUpperCase(), elevation_m: 0 } : { latitude: Number(values.latitude), longitude: Number(values.longitude), elevation_m: 0 }; }
function equipment() { return { frequency_mhz: 145.05, amplifier_w: 50, antenna_gain_dbi: 11.6, radio: "LilyGo T-Beam BPF" }; }
function showError(error) { $("#entry-error").textContent = error.message; toast(error.message); }
function toast(message) { const el = $("#toast"); el.textContent = message; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 3500); }

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Fall through for browsers that expose the API but deny permission.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  document.body.append(field);
  field.focus();
  field.select();
  field.setSelectionRange(0, field.value.length);
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard access was blocked by the browser");
}

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  setSubmitting(button, true, "Creating room...");
  try {
    const values = formObject(event.currentTarget);
    const result = await api("/api/rooms", { method: "POST", body: JSON.stringify({ ...stationPayload(values), title: values.title, callsign: values.callsign, equipment: equipment() }) });
    state.callsign = values.callsign.toUpperCase(); state.adminToken = result.admin_token; state.agentToken = result.agent_token;
    saveSession(result.code); enterRoom(result);
  } catch (error) { showError(error); }
  finally { setSubmitting(button, false); }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  setSubmitting(button, true, "Joining room...");
  try {
    const values = formObject(event.currentTarget); const code = values.code.toUpperCase();
    const result = await api(`/api/rooms/${code}/participants`, { method: "POST", body: JSON.stringify({ ...stationPayload(values), callsign: values.callsign, equipment: equipment() }) });
    state.callsign = values.callsign.toUpperCase(); state.agentToken = result.agent_token; state.adminToken = null;
    saveSession(code); enterRoom(result.room);
  } catch (error) { showError(error); }
  finally { setSubmitting(button, false); }
});

function setSubmitting(button, submitting, label = "") {
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  button.disabled = submitting;
  button.innerHTML = submitting ? label : button.dataset.label;
}

function updateLocationMode(form) {
  const gridMode = form.elements.location_mode.value === "grid";
  form.querySelector("[data-coordinate-fields]").hidden = gridMode;
  form.querySelector("[data-grid-field]").hidden = !gridMode;
  form.elements.latitude.required = !gridMode;
  form.elements.longitude.required = !gridMode;
  form.elements.grid_square.required = gridMode;
}

$$('.room-entry-form').forEach((form) => {
  form.elements.location_mode.addEventListener("change", () => updateLocationMode(form));
  updateLocationMode(form);
});

function saveSession(code) {
  localStorage.setItem(`moonbird:${code}`, JSON.stringify({ callsign: state.callsign, adminToken: state.adminToken, agentToken: state.agentToken }));
  history.replaceState({}, "", `/?room=${code}`);
}

async function restoreRoom() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
  if (!code) return;
  const saved = JSON.parse(localStorage.getItem(`moonbird:${code}`) || "null");
  if (!saved) { $("#join-form [name=code]").value = code; return; }
  try { Object.assign(state, saved); enterRoom(await api(`/api/rooms/${code}`)); } catch (error) { showError(error); }
}

function enterRoom(room) {
  state.room = room;
  $("#landing").hidden = true; $("#workspace").hidden = false;
  $("#room-title").textContent = room.title; $("#room-code").textContent = room.code;
  $("#export-json").href = `/api/rooms/${room.code}/export.json`; $("#export-csv").href = `/api/rooms/${room.code}/traffic.csv`;
  $("#live-state").classList.add("online"); $("#live-state").lastChild.textContent = ` Room ${room.code}`;
  renderRoom(); connectSocket(); initScene(); loadTraffic(); loadForecast();
}

function renderRoom() {
  $("#room-title").textContent = state.room.title;
  $("#station-count").textContent = `${state.room.participants.length} station${state.room.participants.length === 1 ? "" : "s"}`;
  const container = $("#participants"); container.innerHTML = "";
  for (const station of state.room.participants) {
    const row = document.createElement("div"); row.className = "participant";
    const icon = document.createElement("div"); icon.className = "participant-icon"; icon.textContent = station.callsign.slice(0, 2);
    const info = document.createElement("div"); const name = document.createElement("strong"); name.textContent = station.callsign + (station.callsign === state.callsign ? " (you)" : "");
    const detail = document.createElement("small"); detail.textContent = `${station.grid_square || ""} · ${station.latitude.toFixed(3)}, ${station.longitude.toFixed(3)} · ${station.equipment.radio || "Station"}`; info.append(name, detail);
    const role = document.createElement("select");
    for (const value of ["transmitter", "receiver", "both", "observer"]) { const option = new Option(value, value, false, station.role === value); role.add(option); }
    role.disabled = !state.adminToken; role.addEventListener("change", () => updateRole(station.callsign, role.value)); row.append(icon, info, role); container.append(row);
  }
  const local = localStation();
  const canTransmit = local && ["transmitter", "both"].includes(local.role);
  $("#transmit-button").disabled = !canTransmit;
  initializeAgentSetup();
  updateTransmitPreview();
}

function defaultAgentServer() {
  const url = new URL(location.origin);
  if (["0.0.0.0", "::", "[::]"].includes(url.hostname)) url.hostname = "127.0.0.1";
  return url.origin;
}

function initializeAgentSetup() {
  const serverInput = $("#agent-server");
  const radioInput = $("#radio-host");
  if (!serverInput.value) serverInput.value = localStorage.getItem("moonbird:agent-server") || defaultAgentServer();
  if (!radioInput.value) radioInput.value = localStorage.getItem("moonbird:radio-host") || "meshtastic.local";
  updateAgentCommand();
}

function updateAgentCommand() {
  if (!state.room) return;
  const server = $("#agent-server").value.trim() || defaultAgentServer();
  const radio = $("#radio-host").value.trim() || "meshtastic.local";
  localStorage.setItem("moonbird:agent-server", server);
  localStorage.setItem("moonbird:radio-host", radio);
  const python = /Windows/i.test(navigator.userAgent) ? ".agent-venv\\Scripts\\python.exe" : ".agent-venv/bin/python";
  $("#agent-command").textContent = `${python} -m moonbird_agent --server ${server} --room ${state.room.code} --callsign ${state.callsign} --token ${state.agentToken} --radio-host ${radio} --allow-transmit`;
}

async function updateRole(callsign, role) {
  try { state.room = await api(`/api/rooms/${state.room.code}/roles`, { method: "PATCH", body: JSON.stringify({ callsign, role, admin_token: state.adminToken }) }); renderRoom(); loadForecast(); }
  catch (error) { toast(error.message); }
}

function localStation() { return state.room?.participants.find((station) => station.callsign === state.callsign); }
function remoteStation() { return state.room?.participants.find((station) => station.callsign !== state.callsign && station.role !== "observer"); }

function connectSocket() {
  if (state.socket) state.socket.close();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws/rooms/${state.room.code}?callsign=${encodeURIComponent(state.callsign)}`); state.socket = socket;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "room") { state.room = message.room; renderRoom(); loadForecast(); }
    if (message.type === "traffic") { state.traffic.unshift(message.traffic); renderTraffic(); }
    if (message.type === "detection") celebrate(message.detection);
    if (message.type === "agent" && message.callsign === state.callsign) setAgent(message.connected);
    if (message.type === "agent_status" && message.callsign === state.callsign) renderAgentStatus(message.status);
  });
  socket.addEventListener("open", () => { connectSocket.ping = setInterval(() => socket.send("ping"), 20000); });
  socket.addEventListener("close", () => { clearInterval(connectSocket.ping); setTimeout(() => state.room && connectSocket(), 2500); });
}

function setAgent(connected) { $("#agent-badge").textContent = connected ? "Agent connected" : "Agent offline"; $("#agent-badge").classList.toggle("connected", connected); $("#agent-setup").hidden = connected; }
function renderAgentStatus(status) {
  setAgent(status.connected);
  if (status.checks || status.recommendations) {
    const checks = (status.checks || []).map((item) => `<li><b>${escapeHtml(item.name)} [${escapeHtml(item.status)}]</b> ${escapeHtml(item.detail)}</li>`).join("");
    const recommendations = (status.recommendations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    $("#recommendation-content").innerHTML = `<ul>${checks}${recommendations}</ul>`;
    const warnings = (status.checks || []).filter((item) => item.status !== "pass").length;
    $("#check-summary").textContent = warnings ? `${warnings} item${warnings === 1 ? "" : "s"} to review` : "All reported checks pass";
  }
}

$("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget, values = formObject(form);
  const request = {
    message_type: values.message_type,
    text: values.text,
    destination_callsign: values.destination_callsign.trim().toUpperCase() || "ALL",
    report: values.report === "" ? null : Number(values.report),
    destination: values.destination,
    channel: Number(values.channel),
  };
  try { const result = await api(`/api/rooms/${state.room.code}/transmit/${state.callsign}`, { method: "POST", body: JSON.stringify(request) }); $("#wire-preview").textContent = result.wire_text; toast(`Probe ${result.sequence} queued`); }
  catch (error) { toast(error.message); }
});

function updateTransmitPreview() {
  const form = $("#send-form");
  if (!form || !state.callsign) return;
  const messageType = form.elements.message_type.value;
  const text = form.elements.text.value;
  let destination = form.elements.destination_callsign.value.trim().toUpperCase() || "ALL";
  const needsDestination = ["report", "report_ack", "roger", "signoff"].includes(messageType);
  const needsReport = ["report", "report_ack", "roger"].includes(messageType);
  const custom = messageType === "custom";
  if (needsDestination && destination === "ALL" && remoteStation()) {
    destination = remoteStation().callsign;
    form.elements.destination_callsign.value = destination;
  }
  form.querySelector("[data-destination-field]").hidden = !needsDestination;
  form.querySelector("[data-report-field]").hidden = !needsReport;
  form.elements.destination_callsign.required = needsDestination;
  form.elements.report.required = needsReport;
  form.elements.text.required = custom;
  $("#message-text-label").textContent = custom ? "Custom message" : "Additional text (optional)";
  $("#wire-preview").textContent = buildMessagePreview({
    sequence: "NEXT",
    messageType,
    source: state.callsign,
    sourceGrid: (localStation()?.grid_square || "GRID").slice(0, 4),
    destination,
    report: form.elements.report.value === "" ? null : Number(form.elements.report.value),
    text,
  });
}

function buildMessagePreview({ sequence, messageType, source, sourceGrid, destination, report, text }) {
  const formattedReport = report === null ? "REPORT" : `${report >= 0 ? "+" : "-"}${Math.abs(report).toString().padStart(2, "0")}`;
  let body;
  if (messageType === "cq") body = `CQ ${source} ${sourceGrid}`;
  else if (["report", "report_ack"].includes(messageType)) body = `${destination} ${source} ${formattedReport}`;
  else if (messageType === "roger") body = `${destination} ${source} R ${formattedReport}`;
  else if (messageType === "signoff") body = `${destination} ${source} 73`;
  else body = text || "CUSTOM MESSAGE";
  if (messageType !== "custom" && text.trim()) body += ` ${text.trim()}`;
  return `${body} #${sequence}`;
}

for (const field of ["message_type", "text", "destination_callsign", "report"]) {
  $("#send-form").elements[field].addEventListener("input", updateTransmitPreview);
  $("#send-form").elements[field].addEventListener("change", updateTransmitPreview);
}

async function loadTraffic() { try { state.traffic = await api(`/api/rooms/${state.room.code}/traffic?limit=300`); renderTraffic(); } catch (error) { toast(error.message); } }
function renderTraffic() {
  const stream = $("#traffic-stream"); stream.innerHTML = "";
  const visible = state.filter === "all" ? state.traffic : state.traffic.filter((item) => item.kind === state.filter);
  if (!visible.length) { stream.innerHTML = `<p class="empty">No matching traffic recorded.</p>`; return; }
  for (const item of visible) {
    const row = document.createElement("div"); row.className = "traffic-row";
    const time = document.createElement("span"); time.textContent = new Date(item.received_at || item.observed_at).toLocaleTimeString();
    const dir = document.createElement("strong"); dir.className = item.direction; dir.textContent = item.direction.toUpperCase();
    const kind = document.createElement("span"); kind.textContent = item.kind;
    const payload = document.createElement("code"); payload.textContent = JSON.stringify(item.payload);
    row.append(time, dir, kind, payload); row.title = payload.textContent; stream.append(row);
  }
}

$$('.stream-filter button').forEach((button) => button.addEventListener("click", () => { $$('.stream-filter button').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.kind; renderTraffic(); }));
$$('.tabs button').forEach((button) => button.addEventListener("click", () => { $$('.tabs button').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.span = button.dataset.span; loadForecast(); }));

async function loadForecast() {
  const local = localStation(); if (!local) return;
  const remote = remoteStation();
  const query = new URLSearchParams({ lat: local.latitude, lon: local.longitude, elevation_m: local.elevation_m, span: state.span });
  if (remote) { query.set("remote_lat", remote.latitude); query.set("remote_lon", remote.longitude); query.set("remote_elevation_m", remote.elevation_m); }
  try { const forecast = await api(`/api/planning?${query}`); renderForecast(forecast); const current = forecast.samples[0]?.tx || forecast.samples[0]; updateScene(current, local, remote); }
  catch (error) { toast(error.message); }
}

function renderForecast(data) {
  const shared = Boolean(data.tx_station); const samples = data.samples; const width = 1100, height = 260, left = 42, bottom = 25, plotW = width - left - 12, plotH = height - bottom - 10;
  const x = (index) => left + index / Math.max(1, samples.length - 1) * plotW;
  const yElevation = (value) => 10 + (90 - Math.max(-30, Math.min(90, value))) / 120 * plotH;
  const yQuality = (value) => 10 + (100 - value) / 100 * plotH;
  const tx = samples.map((sample) => sample.tx || sample); const rx = shared ? samples.map((sample) => sample.rx) : [];
  const path = (list, field, yFn) => list.map((sample, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${yFn(sample[field]).toFixed(1)}`).join(" ");
  const windows = shared ? samples.map((sample, index) => sample.shared_visible ? `<rect x="${x(index)}" y="10" width="${plotW / samples.length + 1}" height="${plotH}" fill="var(--lime)" opacity=".23"/>` : "").join("") : "";
  const labels = [0, .25, .5, .75, 1].map((part) => { const index = Math.min(samples.length - 1, Math.floor((samples.length - 1) * part)); const at = new Date((samples[index].tx || samples[index]).at); const label = ["hour", "day"].includes(state.span) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleDateString([], state.span === "year" ? { month: "short" } : { month: "short", day: "numeric" }); return `<text x="${x(index)}" y="255" text-anchor="middle">${label}</text>`; }).join("");
  $("#forecast-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><g class="grid">${[0,30,60,90].map((v) => `<line x1="${left}" x2="${width}" y1="${yElevation(v)}" y2="${yElevation(v)}"/><text x="34" y="${yElevation(v)+4}" text-anchor="end">${v}°</text>`).join("")}${labels}</g>${windows}<path d="${path(tx,"elevation_deg",yElevation)}" fill="none" stroke="var(--orange)" stroke-width="3" vector-effect="non-scaling-stroke"/>${shared ? `<path d="${path(rx,"elevation_deg",yElevation)}" fill="none" stroke="var(--blue)" stroke-width="3" vector-effect="non-scaling-stroke"/>` : ""}<path d="${path(tx,"quality",yQuality)}" fill="none" stroke="var(--green)" stroke-width="2" stroke-dasharray="6 5" vector-effect="non-scaling-stroke"/></svg>`;
  const visible = shared ? samples.filter((sample) => sample.shared_visible).length : tx.filter((sample) => sample.visible).length;
  $("#forecast-note").textContent = shared ? `${visible} of ${samples.length} samples have simultaneous Moon visibility for ${state.callsign} and ${remoteStation().callsign}.` : `${visible} of ${samples.length} samples have the Moon above your horizon.`;
}

async function initScene() {
  if (state.scene) return;
  const host = $("#scene");
  let THREE, OrbitControls;
  try {
    [THREE, { OrbitControls }] = await Promise.all([import("/static/vendor/three.module.js"), import("/static/vendor/addons/controls/OrbitControls.js")]);
  } catch (error) {
    host.innerHTML = `<p class="scene-error">3D view unavailable. Room controls and planning remain active.</p>`;
    console.error("Moonbird 3D module failed to load", error);
    return;
  }
  state.THREE = THREE;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(52, 1, .1, 100); camera.position.set(0, 2.3, 6.2);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .95; host.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enablePan = false; controls.minDistance = 3; controls.maxDistance = 9;
  const loader = new THREE.TextureLoader();
  const earthTexture = loader.load("/static/assets/earth-blue-marble.jpg");
  earthTexture.colorSpace = THREE.SRGBColorSpace;
  earthTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  const moonTexture = createMoonTexture(THREE, renderer, 512);
  const sunTexture = createSunTexture(THREE, renderer, 512);
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshPhongMaterial({ map: earthTexture, color: 0xffffff, emissive: 0x07100f, emissiveIntensity: .06, shininess: 7 })); scene.add(earth);
  const grid = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1.006, 16, 8)), new THREE.LineBasicMaterial({ color: 0x9ad8ce, transparent: true, opacity: .13 })); scene.add(grid);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(.25, 48, 24), new THREE.MeshStandardMaterial({ map: moonTexture, color: 0xffffff, roughness: .95 })); moon.position.set(3.2, .7, 0); scene.add(moon);
  const sun = new THREE.Mesh(new THREE.SphereGeometry(.2, 48, 24), new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xffc86a })); sun.position.set(-4, 2, -1); scene.add(sun);
  const light = new THREE.DirectionalLight(0xfff0cc, 3.6); light.position.copy(sun.position); const ambient = new THREE.AmbientLight(0x52726c, .12); scene.add(light, light.target, ambient);
  const stars = createStars(THREE, 720); scene.add(stars);
  const stationMaterial = new THREE.MeshBasicMaterial({ color: 0xc9ff45 }); const localPin = new THREE.Mesh(new THREE.SphereGeometry(.045, 12, 8), stationMaterial); const remotePin = new THREE.Mesh(new THREE.SphereGeometry(.045, 12, 8), new THREE.MeshBasicMaterial({ color: 0x4da3ff })); scene.add(localPin, remotePin);
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), moon.position]); const pathLine = new THREE.Line(lineGeometry, new THREE.LineDashedMaterial({ color: 0xc9ff45, dashSize: .12, gapSize: .08, transparent: true, opacity: .75 })); pathLine.computeLineDistances(); scene.add(pathLine);
  function resize() { const rect = host.getBoundingClientRect(); renderer.setSize(rect.width, rect.height, false); camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(host); resize();
  function frame() { controls.update(); stars.rotation.y += .000025; renderer.render(scene, camera); requestAnimationFrame(frame); } frame();
  state.scene = { earth, grid, moon, sun, stars, light, ambient, localPin, remotePin, pathLine };
  applySceneTheme();
}

function applySceneTheme() {
  if (!state.scene) return;
  const theme = document.documentElement.dataset.theme;
  const colors = theme === "night"
    ? { earth: 0x7a100c, emissive: 0x160000, grid: 0xff1f16, moon: 0x8a1510, sun: 0xff2418, stars: 0xb51812, light: 0xff2418, ambient: 0x330000, local: 0xff3b30, remote: 0xa6120c, path: 0xff2418 }
    : theme === "dark"
      ? { earth: 0xa8b5b0, emissive: 0x06100e, grid: 0x84b8ae, moon: 0xbdbbb2, sun: 0xffbd68, stars: 0xb8d2ce, light: 0xffe4b5, ambient: 0x354842, local: 0xc9ff45, remote: 0x4da3ff, path: 0xc9ff45 }
      : { earth: 0xffffff, emissive: 0x07100f, grid: 0x9ad8ce, moon: 0xffffff, sun: 0xffc86a, stars: 0xe7f4f6, light: 0xfff0cc, ambient: 0x52726c, local: 0xc9ff45, remote: 0x4da3ff, path: 0xc9ff45 };
  state.scene.earth.material.color.setHex(colors.earth);
  state.scene.earth.material.emissive.setHex(colors.emissive);
  state.scene.grid.material.color.setHex(colors.grid);
  state.scene.moon.material.color.setHex(colors.moon);
  state.scene.sun.material.color.setHex(colors.sun);
  state.scene.stars.material.color.setHex(colors.stars);
  state.scene.light.color.setHex(colors.light);
  state.scene.ambient.color.setHex(colors.ambient);
  state.scene.ambient.intensity = theme === "night" ? .2 : theme === "dark" ? .15 : .12;
  state.scene.localPin.material.color.setHex(colors.local);
  state.scene.remotePin.material.color.setHex(colors.remote);
  state.scene.pathLine.material.color.setHex(colors.path);
}

function createStars(THREE, count) {
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const z = Math.random() * 2 - 1;
    const angle = Math.random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    positions[index * 3] = Math.cos(angle) * ring * 28;
    positions[index * 3 + 1] = z * 28;
    positions[index * 3 + 2] = Math.sin(angle) * ring * 28;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xe7f4f6, size: 2, sizeAttenuation: false, transparent: true, opacity: .9, fog: false, depthWrite: false }));
}

function createMoonTexture(THREE, renderer, size) {
  const { canvas, context } = createCanvasTexture(size);
  const base = context.createRadialGradient(size * .34, size * .28, size * .08, size * .48, size * .5, size * .72);
  base.addColorStop(0, "#f2f0e8"); base.addColorStop(.62, "#aaa99f"); base.addColorStop(1, "#5c5f5d");
  context.fillStyle = base; context.fillRect(0, 0, size, size);
  drawTextureNoise(context, size, .18); drawMoonCraters(context, size, 130);
  return finishTexture(THREE, renderer, canvas);
}

function createSunTexture(THREE, renderer, size) {
  const { canvas, context } = createCanvasTexture(size);
  const base = context.createRadialGradient(size * .38, size * .34, size * .05, size * .5, size * .5, size * .7);
  base.addColorStop(0, "#fff4aa"); base.addColorStop(.38, "#ffc44d"); base.addColorStop(.72, "#ef762f"); base.addColorStop(1, "#7f230e");
  context.fillStyle = base; context.fillRect(0, 0, size, size);
  drawSunBands(context, size); drawTextureNoise(context, size, .12);
  return finishTexture(THREE, renderer, canvas);
}

function createCanvasTexture(size) {
  const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
  return { canvas, context: canvas.getContext("2d") };
}

function finishTexture(THREE, renderer, canvas) {
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.ClampToEdgeWrapping; texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8); return texture;
}

function drawTextureNoise(context, size, strength) {
  const image = context.getImageData(0, 0, size, size), data = image.data;
  for (let index = 0; index < data.length; index += 4) { const noise = (Math.random() - .5) * 255 * strength; data[index] = Math.max(0, Math.min(255, data[index] + noise)); data[index + 1] = Math.max(0, Math.min(255, data[index + 1] + noise)); data[index + 2] = Math.max(0, Math.min(255, data[index + 2] + noise)); }
  context.putImageData(image, 0, 0);
}

function drawMoonCraters(context, size, count) {
  for (let index = 0; index < count; index += 1) { const x = Math.random() * size, y = Math.random() * size, radius = (.006 + Math.random() * Math.random() * .04) * size, alpha = .08 + Math.random() * .18; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fillStyle = `rgba(50,52,50,${alpha})`; context.fill(); context.beginPath(); context.arc(x - radius * .16, y - radius * .16, radius * .7, 0, Math.PI * 2); context.strokeStyle = `rgba(255,255,240,${alpha * .55})`; context.lineWidth = Math.max(1, radius * .12); context.stroke(); }
}

function drawSunBands(context, size) {
  context.globalCompositeOperation = "screen";
  for (let y = -size * .1; y < size * 1.1; y += size * .075) { context.beginPath(); context.moveTo(0, y); for (let x = 0; x <= size; x += size * .08) context.lineTo(x, y + Math.sin(x / size * Math.PI * 4 + y * .02) * size * .018); context.strokeStyle = "rgba(255,232,120,.18)"; context.lineWidth = size * .022; context.stroke(); }
  context.globalCompositeOperation = "source-over";
}

function stationBasis(THREE, station) { const latitude = THREE.MathUtils.degToRad(station.latitude), longitude = THREE.MathUtils.degToRad(station.longitude); const up = new THREE.Vector3(Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), -Math.cos(latitude) * Math.sin(longitude)).normalize(); const north = new THREE.Vector3(-Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude)).normalize(); const east = new THREE.Vector3(-Math.sin(longitude), 0, -Math.cos(longitude)).normalize(); return { up, north, east }; }
function globePoint(station) { return stationBasis(state.THREE, station).up.multiplyScalar(1.04); }
function horizontalPoint(THREE, station, azimuthDeg, elevationDeg, radius) { const { up, north, east } = stationBasis(THREE, station), azimuth = THREE.MathUtils.degToRad(azimuthDeg), elevation = THREE.MathUtils.degToRad(elevationDeg), horizontal = Math.cos(elevation); return north.multiplyScalar(horizontal * Math.cos(azimuth)).add(east.multiplyScalar(horizontal * Math.sin(azimuth))).add(up.multiplyScalar(Math.sin(elevation))).normalize().multiplyScalar(radius); }
function updateScene(current, local, remote) {
  if (!current || !state.scene) return; const THREE = state.THREE; state.scene.moon.position.copy(horizontalPoint(THREE, local, current.azimuth_deg, current.elevation_deg, 3.1)); state.scene.sun.position.copy(horizontalPoint(THREE, local, current.sun_azimuth_deg, current.sun_elevation_deg, 4.6)); state.scene.light.position.copy(state.scene.sun.position).multiplyScalar(2); state.scene.localPin.position.copy(globePoint(local)); state.scene.remotePin.visible = Boolean(remote); if (remote) state.scene.remotePin.position.copy(globePoint(remote)); state.scene.pathLine.geometry.setFromPoints([state.scene.localPin.position, state.scene.moon.position]); state.scene.pathLine.computeLineDistances();
  $("#stat-az").textContent = `${current.azimuth_deg.toFixed(1)}°`; $("#stat-el").textContent = `${current.elevation_deg.toFixed(1)}°`; $("#stat-delay").textContent = `${(current.round_trip_ms / 1000).toFixed(3)} s`; $("#stat-delay").parentElement.title = `${Math.round(current.distance_km * 2).toLocaleString()} km Earth-Moon-Earth vacuum path. Radio airtime, transmit queueing, and receiver decode time are additional.`; $("#stat-doppler").textContent = `${current.doppler_hz > 0 ? "+" : ""}${current.doppler_hz.toFixed(0)} Hz`;
}

function celebrate(detection) {
  $("#detection-score").textContent = `${Math.round(detection.confidence * 100)}%`; $("#detection-detail").textContent = `${detection.tx_callsign} → Moon → ${detection.rx_callsign} · measured ${detection.delay_ms} ms · predicted ${detection.predicted_delay_ms} ms`; $("#detection").hidden = false;
  try { const audio = new AudioContext(); [0, .16, .32].forEach((delay, index) => { const osc = audio.createOscillator(), gain = audio.createGain(); osc.frequency.value = [440, 659, 880][index]; gain.gain.setValueAtTime(.001, audio.currentTime + delay); gain.gain.exponentialRampToValueAtTime(.16, audio.currentTime + delay + .02); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + delay + .4); osc.connect(gain).connect(audio.destination); osc.start(audio.currentTime + delay); osc.stop(audio.currentTime + delay + .45); }); } catch (_) {}
}

$("#dismiss-detection").addEventListener("click", () => { $("#detection").hidden = true; });
const checksPanel = $("#recommendations");
checksPanel.open = localStorage.getItem("moonbird:checks-open") === "true";
checksPanel.addEventListener("toggle", () => localStorage.setItem("moonbird:checks-open", String(checksPanel.open)));
$("#copy-room").addEventListener("click", async () => {
  try { await copyText(`${location.origin}/?room=${state.room.code}`); toast("Room link copied"); }
  catch (error) { toast(`${error.message}. Select the link and copy it manually.`); }
});
$("#agent-server").addEventListener("input", updateAgentCommand);
$("#radio-host").addEventListener("input", updateAgentCommand);
$("#copy-agent-command").addEventListener("click", async () => {
  try { await copyText($("#agent-command").textContent); toast("Agent command copied"); }
  catch (error) {
    const range = document.createRange();
    range.selectNodeContents($("#agent-command"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast(`${error.message}. The command is selected; press Ctrl+C or Command+C.`);
  }
});
$("#leave-room").addEventListener("click", () => { state.socket?.close(); state.room = null; history.replaceState({}, "", "/"); location.reload(); });
setInterval(() => { $("#utc-clock").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"; }, 1000);
setInterval(() => { if (state.room) loadForecast(); }, 60000);
function escapeHtml(text) { const div = document.createElement("div"); div.textContent = text; return div.innerHTML; }
document.documentElement.dataset.appReady = "true";
restoreRoom();
