import { assistant } from "../assistant";
import type { Command } from "../cli/command";

const echoCommand: Command = {
  name: "echo",
  description: "Echoes the input",
  usage: "echo <text>",
  args: 1,
  run: async (args) => {
    return args.join(" ");
  },
};

const settingCommand: Command = {
  name: "setting",
  description: "Manage settings",
  usage: "setting <get|set|list> [key] [value]",
  args: 1,
  run: async (args) => {
    const [action, key, value] = args;

    switch (action.toLowerCase()) {
      case "get":
        if (!key) return "Key is required";

        return (
          JSON.stringify(
            assistant.getHandler("setting").getSetting(key)?.value,
          ) ?? "Not set"
        );
      case "set":
        if (!key) return "Key is required";

        await assistant.getHandler("setting").setSetting(key, value);
        return `Set ${key} to ${value}`;
      case "list":
        return `\n${assistant
          .getHandler("setting")
          .allSettings()
          .map((s) => `${s.key}: ${JSON.stringify(s.value)}`)
          .join("\n")}`;
      default:
        return `Unknown action: ${action}`;
    }
  },
};

const enableCommand: Command = {
  name: "enable",
  description: "Enable a plugin",
  usage: "enable <plugin>",
  args: 1,
  run: async (args) => {
    const [plugin] = args;

    const enabledPlugins =
      assistant.getHandler("setting").getSetting<string[]>("ENABLED_PLUGINS")
        ?.value ?? [];

    if (enabledPlugins[0] === "") enabledPlugins.shift();
    if (enabledPlugins.includes(plugin)) return "Plugin is already enabled";

    enabledPlugins.push(plugin);
    await assistant
      .getHandler("setting")
      .setSetting("ENABLED_PLUGINS", enabledPlugins);

    await assistant.pluginLoader.loadPlugin(plugin);

    return `Enabled plugin ${plugin}`;
  },
};

export function registerBuiltInCommands() {
  assistant.cli.registerCommand(echoCommand);
  assistant.cli.registerCommand(settingCommand);
  assistant.cli.registerCommand(enableCommand);
}
