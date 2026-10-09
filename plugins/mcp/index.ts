import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { AnyTool, ToolSchema } from "../../src/handlers/tools";
import { RegistrablePlugin } from "../../src/plugin";

const serverSchema = z.union([
  z.object({
    command: z.string().describe("Executable that starts a stdio server"),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    url: z.url().describe("URL of a streamable HTTP server"),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const serversSchema = z.record(z.string(), serverSchema);

type ServerConfig = z.infer<typeof serverSchema>;

interface ConnectedServer {
  client: Client;
  tools: string[];
}

// Providers only accept tool names made of these characters, up to 64 long
const toolName = (server: string, tool: string) =>
  `mcp-${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

function toZodSchema(inputSchema: unknown): ToolSchema {
  try {
    return z.fromJSONSchema(
      inputSchema as Parameters<typeof z.fromJSONSchema>[0],
    ) as unknown as ToolSchema;
  } catch {
    // Unsupported schema: let the server validate the arguments instead
    return z.looseObject({}) as unknown as ToolSchema;
  }
}

export default class MCPPlugin extends RegistrablePlugin {
  readonly name = "mcp";
  private readonly servers = new Map<string, ConnectedServer>();

  async register(): Promise<void> {
    for (const [name, config] of Object.entries(this.getServers())) {
      try {
        await this.connect(name, config);
      } catch (e) {
        // One broken server should not take the others down
        this.logger().error(
          `Failed to connect to MCP server ${name}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }

    this.assistant.cli.registerCommand({
      name: "mcp",
      description: "Manage MCP servers",
      usage: "mcp <list|add|remove> [name] [command or url] [args...]",
      args: 1,
      run: async (args) => {
        const [action, name, target, ...rest] = args;

        switch (action.toLowerCase()) {
          case "list":
            return (
              [...this.servers.entries()]
                .map(([server, { tools }]) => `${server}: ${tools.join(", ")}`)
                .join("\n") || "No MCP servers connected"
            );
          case "add": {
            if (!name || !target)
              return "Usage: mcp add <name> <command or url> [args...]";
            if (this.servers.has(name)) return `Server ${name} already exists`;

            const config: ServerConfig = /^https?:\/\//.test(target)
              ? { url: target }
              : { command: target, args: rest };

            const { tools } = await this.connect(name, config);
            await this.saveServers({ ...this.getServers(), [name]: config });

            return `Connected to ${name} (${tools.length} tools)`;
          }
          case "remove": {
            if (!name) return "Usage: mcp remove <name>";

            const { [name]: removed, ...servers } = this.getServers();
            if (!removed) return `Server ${name} not found`;

            await this.disconnect(name);
            await this.saveServers(servers);

            return `Removed ${name}`;
          }
          default:
            return `Unknown action: ${action}`;
        }
      },
    });
  }

  async unregister(): Promise<void> {
    for (const name of [...this.servers.keys()]) await this.disconnect(name);
  }

  private getServers(): Record<string, ServerConfig> {
    const value = this.assistant
      .getHandler("setting")
      .getSetting<unknown>("MCP_SERVERS")?.value;
    if (!value) return {};

    // The CLI stores settings as plain strings
    const parsed = serversSchema.safeParse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
    if (!parsed.success) throw new Error("MCP_SERVERS setting is not valid");

    return parsed.data;
  }

  private async saveServers(servers: Record<string, ServerConfig>) {
    await this.assistant
      .getHandler("setting")
      .setSetting("MCP_SERVERS", servers);
  }

  private async connect(
    name: string,
    config: ServerConfig,
  ): Promise<ConnectedServer> {
    const transport =
      "url" in config
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers },
          })
        : new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: { ...getDefaultEnvironment(), ...config.env },
            stderr: "ignore",
          });

    const client = new Client({ name: "lisa", version: "1.0.0" });
    await client.connect(transport);

    const server: ConnectedServer = { client, tools: [] };
    const toolHandler = this.assistant.getHandler("tool");

    try {
      let cursor: string | undefined;

      do {
        const page = await client.listTools({ cursor });

        for (const mcpTool of page.tools) {
          const tool: AnyTool = {
            name: toolName(name, mcpTool.name),
            description: mcpTool.description ?? mcpTool.name,
            requiredArgs: toZodSchema(mcpTool.inputSchema),
            execute: (args) => this.callTool(client, mcpTool.name, args),
          };

          toolHandler.registerTool(tool);
          server.tools.push(tool.name);
        }

        cursor = page.nextCursor;
      } while (cursor);
    } catch (e) {
      for (const tool of server.tools) toolHandler.unregisterTool(tool);
      await client.close().catch(() => {});
      throw e;
    }

    this.servers.set(name, server);
    this.logger().info(
      `Connected to MCP server ${name} (${server.tools.length} tools)`,
    );

    return server;
  }

  private async disconnect(name: string) {
    const server = this.servers.get(name);
    if (!server) return;

    for (const tool of server.tools)
      this.assistant.getHandler("tool").unregisterTool(tool);

    this.servers.delete(name);
    await server.client.close().catch(() => {});
  }

  private async callTool(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) {
    const result = await client.callTool({ name, arguments: args });

    // Only text can be handed back to the model
    const text = (Array.isArray(result.content) ? result.content : [])
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("\n");

    if (result.isError) return { error: text || "Tool call failed" };

    return result.structuredContent ?? text;
  }

  override getSettings(): Record<string, z.ZodTypeAny> {
    return {
      MCP_SERVERS: serversSchema
        .default({})
        .describe(
          "MCP servers to connect to, by name. Each one is either a command to spawn or a URL",
        ),
    };
  }
}
