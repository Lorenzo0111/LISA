import { assistant } from "../assistant";
import type { Device, DeviceAdapter } from "../handlers/devices";
import { createLogger } from "../services/logger";

export class ExampleAdapter implements DeviceAdapter {
  name = "example";
  devices: Device[] = [
    {
      id: "example",
      name: "Example Bell",
      actions: [
        {
          id: "ring",
          name: "Ring",
          description: "Ring the bell",
        },
      ],
    },
  ];

  async getDevices(): Promise<Device[]> {
    return this.devices;
  }

  async getDevice(id: string): Promise<Device | null> {
    return (
      this.devices.find((device) => device.id === id || device.name === id) ??
      null
    );
  }

  async executeAction(deviceId: string, actionId: string): Promise<boolean> {
    if (deviceId === "example" && actionId === "ring") {
      createLogger("bell").info("The bell is ringing!");
      return true;
    }

    return false;
  }
}

export function registerTestingDevice() {
  assistant.getHandler("device").registerAdapter(new ExampleAdapter());
}
