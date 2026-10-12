import z from "zod";
import { DeviceManagerError, InvalidAdapterError } from "../types/errors";
import { Handler } from "./handler";
import { type AnyTool, defineTool } from "./tools";

export interface DeviceActionParameter {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
}

export type DeviceActionParams = Record<string, unknown>;

export abstract class DeviceAction {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  readonly parameters?: Record<string, DeviceActionParameter>;
}

export interface Device {
  id: string;
  name: string;
  actions: DeviceAction[];
  /** Kind of device, for example light or thermostat. */
  type?: string;
  /** Current state as last reported by the adapter. */
  state?: Record<string, unknown>;
}

export type AdaptedDevice = {
  adapter: DeviceAdapter;
} & Device;

export interface DeviceAdapter {
  name: string;

  getDevices(): Promise<Device[]>;
  getDevice(idOrName: string): Promise<Device | null>;

  executeAction(
    deviceId: string,
    actionId: string,
    params?: DeviceActionParams,
  ): Promise<boolean>;
}

export class DeviceHandler extends Handler {
  readonly name = "device";
  private readonly adapters: DeviceAdapter[] = [];

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  registerAdapter(adapter: DeviceAdapter): void {
    const existingAdapter = this.adapters.find((d) => d.name === adapter.name);
    if (existingAdapter)
      throw new InvalidAdapterError(
        `Adapter with name ${adapter.name} already exists`,
      );

    this.adapters.push(adapter);
  }

  async getDevices(): Promise<Device[]> {
    const devices = await Promise.all(
      this.adapters.map((adapter) => adapter.getDevices()),
    );

    return devices.flat().filter((device) => device !== null);
  }

  async getDevice(idOrName: string): Promise<AdaptedDevice | null> {
    for (const adapter of this.adapters) {
      const device = await adapter.getDevice(idOrName);
      if (device)
        return {
          ...device,
          adapter,
        };
    }

    return null;
  }

  async executeAction(
    deviceId: string,
    actionId: string,
    params: DeviceActionParams = {},
  ): Promise<boolean> {
    const device = await this.getDevice(deviceId);
    if (!device)
      throw new DeviceManagerError(`Device with id ${deviceId} not found`);

    const action = device.actions.find((a) => a.id === actionId.toLowerCase());
    if (!action)
      throw new DeviceManagerError(`Action with id ${actionId} not found`);

    // A misspelled parameter would otherwise be dropped and the action still succeed
    const unknown = Object.keys(params).filter(
      (name) => !action.parameters?.[name],
    );
    if (unknown.length > 0)
      throw new DeviceManagerError(
        `Action ${action.id} does not accept the ${unknown.join(", ")} parameter`,
      );

    for (const [name, parameter] of Object.entries(action.parameters ?? {})) {
      const value = params[name];

      if (value === undefined) {
        if (parameter.required)
          throw new DeviceManagerError(
            `Action ${action.id} requires the ${name} parameter`,
          );
        continue;
      }

      if (typeof value !== parameter.type)
        throw new DeviceManagerError(
          `Parameter ${name} of action ${action.id} must be a ${parameter.type}`,
        );
    }

    this.logger().info(
      `Executing action ${action.name} on device ${device.name}`,
    );

    return device.adapter.executeAction(device.id, action.id, params);
  }

  override getTools(): AnyTool[] {
    const self = this;

    return [
      defineTool({
        name: "list",
        description:
          "List devices with their current state. Use device-get to see the actions a device supports",
        requiredArgs: z.object({
          query: z
            .string()
            .optional()
            .describe(
              "Only return devices whose id, name or type contains this text",
            ),
        }),
        async execute(args) {
          const query = args.query?.toLowerCase();
          const devices = (await self.getDevices()).filter(
            (device) =>
              !query ||
              [device.id, device.name, device.type ?? ""].some((value) =>
                value.toLowerCase().includes(query),
              ),
          );

          return {
            devices: devices.map(({ actions: _, ...device }) => device),
          };
        },
      }),
      defineTool({
        name: "get",
        description:
          "Get a specific device, including its current state and the actions it supports with their parameters",
        requiredArgs: z.object({
          idOrName: z.string(),
        }),
        async execute(args) {
          const device = await self.getDevice(args.idOrName);
          if (!device) return { error: "Device not found" };

          const { adapter: _, ...details } = device;
          return details;
        },
      }),
      defineTool({
        name: "action",
        description: "Execute an action on a device",
        requiredArgs: z.object({
          id: z.string(),
          action: z.string(),
          params: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Values for the parameters the action accepts, as listed by device-get",
            ),
        }),
        async execute(args) {
          const res = await self.executeAction(
            args.id,
            args.action,
            args.params,
          );

          return {
            success: res,
          };
        },
      }),
    ];
  }
}
