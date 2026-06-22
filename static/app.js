const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { room: null, callsign: null, adminToken: null, agentToken: null, socket: null, browserRadio: null, radioLongName: null, selectedBluetoothDevice: null, span: "day", forecastScroll: new Map(), scrollForecastToToday: null, traffic: [], chat: [], filter: "all", expandedTrafficId: null, scene: null, bluetoothScan: null, bluetoothAdvertisementHandler: null, bluetoothDevices: new Map() };
const THEME_KEY = "moonbird:theme";
const MESHTASTIC_BLUETOOTH_SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
const BLUETOOTH_IDENTIFIER_VERSION = "advertised-name-v2";
const STATION_COLORS = ["#ff6b3d", "#4da3ff", "#63c7ad", "#b48cff", "#f0c84b", "#ff78a8", "#42d4e8", "#a9e82e"];

function activeStations() {
  const stations = state.room?.participants.filter((station) => station.role !== "observer") || [];
  const local = localStation();
  return local ? [local, ...stations.filter((station) => station.callsign !== local.callsign)] : stations;
}

function stationColor(callsign) {
  const index = activeStations().findIndex((station) => station.callsign === callsign);
  return STATION_COLORS[(index < 0 ? 0 : index) % STATION_COLORS.length];
}

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
function equipment() { return { frequency_mhz: 145.05, amplifier_w: 50, antenna_gain_dbi: 11.6 }; }
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
  renderRoom(); connectSocket(); initScene().then(loadForecast); loadTraffic(); loadChat();
}

