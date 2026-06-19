import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { TransportHTTP } from "@meshtastic/transport-http";

const PORT_KINDS = {
  TEXT_MESSAGE_APP: "text",
  NODEINFO_APP: "nodeinfo",
  TELEMETRY_APP: "telemetry",
  ROUTING_APP: "ack_or_routing",
  POSITION_APP: "position",
  NEIGHBORINFO_APP: "neighborinfo",
};

function jsonSafe(value) {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { base64: btoa(binary) };
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  return value;
}

function classifyPacket(packet) {
  const decoded = packet.payloadVariant?.case === "decoded" ? packet.payloadVariant.value : null;
  const portName = decoded ? Protobuf.Portnums.PortNum[decoded.portnum] : "ENCRYPTED";
  let text = "";
  if (portName === "TEXT_MESSAGE_APP" && decoded?.payload) text = new TextDecoder().decode(decoded.payload);
  const sequence = text.match(/(?:^|\s)#(\d+)\s*$/);
  return {
    kind: sequence ? "moonbird_probe" : (PORT_KINDS[portName] || portName.toLowerCase()),
    packetId: sequence?.[1] || String(packet.id || ""),
    text,
  };
}

function destination(value) {
  if (!value || value === "^all") return "broadcast";
  if (value.startsWith("!")) return Number.parseInt(value.slice(1), 16);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : "broadcast";
}

async function confirmHttpReachable(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export class BrowserRadio {
  constructor({ onStatus, onTraffic }) {
    this.onStatus = onStatus;
    this.onTraffic = onTraffic;
    this.device = null;
    this.boardModel = null;
    this.outgoingText = null;
  }

  async connect(transportType, target = "", bluetoothDevice = null) {
    let transport;
    if (transportType === "bluetooth") {
      if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable in this browser.");
      transport = bluetoothDevice ? await TransportWebBluetooth.createFromDevice(bluetoothDevice) : await TransportWebBluetooth.create();
    } else if (transportType === "serial") {
      if (!navigator.serial) throw new Error("Web Serial is unavailable in this browser.");
      transport = await TransportWebSerial.create();
    } else if (transportType === "http") {
      const url = new URL(target.includes("://") ? target : `http://${target}`);
      await confirmHttpReachable(url.href);
      transport = await TransportHTTP.create(url.host, url.protocol === "https:");
    } else {
      throw new Error(`Unsupported browser radio transport: ${transportType}`);
    }

    this.device = new MeshDevice(transport);
    this.device.events.onMeshPacket.subscribe((packet) => {
      const { kind, packetId, text } = classifyPacket(packet);
      if (text && text === this.outgoingText) return;
      this.onTraffic({
        direction: "rx",
        kind,
        packet_id: packetId,
        payload: jsonSafe(packet),
        observed_at: new Date().toISOString(),
      });
    });
    this.device.events.onDeviceMetadataPacket.subscribe((packet) => {
      const model = packet.data?.hwModel;
      this.boardModel = typeof model === "number" ? Protobuf.Mesh.HardwareModel[model] : model;
      this.onStatus(true, this.boardModel);
    });
    this.device.events.onDeviceStatus.subscribe((status) => {
      if (status === Types.DeviceStatusEnum.DeviceConfigured) this.onStatus(true, this.boardModel);
      if (status === Types.DeviceStatusEnum.DeviceDisconnected) this.onStatus(false, this.boardModel);
    });
    await this.device.configure();
    this.device.setHeartbeatInterval(300_000);
  }

  async transmit(command) {
    if (!this.device) throw new Error("Radio is not connected.");
    this.outgoingText = command.wire_text;
    let packetId;
    try {
      packetId = await this.device.sendText(
        command.wire_text,
        destination(command.destination),
        Boolean(command.want_ack),
        Number(command.channel || 0),
      );
    } finally {
      this.outgoingText = null;
    }
    return {
      direction: "tx",
      kind: "moonbird_probe",
      packet_id: String(command.sequence ?? packetId),
      payload: { text: command.wire_text, command, meshtastic_packet_id: packetId },
      observed_at: new Date().toISOString(),
    };
  }

  async disconnect() {
    if (this.device) await this.device.disconnect();
    this.device = null;
    this.onStatus(false, this.boardModel);
  }
}
