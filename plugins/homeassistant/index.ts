import { z } from "zod";
import type {
  Device,
  DeviceAction,
  DeviceActionParams,
  DeviceAdapter,
} from "../../src/handlers/devices";
import { RegistrablePlugin } from "../../src/plugin";
import { DeviceManagerError } from "../../src/types/errors";

interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

const DEFAULT_DOMAINS = [
  "light",
  "switch",
  "input_boolean",
  "fan",
  "cover",
  "climate",
  "lock",
  "media_player",
  "vacuum",
  "scene",
  "script",
];

const action = (
  id: string,
  description: string,
  parameters?: DeviceAction["parameters"],
): DeviceAction => ({
  id,
  name: id.replaceAll("_", " "),
  description,
  parameters,
});

const POWER_ACTIONS = [
  action("turn_on", "Turn the device on"),
  action("turn_off", "Turn the device off"),
  action("toggle", "Toggle the device"),
];

// Action ids are the Home Assistant service names of the entity's domain
const DOMAIN_ACTIONS: Record<string, DeviceAction[]> = {
  light: [
    action("turn_on", "Turn the light on, optionally changing how it looks", {
      brightness_pct: { type: "number", description: "Brightness, 0 to 100" },
      color_name: { type: "string", description: "CSS color name, e.g. red" },
      color_temp_kelvin: {
        type: "number",
        description: "White temperature in kelvin, e.g. 2700 for warm white",
      },
    }),
    action("turn_off", "Turn the light off"),
    action("toggle", "Toggle the light"),
  ],
  switch: POWER_ACTIONS,
  input_boolean: POWER_ACTIONS,
  fan: [
    ...POWER_ACTIONS,
    action("set_percentage", "Set the fan speed", {
      percentage: {
        type: "number",
        description: "Speed, 0 to 100",
        required: true,
      },
    }),
  ],
  cover: [
    action("open_cover", "Open the cover"),
    action("close_cover", "Close the cover"),
    action("stop_cover", "Stop the cover"),
    action("set_cover_position", "Move the cover to a position", {
      position: {
        type: "number",
        description: "0 is closed, 100 is fully open",
        required: true,
      },
    }),
  ],
  climate: [
    action("turn_on", "Turn the thermostat on"),
    action("turn_off", "Turn the thermostat off"),
    action("set_temperature", "Set the target temperature", {
      temperature: { type: "number", required: true },
    }),
    action("set_hvac_mode", "Change the operating mode", {
      hvac_mode: {
        type: "string",
        description: "One of the hvac_modes listed in the device state",
        required: true,
      },
    }),
  ],
  lock: [action("lock", "Lock"), action("unlock", "Unlock")],
  media_player: [
    action("turn_on", "Turn the player on"),
    action("turn_off", "Turn the player off"),
    action("media_play", "Resume playback"),
    action("media_pause", "Pause playback"),
    action("media_stop", "Stop playback"),
    action("media_next_track", "Skip to the next track"),
    action("media_previous_track", "Go back to the previous track"),
    action("volume_set", "Set the volume", {
      volume_level: {
        type: "number",
        description: "Volume, 0.0 to 1.0",
        required: true,
      },
    }),
  ],
  vacuum: [
    action("start", "Start or resume cleaning"),
    action("pause", "Pause cleaning"),
    action("return_to_base", "Send the vacuum back to its dock"),
  ],
  scene: [action("turn_on", "Activate the scene")],
  script: [action("turn_on", "Run the script")],
};

// Attributes worth showing to the model; the rest is mostly noise
const STATE_ATTRIBUTES = [
  "brightness",
  "color_temp_kelvin",
  "percentage",
  "current_position",
  "temperature",
  "current_temperature",
  "hvac_modes",
  "hvac_action",
  "volume_level",
  "media_title",
  "media_artist",
  "battery_level",
  "unit_of_measurement",
];

const CACHE_MS = 5000;