function renderRoom() {
  $("#room-title").textContent = state.room.title;
  $("#station-count").textContent = `${state.room.participants.length} station${state.room.participants.length === 1 ? "" : "s"}`;
  const container = $("#participants"); container.innerHTML = "";
  for (const station of state.room.participants) {
    const row = document.createElement("div"); row.className = "participant";
    const icon = document.createElement("div"); icon.className = "participant-icon"; icon.textContent = station.callsign.slice(0, 2); icon.style.backgroundColor = station.role === "observer" ? "var(--muted)" : stationColor(station.callsign);
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

function shellArgument(value) {
  if (!/[\s"'\\]/.test(value)) return value;
  if (/Windows/i.test(navigator.userAgent)) return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.split("'").join("'\"'\"'")}'`;
}

function initializeAgentSetup() {
  const serverInput = $("#agent-server");
  const radioInput = $("#radio-host");
  if (!serverInput.value) serverInput.value = localStorage.getItem("moonbird:agent-server") || defaultAgentServer();
  if (!radioInput.value) radioInput.value = localStorage.getItem("moonbird:radio-host") || "meshtastic.local";
  if (!$("#serial-port").value) $("#serial-port").value = localStorage.getItem("moonbird:serial-port") || "";
  if (localStorage.getItem("moonbird:bluetooth-identifier-version") !== BLUETOOTH_IDENTIFIER_VERSION) {
    localStorage.removeItem("moonbird:bluetooth-address");
    localStorage.setItem("moonbird:bluetooth-identifier-version", BLUETOOTH_IDENTIFIER_VERSION);
  }
  if (!$("#bluetooth-address").value) $("#bluetooth-address").value = localStorage.getItem("moonbird:bluetooth-address") || "";
  if (!$("#radio-transport").dataset.initialized) {
    let savedTransport = localStorage.getItem("moonbird:radio-transport") || "http";
    if (localStorage.getItem("moonbird:radio-transport-version") !== "http-v2") {
      if (savedTransport === "tcp") savedTransport = "http";
      localStorage.setItem("moonbird:radio-transport-version", "http-v2");
    }
    $("#radio-transport").value = savedTransport;
    $("#radio-transport").dataset.initialized = "true";
  }
  updateRadioTransport();
  updateAgentCommand();
}

function updateRadioTransport() {
  const transport = $("#radio-transport").value;
  $$('[data-radio-transport]').forEach((element) => { element.hidden = !element.dataset.radioTransport.split(",").includes(transport); });
  const browserButton = $("#connect-browser-radio");
  browserButton.disabled = transport === "tcp";
  browserButton.textContent = transport === "tcp" ? "Raw TCP requires terminal companion" : "Connect in browser";
  localStorage.setItem("moonbird:radio-transport", transport);
  updateAgentCommand();
}

function updateAgentCommand() {
  if (!state.room) return;
  const server = $("#agent-server").value.trim() || defaultAgentServer();
  const transport = $("#radio-transport").value;
  const targets = {
    http: { flag: "--radio-host", storageKey: "moonbird:radio-host", value: $("#radio-host").value.trim() || "meshtastic.local" },
    tcp: { flag: "--radio-host", storageKey: "moonbird:radio-host", value: $("#radio-host").value.trim() || "meshtastic.local" },
    serial: { flag: "--serial-port", storageKey: "moonbird:serial-port", value: $("#serial-port").value.trim() },
    bluetooth: { flag: "--bluetooth-address", storageKey: "moonbird:bluetooth-address", value: $("#bluetooth-address").value.trim() },
  };
  const target = targets[transport];
  localStorage.setItem("moonbird:agent-server", server);
  localStorage.setItem(target.storageKey, target.value);
  const command = $("#agent-command");
  const copyButton = $("#copy-agent-command");
  if (!target.value) {
    command.textContent = transport === "bluetooth" ? "Select a Bluetooth device or enter its address." : "Enter the serial port.";
    command.classList.add("incomplete");
    copyButton.disabled = true;
    return;
  }
  const python = /Windows/i.test(navigator.userAgent) ? ".agent-venv\\Scripts\\python.exe" : ".agent-venv/bin/python";
  command.textContent = `${python} -m moonbird_agent --server ${server} --room ${state.room.code} --callsign ${state.callsign} --token ${state.agentToken} ${target.flag} ${shellArgument(target.value)} --allow-transmit`;
  command.classList.remove("incomplete");
  copyButton.disabled = false;
}

function showBluetoothMessage(message) {
  const results = $("#bluetooth-results");
  results.hidden = false;
  results.innerHTML = "";
  const text = document.createElement("p"); text.textContent = message; results.append(text);
}

function addBluetoothDevice(device) {
  if (!device?.id) return;
  const identifier = device.name?.trim();
  state.bluetoothDevices.set(device.id, device);
  const results = $("#bluetooth-results");
  results.hidden = false;
  results.querySelector("p")?.remove();
  if (results.querySelector(`[data-device-id="${CSS.escape(device.id)}"]`)) return;
  const button = document.createElement("button"); button.type = "button"; button.dataset.deviceId = device.id; button.setAttribute("role", "option");
  const name = document.createElement("strong"); name.textContent = identifier || "Unnamed Meshtastic device";
  const id = document.createElement("span"); id.textContent = identifier ? "Use advertised name" : "No usable name; enter its OS address manually";
  button.append(name, id);
  button.disabled = !identifier;
  button.addEventListener("click", () => {
    state.selectedBluetoothDevice = device;
    $("#bluetooth-address").value = identifier;
    localStorage.setItem("moonbird:bluetooth-address", identifier);
    updateAgentCommand();
    $$("#bluetooth-results button").forEach((item) => item.setAttribute("aria-selected", String(item === button)));
  });
  results.append(button);
}

async function scanBluetoothDevices() {
  const scanButton = $("#scan-bluetooth");
  if (!navigator.bluetooth) { showBluetoothMessage("Web Bluetooth is unavailable. Enter the device address manually."); return; }
  scanButton.disabled = true; scanButton.textContent = "Scanning…";
  state.bluetoothDevices.clear(); showBluetoothMessage("Scanning for Meshtastic devices…");
  try {
    if (navigator.bluetooth.requestLEScan) {
      state.bluetoothScan?.stop();
      if (state.bluetoothAdvertisementHandler) navigator.bluetooth.removeEventListener("advertisementreceived", state.bluetoothAdvertisementHandler);
      state.bluetoothAdvertisementHandler = (event) => addBluetoothDevice(event.device);
      navigator.bluetooth.addEventListener("advertisementreceived", state.bluetoothAdvertisementHandler);
      state.bluetoothScan = await navigator.bluetooth.requestLEScan({ filters: [{ services: [MESHTASTIC_BLUETOOTH_SERVICE] }], keepRepeatedDevices: false });
      await new Promise((resolve) => setTimeout(resolve, 10000));
      state.bluetoothScan.stop(); state.bluetoothScan = null;
      if (!state.bluetoothDevices.size) showBluetoothMessage("No Meshtastic devices found.");
    } else {
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [MESHTASTIC_BLUETOOTH_SERVICE] }] });
      addBluetoothDevice(device);
    }
  } catch (error) {
    if (error.name !== "NotFoundError") showBluetoothMessage(error.message || "Bluetooth scan failed.");
    else if (!state.bluetoothDevices.size) showBluetoothMessage("No device selected.");
  } finally {
    scanButton.disabled = false; scanButton.textContent = "Scan for devices";
  }
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
  const socket = new WebSocket(`${protocol}://${location.host}/ws/rooms/${state.room.code}?callsign=${encodeURIComponent(state.callsign)}&token=${encodeURIComponent(state.agentToken)}`); state.socket = socket;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "room") { state.room = message.room; renderRoom(); loadForecast(); }
    if (message.type === "traffic") {
      const pendingIndex = message.traffic.direction === "tx"
        ? state.traffic.findIndex((item) => item.pending && item.callsign === message.traffic.callsign && item.packet_id === message.traffic.packet_id)
        : -1;
      if (pendingIndex >= 0) state.traffic.splice(pendingIndex, 1, message.traffic);
      else state.traffic.unshift(message.traffic);
      renderTraffic();
      if (message.traffic.direction === "tx" && pendingIndex < 0) animatePacket(message.traffic.callsign);
    }
    if (message.type === "chat") { state.chat.push(message.message); state.chat = state.chat.slice(-200); renderChat(); }
    if (message.type === "chat_error") toast(message.detail);
    if (message.type === "detection") celebrate(message.detection);
    if (message.type === "agent" && message.callsign === state.callsign) setAgent(message.connected);
    if (message.type === "agent_status" && message.callsign === state.callsign) renderAgentStatus(message.status);
    if (message.type === "transmit" && state.browserRadio) {
      state.browserRadio.transmit(message).then((traffic) => sendRoomMessage({ type: "traffic", traffic })).catch((error) => toast(error.message));
    }
    if (message.type === "disconnect_radio" && state.browserRadio) state.browserRadio.disconnect().catch((error) => toast(error.message));
  });
  socket.addEventListener("open", () => {
    connectSocket.ping = setInterval(() => socket.send("ping"), 20000);
    if (state.browserRadio?.device) sendBrowserRadioStatus(true, state.browserRadio.boardModel, state.browserRadio.longName);
  });
  socket.addEventListener("close", () => { clearInterval(connectSocket.ping); setTimeout(() => state.room && connectSocket(), 2500); });
}

