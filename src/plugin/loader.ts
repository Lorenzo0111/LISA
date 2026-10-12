import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assistant } from "../assistant";
import { createLogger } from "../services/logger";
import type { RegistrablePlugin } from ".";

const PLUGINS_DIR = join(import.meta.dir, "../../plugins");

interface PluginState {
  /** Keys of the settings the plugin declares, known once it has been loaded. */
  settings: string[];
  error?: string;
}

export class PluginLoader {
  plugins: RegistrablePlugin[] = [];
  private readonly states = new Map<string, PluginState>();
  // Plugins cannot be fully unloaded while running, see unloadPlugin
  private readonly needRestart = new Set<string>();
  private readonly logger = createLogger("plugin-loader");

  private enabledPlugins(): string[] {
    const enabled =
      assistant.getHandler("setting").getSetting<string[]>("ENABLED_PLUGINS")
        ?.value ?? [];

    return enabled.filter((name) => name !== "");
  }

  /** Names of the plugins found in the plugins directory. */
  availablePlugins(): string[] {
    if (!existsSync(PLUGINS_DIR)) return [];

    return readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(PLUGINS_DIR, entry.name, "index.ts")),
      )
      .map((entry) => entry.name)
      .sort();
  }

  describePlugins() {
    const enabled = this.enabledPlugins();

    return this.availablePlugins().map((name) => {
      const state = this.states.get(name);

      return {
        name,
        enabled: enabled.includes(name),
        loaded: this.plugins.some((plugin) => plugin.name === name),
        error: state?.error ?? null,
        settings: state?.settings ?? [],
        restartRequired: this.needRestart.has(name),
      };
    });
  }

  async loadPlugins(): Promise<void> {
    for (const plugin of this.enabledPlugins()) await this.loadPlugin(plugin);

    this.logger.info(
      `Loaded ${this.plugins.length} plugins: ${
        this.plugins.map((p) => p.name).join(", ") || "N/A"
      }`,
    );
  }

  async loadPlugin(name: string): Promise<boolean> {
    const state: PluginState = { settings: [] };
    this.states.set(name, state);

    try {
      const { default: PluginModule } = await import(
        `../../plugins/${name}/index.ts`
      );

      const instance: RegistrablePlugin = new PluginModule();

      // Settings come first so they can be filled in from the dashboard even
      // when the plugin refuses to start without them
      const settings = instance.getSettings();
      state.settings = Object.keys(settings);
      await assistant.getHandler("setting").registerPluginSettings(settings);

      await instance.register();

      assistant.getHandler("tool").registerTools(instance);

      this.plugins.push(instance);
      return true;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      this.logger.error(`Failed to load plugin ${name}: ${state.error}`);
      return false;
    }
  }

  async enablePlugin(name: string): Promise<boolean> {
    const enabled = this.enabledPlugins();

    if (!enabled.includes(name))
      await assistant
        .getHandler("setting")
        .setSetting("ENABLED_PLUGINS", [...enabled, name]);

    if (this.plugins.some((plugin) => plugin.name === name)) return true;
    return await this.loadPlugin(name);
  }

  async disablePlugin(name: string): Promise<void> {
    await assistant.getHandler("setting").setSetting(
      "ENABLED_PLUGINS",
      this.enabledPlugins().filter((plugin) => plugin !== name),
    );

    await this.unloadPlugin(name);
  }

  /**
   * Stops a plugin and removes its tools. What a plugin registered elsewhere
   * (an AI provider, a device adapter) stays until the assistant restarts.
   */
  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) return;

    try {
      await plugin.unregister();
    } catch (e) {
      this.logger.error({ err: e }, `Failed to unload plugin ${name}`);
    }

    const prefix = `${name.replaceAll(" ", "_").toLowerCase()}-`;
    for (const tool of plugin.getTools())
      assistant.getHandler("tool").unregisterTool(`${prefix}${tool.name}`);

    this.plugins = this.plugins.filter((p) => p !== plugin);
    this.needRestart.add(name);
  }

  async unloadPlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.unregister();
      } catch (e) {
        this.logger.error({ err: e }, `Failed to unload plugin ${plugin.name}`);
      }
    }

    this.logger.info(`Unloaded ${this.plugins.length} plugins`);
    this.plugins = [];
  }
}
