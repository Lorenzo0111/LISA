import type { ZodTypeAny } from "zod";
import { prisma } from "../services/prisma";
import {
  defaultNotificationChannelSchema,
  enabledPluginsSchema,
  systemMemorySchema,
  systemPromptSchema,
} from "../types/settings";
import { Handler } from "./handler";

interface LoadedSetting<T> {
  key: string;
  value: T;
}

export class SettingHandler extends Handler {
  readonly name = "setting";
  private readonly settings: LoadedSetting<unknown>[] = [];
  private readonly schemaRegistry: Record<string, string> = {};

  async load() {
    await this.registerPluginSettings({
      ENABLED_PLUGINS: enabledPluginsSchema,
      NOTIFICATION_DEFAULT_CHANNEL: defaultNotificationChannelSchema,
      AI_SYSTEM_PROMPT: systemPromptSchema,
      AI_SYSTEM_MEMORY: systemMemorySchema,
    });

    const dbSettings = await prisma.setting.findMany();
    this.settings.push(
      ...dbSettings.map((setting) => ({
        key: setting.key,
        value: setting.value && JSON.parse(setting.value),
      })),
    );

    this.logger().info(`Loaded ${this.settings.length} settings`);
  }

  async unload(): Promise<void> {}

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
    const setting = this.settings.find((setting) => setting.key === key);

    // A setting that is only declared (or was cleared) counts as not set
    if (setting?.value === null || setting?.value === undefined)
      return undefined;

    return setting as LoadedSetting<T>;
  }

  allSettings(): LoadedSetting<unknown>[] {
    return [...this.settings];
  }

  /** Every known setting with its JSON schema, including the ones without a value. */
  async describeSettings() {
    const rows = await prisma.setting.findMany({ orderBy: { key: "asc" } });

    return rows.map((row) => {
      const schema = this.schemaRegistry[row.key] ?? row.jsonSchema;

      return {
        key: row.key,
        value: this.getSetting(row.key)?.value ?? null,
        schema: schema ? (JSON.parse(schema) as Record<string, unknown>) : null,
      };
    });
  }

  getSchema(key: string): Record<string, unknown> | null {
    const schema = this.schemaRegistry[key];
    return schema ? JSON.parse(schema) : null;
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

    const setting = this.settings.find((setting) => setting.key === key);

    if (setting) setting.value = value;
    else this.settings.push({ key, value });
  }

  async registerPluginSettings(settings: Record<string, ZodTypeAny>) {
    for (const [key, schema] of Object.entries(settings)) {
      if (this.schemaRegistry[key])
        this.logger().warn(`Overwriting existing schema for setting ${key}`);

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

    this.logger().info(
      `Registered ${Object.keys(settings).length} plugin settings`,
    );
  }
}