function sendRoomMessage(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function sendBrowserRadioStatus(connected, boardModel = null, longName = null) {
  sendRoomMessage({ type: "radio_status", status: { connected, board_model: boardModel, long_name: longName, transport: $("#radio-transport").value } });
  setAgent(connected, longName);
}

async function connectBrowserRadio() {
  const button = $("#connect-browser-radio"); button.disabled = true; button.textContent = "Connecting…";
  try {
    const { BrowserRadio } = await import("/static/vendor/browser-radio.js?v=9");
    const transport = $("#radio-transport").value;
    if (transport === "tcp") throw new Error("Raw TCP is not available in browsers. Use the terminal companion fallback.");
    const target = transport === "http" ? $("#radio-host").value.trim() || "meshtastic.local" : "";
    if (state.browserRadio?.device) await state.browserRadio.disconnect();
    state.browserRadio = new BrowserRadio({
      onStatus: sendBrowserRadioStatus,
      onTraffic: (traffic) => sendRoomMessage({ type: "traffic", traffic }),
    });
    await state.browserRadio.connect(transport, target, state.selectedBluetoothDevice);
  } catch (error) {
    setAgent(false);
    const transport = $("#radio-transport").value;
    const failedFetch = transport === "http" && (error instanceof TypeError || /failed to fetch/i.test(error.message || ""));
    toast(failedFetch
      ? "Could not reach the node HTTP API. Check its address, CORS/private-network permission, and HTTP/HTTPS compatibility. Raw TCP requires the terminal fallback."
      : error.message || "Radio connection failed.");
  } finally {
    updateRadioTransport();
  }
}

function setAgent(connected, longName = undefined) {
  if (!connected) state.radioLongName = null;
  else if (typeof longName === "string" && longName.trim()) state.radioLongName = longName.trim();
  $("#agent-badge").textContent = connected ? "Radio connected" : "Radio offline";
  $("#agent-badge").classList.toggle("connected", connected);
  $("#radio-station-name").textContent = connected && state.radioLongName ? state.radioLongName : "Local station";
  $("#disconnect-agent").hidden = !connected;
  $("#agent-setup").hidden = connected;
  $("#send-form").hidden = !connected;
}
function renderAgentStatus(status) {
  setAgent(status.connected, status.long_name);
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
  try {
    const result = await api(`/api/rooms/${state.room.code}/transmit/${state.callsign}`, { method: "POST", body: JSON.stringify(request) });
    $("#wire-preview").textContent = result.wire_text;
    const packetId = String(result.sequence);
    const alreadyConfirmed = state.traffic.some((item) => !item.pending && item.callsign === state.callsign && item.direction === "tx" && item.packet_id === packetId);
    if (!alreadyConfirmed) {
      state.traffic.unshift({
        id: `pending:${state.callsign}:${packetId}`,
        callsign: state.callsign,
        direction: "tx",
        kind: "moonbird_probe",
        packet_id: packetId,
        payload: { text: result.wire_text, status: "sent to local radio" },
        observed_at: new Date().toISOString(),
        pending: true,
      });
      renderTraffic();
      animatePacket(state.callsign);
    }
    toast(`Message #${result.sequence} sent to radio`);
  }
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
function decodedFields(value, prefix = "", fields = [], depth = 0) {
  if (fields.length >= 8 || value == null || depth > 2) return fields;
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) fields.push(`${prefix}: ${value.join(", ")}`);
    else fields.push(`${prefix}: ${value.length} item${value.length === 1 ? "" : "s"}`);
    return fields;
  }
  if (typeof value !== "object") {
    fields.push(`${prefix}: ${String(value)}`);
    return fields;
  }
  for (const [key, item] of Object.entries(value)) {
    if (["raw", "payload", "base64", "publicKey", "public_key", "macaddr"].includes(key)) continue;
    const label = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
    decodedFields(item, prefix ? `${prefix} ${label}` : label, fields, depth + 1);
    if (fields.length >= 8) break;
  }
  return fields;
}

function decodedObject(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  const latitude = value.latitudeI ?? value.latitude_i;
  const longitude = value.longitudeI ?? value.longitude_i;
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const location = `${(latitude / 1e7).toFixed(5)}, ${(longitude / 1e7).toFixed(5)}`;
    const extra = decodedFields(Object.fromEntries(Object.entries(value).filter(([key]) => !["latitudeI", "latitude_i", "longitudeI", "longitude_i"].includes(key))));
    return [location, ...extra].join(" · ");
  }
  return decodedFields(value).join(" · ") || "Decoded packet";
}

function decodedTraffic(item) {
  const payload = item.payload || {};
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.decoded_text === "string") return payload.decoded_text;
  const decoded = payload.decoded || (payload.payloadVariant?.case === "decoded" ? payload.payloadVariant.value : null);
  if (typeof decoded?.text === "string") return decoded.text;
  if (decoded && typeof decoded === "object") {
    for (const key of ["routing", "telemetry", "position", "user", "neighborinfo"]) {
      if (decoded[key] != null) return decodedObject(decoded[key]);
    }
    const readable = Object.fromEntries(Object.entries(decoded).filter(([key]) => !["payload", "raw"].includes(key)));
    if (Object.keys(readable).length) return decodedObject(readable);
  }
  return item.kind === "encrypted" ? "Encrypted packet" : `${item.kind} packet${item.packet_id ? ` #${item.packet_id}` : ""}`;
}
function renderTraffic() {
  const stream = $("#traffic-stream"); stream.innerHTML = "";
  const visible = state.filter === "all" ? state.traffic : state.traffic.filter((item) => item.kind === state.filter);
  if (!visible.length) { stream.innerHTML = `<p class="empty">No matching traffic recorded.</p>`; return; }
  for (const item of visible) {
    const row = document.createElement("div"); row.className = "traffic-row";
    const itemId = String(item.id ?? `${item.callsign}:${item.received_at || item.observed_at}:${item.packet_id || ""}`);
    const expanded = state.expandedTrafficId === itemId;
    row.classList.toggle("expanded", expanded); row.tabIndex = 0; row.setAttribute("role", "button"); row.setAttribute("aria-expanded", String(expanded));
    const time = document.createElement("span"); time.textContent = new Date(item.received_at || item.observed_at).toLocaleTimeString();
    const callsign = document.createElement("strong"); callsign.textContent = item.callsign;
    const dir = document.createElement("strong"); dir.className = item.direction; dir.textContent = item.direction.toUpperCase();
    const kind = document.createElement("span"); kind.textContent = item.kind;
    const summary = document.createElement("code"); summary.className = "traffic-summary"; summary.textContent = decodedTraffic(item);
    row.append(time, callsign, dir, kind, summary); row.title = expanded ? "Collapse raw packet" : "Expand raw packet";
    if (expanded) {
      const raw = document.createElement("pre"); raw.className = "raw-packet"; raw.textContent = JSON.stringify(item, null, 2); row.append(raw);
    }
    stream.append(row);
    const toggle = () => { state.expandedTrafficId = expanded ? null : itemId; renderTraffic(); };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggle(); } });
  }
}