class HomeAssistantAdapter implements DeviceAdapter {
  readonly name = "homeassistant";
  private cache?: { devices: Device[]; fetchedAt: number };

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly domains: string[],
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok)
      throw new DeviceManagerError(
        `Home Assistant responded with ${response.status} ${response.statusText}`,
      );

    return (await response.json()) as T;
  }

  private toDevice(entity: EntityState): Device | null {
    const domain = entity.entity_id.split(".")[0];
    const actions = DOMAIN_ACTIONS[domain];
    if (!actions || !this.domains.includes(domain)) return null;

    const state: Record<string, unknown> = { state: entity.state };
    for (const attribute of STATE_ATTRIBUTES) {
      const value = entity.attributes[attribute];
      if (value !== undefined && value !== null) state[attribute] = value;
    }

    return {
      id: entity.entity_id,
      name: String(entity.attributes.friendly_name ?? entity.entity_id),
      type: domain,
      state,
      actions,
    };
  }

  /** Verify the URL and token, failing loudly at startup instead of later. */
  async check(): Promise<void> {
    await this.request<unknown>("");
  }

  async getDevices(): Promise<Device[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_MS)
      return this.cache.devices;

    const entities = await this.request<EntityState[]>("states");
    const devices = entities
      .map((entity) => this.toDevice(entity))
      .filter((device) => device !== null);

    this.cache = { devices, fetchedAt: Date.now() };
    return devices;
  }

  async getDevice(idOrName: string): Promise<Device | null> {
    const wanted = idOrName.trim().toLowerCase();
    const devices = await this.getDevices();

    return (
      devices.find((device) => device.id === wanted) ??
      devices.find((device) => device.name.toLowerCase() === wanted) ??
      null
    );
  }

  async executeAction(
    deviceId: string,
    actionId: string,
    params: DeviceActionParams = {},
  ): Promise<boolean> {
    const device = await this.getDevice(deviceId);
    const deviceAction = device?.actions.find((a) => a.id === actionId);
    if (!device || !deviceAction) return false;

    // Only forward the parameters the action declares
    const data: Record<string, unknown> = { entity_id: device.id };
    for (const name of Object.keys(deviceAction.parameters ?? {}))
      if (params[name] !== undefined) data[name] = params[name];

    await this.request(`services/${device.type}/${deviceAction.id}`, data);

    // The state just changed, make the next read hit Home Assistant
    this.cache = undefined;
    return true;
  }
}

export default class HomeAssistantPlugin extends RegistrablePlugin {
  readonly name = "homeassistant";

  async register(): Promise<void> {
    const [url, token, domains] = this.assistant
      .getHandler("setting")
      .getSettings([
        "HOMEASSISTANT_URL",
        "HOMEASSISTANT_TOKEN",
        "HOMEASSISTANT_DOMAINS",
      ]);

    if (!url?.value || !token?.value)
      throw new Error("HOMEASSISTANT_URL or HOMEASSISTANT_TOKEN is not set");

    const adapter = new HomeAssistantAdapter(
      (url.value as string).replace(/\/+$/, ""),
      token.value as string,
      Array.isArray(domains?.value)
        ? (domains.value as string[])
        : DEFAULT_DOMAINS,
    );

    await adapter.check();
    this.assistant.getHandler("device").registerAdapter(adapter);

    const devices = await adapter.getDevices();
    this.logger().info(`Found ${devices.length} Home Assistant devices`);
  }

  async unregister(): Promise<void> {}

  override getSettings(): Record<string, z.ZodTypeAny> {
    return {
      HOMEASSISTANT_URL: z
        .string()
        .describe("Home Assistant URL, for example http://homeassistant:8123"),
      HOMEASSISTANT_TOKEN: z
        .string()
        .describe("Home Assistant long-lived access token"),
      HOMEASSISTANT_DOMAINS: z
        .array(z.string())
        .default(DEFAULT_DOMAINS)
        .describe("Entity domains exposed to the assistant"),
    };
  }
}
