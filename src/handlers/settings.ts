import type { ZodTypeAny } from "zod";
import { createLogger } from "../services/logger";
import { prisma } from "../services/prisma";
import { enabledPluginsSchema } from "../types/settings";

interface LoadedSetting<T> {
  key: string;
  value: T;
}

export class SettingHandler {
  private readonly logger = createLogger("settings");
  private readonly settings: LoadedSetting<unknown>[] = [];
  private readonly schemaRegistry: Record<string, string> = {};

  async init() {
    this.registerPluginSettings({
      ENABLED_PLUGINS: enabledPluginsSchema,
    });

    const dbSettings = await prisma.setting.findMany();
    this.settings.push(
      ...dbSettings.map((setting) => ({
        key: setting.key,
        value: setting.value && JSON.parse(setting.value),
      })),
    );

    this.logger.info(`Loaded ${this.settings.length} settings`);
  }

  getSettings(keys: string[]): (LoadedSetting<unknown> | undefined)[] {
    const settings: (LoadedSetting<unknown> | undefined)[] = [];

    for (const key of keys) {
      const setting = this.getSetting(key);
      if (setting) settings.push(setting);
    }

    if (settings.length !== keys.length)
      for (let i = 0; i < keys.length; i++)
        if (!settings[i]) settings[i] = undefined;

    return settings;
  }

  getSetting<T>(key: string): LoadedSetting<T> | undefined {
    return this.settings.find((setting) => setting.key === key) as
      | LoadedSetting<T>
      | undefined;
  }

  allSettings(): LoadedSetting<unknown>[] {
    return [...this.settings];
  }

  async setSetting(key: string, value: unknown, jsonSchema?: string) {
    await prisma.setting.upsert({
      where: { key },
      update: {
        value: JSON.stringify(value),
        jsonSchema: jsonSchema ?? this.schemaRegistry[key],
      },
      create: {
        key,
        value: JSON.stringify(value),
        jsonSchema: jsonSchema ?? this.schemaRegistry[key],
      },
    });

    const setting: LoadedSetting<typeof value> | undefined =
      this.getSetting(key);

    if (setting) setting.value = value;
    else this.settings.push({ key, value });
  }

  async registerPluginSettings(settings: Record<string, ZodTypeAny>) {
    for (const [key, schema] of Object.entries(settings)) {
      if (this.schemaRegistry[key])
        this.logger.warn(`Overwriting existing schema for setting ${key}`);

      this.schemaRegistry[key] = JSON.stringify(schema.toJSONSchema());

      await prisma.setting.upsert({
        where: {
          key,
        },
        create: {
          key,
          jsonSchema: this.schemaRegistry[key],
        },
        update: {
          jsonSchema: this.schemaRegistry[key],
        },
      });
    }

    this.logger.info(
      `Registered ${Object.keys(settings).length} plugin settings`,
    );
  }
}