async function loadChat() {
  try {
    const history = await api(`/api/rooms/${state.room.code}/chat?limit=50`);
    const messages = new Map([...history, ...state.chat].map((message) => [message.id, message]));
    state.chat = [...messages.values()].sort((left, right) => left.id - right.id).slice(-200);
    renderChat();
  } catch (error) { toast(error.message); }
}
function renderChat() {
  const container = $("#chat-messages"); container.innerHTML = "";
  if (!state.chat.length) { container.innerHTML = '<p class="empty">No messages yet.</p>'; return; }
  for (const message of state.chat) {
    const row = document.createElement("div"); row.className = "chat-message";
    const meta = document.createElement("span"); meta.textContent = `${message.callsign} · ${new Date(message.sent_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const text = document.createElement("p"); text.textContent = message.text;
    row.append(meta, text); container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text; const text = input.value.trim();
  if (!text || state.socket?.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "chat", text })); input.value = "";
});

$$('.stream-filter button[data-kind]').forEach((button) => button.addEventListener("click", () => { $$('.stream-filter button[data-kind]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.kind; renderTraffic(); }));
$("#clear-traffic").addEventListener("click", () => {
  state.traffic = [];
  state.expandedTrafficId = null;
  renderTraffic();
  toast("Live traffic cleared");
});
$$('.tabs button[data-span]').forEach((button) => button.addEventListener("click", () => { $$('.tabs button[data-span]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.span = button.dataset.span; loadForecast(); }));
$("#forecast-today").addEventListener("click", () => state.scrollForecastToToday?.());

async function loadForecast() {
  const local = localStation(); if (!local) return;
  const remotes = activeStations().filter((station) => station.callsign !== local.callsign);
  const baseQuery = { lat: local.latitude, lon: local.longitude, elevation_m: local.elevation_m, frequency_mhz: local.equipment?.frequency_mhz || equipment().frequency_mhz, span: state.span };
  try {
    const forecasts = remotes.length
      ? await Promise.all(remotes.map((remote) => api(`/api/planning?${new URLSearchParams({ ...baseQuery, remote_lat: remote.latitude, remote_lon: remote.longitude, remote_elevation_m: remote.elevation_m })}`)))
      : [await api(`/api/planning?${new URLSearchParams(baseQuery)}`)];
    const localSamples = forecasts[0].samples.map((sample) => sample.tx || sample);
    const series = [{ station: local, samples: localSamples }, ...remotes.map((station, index) => ({ station, samples: forecasts[index].samples.map((sample) => sample.rx) }))];
    renderForecast(series);
    updateScene(localSamples[0], series.map((item) => item.station), remotes.map((station, index) => ({
      station,
      moonPathKm: forecasts[index].samples[0]?.moon_path_distance_km,
      earthPathKm: forecasts[index].earth_path_distance_km,
    })), series.map((item) => ({ callsign: item.station.callsign, distanceKm: item.samples[0]?.distance_km })));
  }
  catch (error) { toast(error.message); }
}

function smoothChartPath(list, field, x, y) {
  const points = list.map((sample, index) => ({ x: x(index), y: y(sample[field]) }));
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  let path = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)], p1 = points[index], p2 = points[index + 1], p3 = points[Math.min(points.length - 1, index + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    path += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return path;
}

function moonSkyPoint(azimuthDeg, elevationDeg) {
  const azimuth = ((azimuthDeg % 360) + 360) % 360;
  const elevation = Math.max(0, Math.min(90, elevationDeg));
  const radius = 110 * (90 - elevation) / 90, angle = azimuth * Math.PI / 180;
  return { x: 150 + radius * Math.sin(angle), y: 150 - radius * Math.cos(angle) };
}

function renderMoonSkyTrack(samples, selectedIndex) {
  const track = $("#moon-sky-track"); if (!track) return;
  const crossing = (from, to) => {
    const part = -from.elevation_deg / (to.elevation_deg - from.elevation_deg);
    const azimuthDelta = ((to.azimuth_deg - from.azimuth_deg + 540) % 360) - 180;
    return moonSkyPoint(from.azimuth_deg + azimuthDelta * part, 0);
  };
  const passes = [];
  for (let index = 0; index < samples.length;) {
    if (samples[index].elevation_deg < 0) { index += 1; continue; }
    const start = index;
    while (index + 1 < samples.length
      && samples[index + 1].elevation_deg >= 0
      && new Date(samples[index + 1].at) - new Date(samples[index].at) <= 18 * 60 * 60 * 1000) index += 1;
    passes.push({ start, end: index }); index += 1;
  }
  if (!passes.length) { track.setAttribute("d", ""); return; }
  const selectedPass = passes.reduce((nearest, pass) => {
    const distance = selectedIndex < pass.start ? pass.start - selectedIndex : selectedIndex > pass.end ? selectedIndex - pass.end : 0;
    return !nearest || distance < nearest.distance ? { ...pass, distance } : nearest;
  }, null);
  const points = [];
  if (selectedPass.start > 0 && new Date(samples[selectedPass.start].at) - new Date(samples[selectedPass.start - 1].at) <= 18 * 60 * 60 * 1000) points.push(crossing(samples[selectedPass.start - 1], samples[selectedPass.start]));
  for (let index = selectedPass.start; index <= selectedPass.end; index += 1) points.push(moonSkyPoint(samples[index].azimuth_deg, samples[index].elevation_deg));
  if (selectedPass.end + 1 < samples.length && new Date(samples[selectedPass.end + 1].at) - new Date(samples[selectedPass.end].at) <= 18 * 60 * 60 * 1000) points.push(crossing(samples[selectedPass.end], samples[selectedPass.end + 1]));
  track.setAttribute("d", points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" "));
}

function renderMoonSky(sample) {
  const marker = $("#moon-sky-marker"), bearing = $("#moon-sky-bearing"), readout = $("#moon-sky-readout");
  if (!marker || !bearing || !readout || !sample) return;
  const azimuth = ((sample.azimuth_deg % 360) + 360) % 360;
  const { x: moonX, y: moonY } = moonSkyPoint(azimuth, sample.elevation_deg);
  marker.setAttribute("cx", moonX.toFixed(2)); marker.setAttribute("cy", moonY.toFixed(2));
  bearing.setAttribute("x2", moonX.toFixed(2)); bearing.setAttribute("y2", moonY.toFixed(2));
  marker.classList.toggle("below-horizon", sample.elevation_deg < 0);
  const at = new Date(sample.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  readout.textContent = `${at} · azimuth ${azimuth.toFixed(1)}° · elevation ${sample.elevation_deg.toFixed(1)}°${sample.elevation_deg < 0 ? " · below horizon" : ""}`;
}

function renderForecast(series) {
  const samples = series[0]?.samples || []; if (!samples.length) return;
  const chart = $("#forecast-chart");
  const chartScale = { hour: 1.5, day: 2, week: 2.5, month: 3.5, year: 4 }[state.span] || 2;
  chart.style.setProperty("--chart-width", `${chartScale * 100}%`);
  const width = 1100, height = 260, left = 42, right = 42, bottom = 25, plotW = width - left - right, plotH = height - bottom - 10;
  const x = (index) => left + index / Math.max(1, samples.length - 1) * plotW;
  const yElevation = (value) => 10 + (90 - Math.max(-30, Math.min(90, value))) / 120 * plotH;
  const yQuality = (value) => 10 + (100 - value) / 100 * plotH;
  const maxDegradation = Math.max(6, Math.ceil(Math.max(...samples.map((sample) => sample.eme_degradation_db || 0)) / 2) * 2);
  const yDegradation = (value) => 10 + (maxDegradation - Math.max(0, Math.min(maxDegradation, value))) / maxDegradation * plotH;
  const sharedVisible = samples.map((_, index) => series.every((item) => item.samples[index]?.visible));
  const windows = series.length > 1 ? sharedVisible.map((visible, index) => visible ? `<rect x="${x(index)}" y="10" width="${plotW / samples.length + 1}" height="${plotH}" fill="var(--lime)" opacity=".23"/>` : "").join("") : "";
  const labels = [0, .25, .5, .75, 1].map((part) => { const index = Math.min(samples.length - 1, Math.floor((samples.length - 1) * part)); const at = new Date(samples[index].at); const label = ["hour", "day"].includes(state.span) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleDateString([], state.span === "year" ? { month: "short" } : { month: "short", day: "numeric" }); return `<span class="chart-label time-label" style="left:${x(index) / width * 100}%;top:${255 / height * 100}%">${label}</span>`; }).join("");
  const stationPaths = series.map((item) => `<path d="${smoothChartPath(item.samples,"elevation_deg",x,yElevation)}" fill="none" stroke="${stationColor(item.station.callsign)}" stroke-width="3" vector-effect="non-scaling-stroke"/>`).join("");
  const points = series.map((item, index) => `<span class="chart-marker station-marker" data-series="${index}" style="--marker-color:${stationColor(item.station.callsign)}"></span>`).join("");
  const startMs = new Date(samples[0].at).getTime(), endMs = new Date(samples.at(-1).at).getTime(), nowMs = Date.now();
  const presentPart = Math.max(0, Math.min(1, (nowMs - startMs) / Math.max(1, endMs - startMs))), presentX = left + presentPart * plotW;
  const presentMarker = `<g class="present-marker"><line x1="${presentX}" x2="${presentX}" y1="10" y2="${10 + plotH}"/></g>`;
  const elevationLabels = [0,30,60,90].map((value) => `<span class="chart-label elevation-label" style="left:${34 / width * 100}%;top:${yElevation(value) / height * 100}%">${value}°</span>`).join("");
  const degradationLabels = [0, .5, 1].map((part) => { const value = maxDegradation * part; return `<span class="chart-label degradation-axis" style="left:${(width - 3) / width * 100}%;top:${yDegradation(value) / height * 100}%">${value.toFixed(0)} dB</span>`; }).join("");
  const labelLayer = `<div class="chart-label-layer">${elevationLabels}${labels}${degradationLabels}<span class="chart-label present-label" style="left:${(presentX + 5) / width * 100}%;top:${21 / height * 100}%">NOW</span>${points}<span class="chart-marker degradation-point"></span></div>`;
  chart.innerHTML = `<div class="chart-track"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><g class="grid">${[0,30,60,90].map((v) => `<line x1="${left}" x2="${left + plotW}" y1="${yElevation(v)}" y2="${yElevation(v)}"/>`).join("")}</g>${windows}${stationPaths}<path d="${smoothChartPath(series[0].samples,"quality",x,yQuality)}" fill="none" stroke="var(--green)" stroke-width="2" stroke-dasharray="6 5" vector-effect="non-scaling-stroke"/><path class="degradation-path" d="${smoothChartPath(samples,"eme_degradation_db",x,yDegradation)}" fill="none" stroke="var(--degradation)" stroke-width="3" vector-effect="non-scaling-stroke"/>${presentMarker}<g class="chart-scrubber"><line y1="10" y2="${10 + plotH}"/></g><rect class="chart-hit-area" x="${left}" y="10" width="${plotW}" height="${plotH}"/></svg>${labelLayer}</div>`;
  $("#forecast-legend").innerHTML = `${series.map((item) => `<span style="--series-color:${stationColor(item.station.callsign)}">${item.station.callsign} elevation</span>`).join("")}<span class="loss">Relative quality</span><span class="degradation">EME degradation dB</span>${series.length > 1 ? '<span class="window">Shared window</span>' : ""}`;
  const svg = $("#forecast-chart svg"), scrubber = svg.querySelector(".chart-scrubber"), markerLayer = chart.querySelector(".chart-label-layer"), readout = $("#forecast-scrub-readout");
  const showSample = (index) => {
    const sampleX = x(index); scrubber.querySelector("line").setAttribute("x1", sampleX); scrubber.querySelector("line").setAttribute("x2", sampleX);
    series.forEach((item, seriesIndex) => { const point = markerLayer.querySelector(`[data-series="${seriesIndex}"]`); point.style.left = `${sampleX / width * 100}%`; point.style.top = `${yElevation(item.samples[index].elevation_deg) / height * 100}%`; });
    const degradationPoint = markerLayer.querySelector(".degradation-point"); degradationPoint.style.left = `${sampleX / width * 100}%`; degradationPoint.style.top = `${yDegradation(samples[index].eme_degradation_db) / height * 100}%`;
    renderMoonSkyTrack(samples, index);
    renderMoonSky(samples[index]);
    const at = new Date(samples[index].at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    readout.textContent = `${at} · ${series.map((item) => `${item.station.callsign} ${item.samples[index].elevation_deg.toFixed(1)}°`).join(" · ")} · degradation ${samples[index].eme_degradation_db.toFixed(2)} dB (sky ${samples[index].sky_noise_degradation_db.toFixed(2)} dB) · Galactic latitude ${samples[index].galactic_latitude_deg.toFixed(1)}°`;
  };
  const sampleAtPointer = (event) => {
    const bounds = svg.getBoundingClientRect();
    const plotLeft = bounds.left + left / width * bounds.width, plotWidth = plotW / width * bounds.width;
    const position = Math.max(0, Math.min(1, (event.clientX - plotLeft) / plotWidth));
    return Math.round(position * (samples.length - 1));
  };
  const hitArea = svg.querySelector(".chart-hit-area"); let drag = null;
  hitArea.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, scroll: chart.scrollLeft, moved: false };
    hitArea.setPointerCapture(event.pointerId); chart.classList.add("dragging"); showSample(sampleAtPointer(event));
  });
  hitArea.addEventListener("pointermove", (event) => {
    if (drag) {
      const delta = event.clientX - drag.x; if (Math.abs(delta) > 3) drag.moved = true;
      chart.scrollLeft = drag.scroll - delta; state.forecastScroll.set(state.span, chart.scrollLeft);
    }
    showSample(sampleAtPointer(event));
  });
  const endDrag = (event) => { if (!drag) return; if (!drag.moved) showSample(sampleAtPointer(event)); drag = null; chart.classList.remove("dragging"); };
  hitArea.addEventListener("pointerup", endDrag); hitArea.addEventListener("pointercancel", endDrag);
  const scrollToToday = (behavior = "smooth") => {
    const markerPixel = presentX / width * svg.clientWidth;
    chart.scrollTo({ left: Math.max(0, markerPixel - chart.clientWidth * .12), behavior });
    state.forecastScroll.set(state.span, Math.max(0, markerPixel - chart.clientWidth * .12));
    showSample(Math.round(presentPart * (samples.length - 1)));
  };
  state.scrollForecastToToday = scrollToToday;
  chart.onscroll = () => state.forecastScroll.set(state.span, chart.scrollLeft);
  requestAnimationFrame(() => {
    if (state.forecastScroll.has(state.span)) chart.scrollLeft = state.forecastScroll.get(state.span);
    else scrollToToday("auto");
  });
  showSample(0);
  const visible = series.length > 1 ? sharedVisible.filter(Boolean).length : samples.filter((sample) => sample.visible).length;
  const visibilityNote = series.length > 1 ? `${visible} of ${samples.length} samples have simultaneous Moon visibility for all ${series.length} active stations.` : `${visible} of ${samples.length} samples have the Moon above your horizon.`;
  $("#forecast-note").textContent = `${visibilityNote} Galactic degradation is an approximate frequency-scaled sky-noise model.`;
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
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08; host.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enablePan = false; controls.minDistance = 3; controls.maxDistance = 9;
  const loader = new THREE.TextureLoader();
  const earthTexture = loader.load("/static/assets/earth-blue-marble.jpg");
  earthTexture.colorSpace = THREE.SRGBColorSpace;
  earthTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  const moonTexture = createMoonTexture(THREE, renderer, 512);
  const sunTexture = createSunTexture(THREE, renderer, 512);
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshPhongMaterial({ map: earthTexture, color: 0xffffff, emissive: 0x07100f, emissiveIntensity: .06, shininess: 7 })); scene.add(earth);
  const moonVisibility = createMoonVisibilityRing(THREE); scene.add(moonVisibility);
  const grid = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1.006, 16, 8)), new THREE.LineBasicMaterial({ color: 0x9ad8ce, transparent: true, opacity: .13 })); scene.add(grid);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(.25, 48, 24), new THREE.MeshStandardMaterial({ map: moonTexture, color: 0xffffff, roughness: .95 })); moon.position.set(3.2, .7, 0); scene.add(moon);
  const sun = new THREE.Mesh(new THREE.SphereGeometry(.2, 48, 24), new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xffc86a })); sun.position.set(-4, 2, -1); scene.add(sun);
  const light = new THREE.DirectionalLight(0xfff0cc, 3.6); light.position.copy(sun.position); const ambient = new THREE.AmbientLight(0x52726c, .12); scene.add(light, light.target, ambient);
  const stars = createStars(THREE, 720); scene.add(stars);
  const milkyWay = createMilkyWay(THREE, 2800); scene.add(milkyWay);
  function resize() { const rect = host.getBoundingClientRect(); renderer.setSize(rect.width, rect.height, false); camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(host); resize();
  const packetPulses = [];
  function frame(now) {
    controls.update(); stars.rotation.y += .000025;
    for (let index = packetPulses.length - 1; index >= 0; index -= 1) {
      const pulse = packetPulses[index], progress = Math.min(1, (now - pulse.startedAt) / pulse.duration);
      const legProgress = progress <= .5 ? progress * 2 : (progress - .5) * 2;
      if (progress <= .5) pulse.packet.position.lerpVectors(pulse.origin, pulse.moon, legProgress);
      else pulse.packet.position.lerpVectors(pulse.moon, pulse.origin, legProgress);
      pulse.packet.scale.setScalar(.8 + Math.sin(progress * Math.PI) * 1.8);
      pulse.packet.material.opacity = progress < .88 ? 1 : (1 - progress) / .12;
      const launchProgress = Math.min(1, progress * 2);
      pulse.ring.scale.setScalar(1 + launchProgress * 5);
      pulse.ring.material.opacity = Math.max(0, .9 - launchProgress);
      if (progress < 1) continue;
      scene.remove(pulse.packet, pulse.ring);
      pulse.packet.geometry.dispose(); pulse.packet.material.dispose();
      pulse.ring.geometry.dispose(); pulse.ring.material.dispose();
      packetPulses.splice(index, 1);
    }
    renderer.render(scene, camera); requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  state.scene = { scene, earth, moonVisibility, grid, moon, sun, stars, milkyWay, light, ambient, stationObjects: new Map(), packetPulses };
  applySceneTheme();
}

function applySceneTheme() {
  if (!state.scene) return;
  const theme = document.documentElement.dataset.theme;
  const colors = theme === "night"
    ? { earth: 0x7a100c, emissive: 0x160000, grid: 0xff1f16, moon: 0x8a1510, sun: 0xff2418, stars: 0xb51812, milky: 0xff3028, light: 0xff2418, ambient: 0x330000, local: 0xff3b30, remote: 0xa6120c, path: 0xff2418 }
    : theme === "dark"
      ? { earth: 0xa8b5b0, emissive: 0x06100e, grid: 0x84b8ae, moon: 0xbdbbb2, sun: 0xffbd68, stars: 0xb8d2ce, milky: 0xb9d9ff, light: 0xffe4b5, ambient: 0x354842, local: 0xc9ff45, remote: 0x4da3ff, path: 0xc9ff45 }
      : { earth: 0xffffff, emissive: 0x07100f, grid: 0x9ad8ce, moon: 0xffffff, sun: 0xffc86a, stars: 0xe7f4f6, milky: 0xc8deff, light: 0xfff0cc, ambient: 0x52726c, local: 0xc9ff45, remote: 0x4da3ff, path: 0xc9ff45 };
  state.scene.earth.material.color.setHex(colors.earth);
  state.scene.earth.material.emissive.setHex(colors.emissive);
  state.scene.grid.material.color.setHex(colors.grid);
  state.scene.moon.material.color.setHex(colors.moon);
  state.scene.sun.material.color.setHex(colors.sun);
  state.scene.stars.material.color.setHex(colors.stars);
  state.scene.milkyWay.material.color.setHex(colors.milky);
  state.scene.light.color.setHex(colors.light);
  state.scene.ambient.color.setHex(colors.ambient);
  state.scene.ambient.intensity = theme === "night" ? .27 : theme === "dark" ? .23 : .2;
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

function createMilkyWay(THREE, count) {
  const positions = new Float32Array(count * 3);
  let seed = 0x4d4f4f4e;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
  const matrix = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [0.4941094279, -0.4448296300, 0.7469822445],
    [-0.8676661490, -0.1980763734, 0.4559837762],
  ];
  for (let index = 0; index < count; index += 1) {
    const longitude = random() < .42 ? gaussian() * .42 : random() * Math.PI * 2;
    const latitude = THREE.MathUtils.degToRad(Math.max(-24, Math.min(24, gaussian() * 6.5)));
    const galactic = [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
    const equatorial = [0, 1, 2].map((column) => matrix[0][column] * galactic[0] + matrix[1][column] * galactic[1] + matrix[2][column] * galactic[2]);
    const radius = 24 + random() * 5;
    positions[index * 3] = equatorial[0] * radius;
    positions[index * 3 + 1] = equatorial[2] * radius;
    positions[index * 3 + 2] = -equatorial[1] * radius;
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xc8deff, size: 1.5, sizeAttenuation: false, transparent: true, opacity: .48, depthWrite: false }));
}

function createMoonVisibilityRing(THREE) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.018, .007, 8, 160),
    new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: .9, depthWrite: false }),
  );
  ring.renderOrder = 3;
  return ring;
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
function animatePacket(callsign) {
  if (!state.room?.participants.some((station) => station.callsign === callsign)) return;
  const sceneState = state.scene, stationObject = sceneState?.stationObjects.get(callsign);
  if (!sceneState || !stationObject) return;
  const THREE = state.THREE, color = stationColor(callsign), origin = stationObject.pin.position.clone(), moon = sceneState.moon.position.clone();
  const packet = new THREE.Mesh(
    new THREE.SphereGeometry(.045, 16, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  packet.position.copy(origin);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(.055, .075, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.position.copy(origin); ring.lookAt(moon);
  sceneState.scene.add(packet, ring);
  const roundTripMs = 2 * (stationObject.moonDistanceKm || 384400) / 299792.458 * 1000;
  sceneState.packetPulses.push({ packet, ring, origin, moon, startedAt: performance.now(), duration: roundTripMs });
}
function updateScene(current, stations, paths = [], stationRanges = []) {
  if (!current || !state.scene || !stations.length) return;
  const THREE = state.THREE, local = stations[0];
  state.scene.moon.position.copy(horizontalPoint(THREE, local, current.azimuth_deg, current.elevation_deg, 3.1));
  state.scene.moonVisibility.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), state.scene.moon.position.clone().normalize());
  state.scene.sun.position.copy(horizontalPoint(THREE, local, current.sun_azimuth_deg, current.sun_elevation_deg, 4.6));
  state.scene.light.position.copy(state.scene.sun.position).multiplyScalar(2);
  state.scene.milkyWay.rotation.y = -THREE.MathUtils.degToRad(current.gmst_deg);
  const activeCallsigns = new Set(stations.map((station) => station.callsign));
  const rangesByCallsign = new Map(stationRanges.map((item) => [item.callsign, item.distanceKm]));
  for (const [callsign, object] of state.scene.stationObjects) {
    if (activeCallsigns.has(callsign)) continue;
    state.scene.scene.remove(object.pin, object.pathLine);
    object.pin.geometry.dispose(); object.pin.material.dispose(); object.pathLine.geometry.dispose(); object.pathLine.material.dispose();
    state.scene.stationObjects.delete(callsign);
  }
  for (const station of stations) {
    let object = state.scene.stationObjects.get(station.callsign);
    if (!object) {
      const color = stationColor(station.callsign);
      const pin = new THREE.Mesh(new THREE.SphereGeometry(.05, 12, 8), new THREE.MeshBasicMaterial({ color }));
      const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color, dashSize: .12, gapSize: .08, transparent: true, opacity: .82 }));
      object = { pin, pathLine }; state.scene.stationObjects.set(station.callsign, object); state.scene.scene.add(pin, pathLine);
    }
    object.pin.position.copy(globePoint(station));
    object.moonDistanceKm = rangesByCallsign.get(station.callsign) || current.distance_km;
    object.pathLine.geometry.setFromPoints([object.pin.position, state.scene.moon.position]); object.pathLine.computeLineDistances();
  }
  $("#stat-az").textContent = `${current.azimuth_deg.toFixed(1)}°`; $("#stat-el").textContent = `${current.elevation_deg.toFixed(1)}°`; $("#stat-delay").textContent = `${(current.round_trip_ms / 1000).toFixed(3)} s`; $("#stat-delay").parentElement.title = `${Math.round(current.distance_km * 2).toLocaleString()} km Earth-Moon-Earth vacuum path. Radio airtime, transmit queueing, and receiver decode time are additional.`; $("#stat-doppler").textContent = `${current.doppler_hz > 0 ? "+" : ""}${current.doppler_hz.toFixed(0)} Hz`;
  $("#stat-moon-distance").textContent = `${Math.round(current.distance_km).toLocaleString()} km`;
  const moonDistances = paths.map((path) => path.moonPathKm).filter((value) => value != null);
  const earthDistances = paths.map((path) => path.earthPathKm).filter((value) => value != null);
  const distanceRange = (values) => !values.length ? "—" : values.length === 1 ? `${Math.round(values[0]).toLocaleString()} km` : `${Math.round(Math.min(...values)).toLocaleString()}–${Math.round(Math.max(...values)).toLocaleString()} km`;
  $("#stat-moon-path").textContent = distanceRange(moonDistances);
  $("#stat-earth-path").textContent = distanceRange(earthDistances);
  $("#stat-moon-path-label").textContent = paths.length ? `Via Moon to ${paths.length} station${paths.length === 1 ? "" : "s"}` : "Via Moon";
  $("#stat-earth-path-label").textContent = paths.length ? `Via Earth to ${paths.length} station${paths.length === 1 ? "" : "s"}` : "Via Earth";
}

function celebrate(detection) {
  $("#detection-score").textContent = `${Math.round(detection.confidence * 100)}%`; $("#detection-detail").textContent = `${detection.tx_callsign} → Moon → ${detection.rx_callsign} · measured ${detection.delay_ms} ms · predicted ${detection.predicted_delay_ms} ms`; $("#detection").hidden = false;
  try { const audio = new AudioContext(); [0, .16, .32].forEach((delay, index) => { const osc = audio.createOscillator(), gain = audio.createGain(); osc.frequency.value = [440, 659, 880][index]; gain.gain.setValueAtTime(.001, audio.currentTime + delay); gain.gain.exponentialRampToValueAtTime(.16, audio.currentTime + delay + .02); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + delay + .4); osc.connect(gain).connect(audio.destination); osc.start(audio.currentTime + delay); osc.stop(audio.currentTime + delay + .45); }); } catch (_) {}
}

$("#dismiss-detection").addEventListener("click", () => { $("#detection").hidden = true; });
$("#copy-room").addEventListener("click", async () => {
  try { await copyText(`${location.origin}/?room=${state.room.code}`); toast("Room link copied"); }
  catch (error) { toast(`${error.message}. Select the link and copy it manually.`); }
});
$("#agent-server").addEventListener("input", updateAgentCommand);
$("#radio-host").addEventListener("input", updateAgentCommand);
$("#serial-port").addEventListener("input", updateAgentCommand);
$("#bluetooth-address").addEventListener("input", updateAgentCommand);
$("#radio-transport").addEventListener("change", updateRadioTransport);
$("#scan-bluetooth").addEventListener("click", scanBluetoothDevices);
$("#connect-browser-radio").addEventListener("click", connectBrowserRadio);
$("#disconnect-agent").addEventListener("click", async () => {
  const button = $("#disconnect-agent"); button.disabled = true; button.textContent = "Disconnecting…";
  try {
    await api(`/api/rooms/${state.room.code}/radio/${state.callsign}/disconnect`, { method: "POST", body: JSON.stringify({ agent_token: state.agentToken }) });
    setAgent(false);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "Disconnect radio"; }
});
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
