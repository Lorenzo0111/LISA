/** biome-ignore-all lint/suspicious/noExplicitAny: Any is required for schema shape */
import type { z } from "zod";
import { InvalidToolError } from "../types/errors";
import { Handler } from "./handler";

export abstract class Tool<T extends z.ZodObject<any> = z.ZodObject<any>> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly requiredArgs: T;

  abstract execute(args: z.infer<T>): Promise<unknown>;
}

export interface ToolRecorder {
  name: string;
  getTools(): Tool<any>[];
}

export class ToolHandler extends Handler {
  readonly name = "tool";
  readonly tools: Tool<any>[] = [];

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  registerTool(tool: Tool<any>): void {
    const existingTool = this.tools.find((t) => t.name === tool.name);
    if (existingTool)
      throw new InvalidToolError(`Tool with name ${tool.name} already exists`);

    this.tools.push(tool);
  }

  registerTools(recorder: ToolRecorder): void {
    for (const tool of recorder.getTools())
      this.registerTool({
        ...tool,
        name: `${recorder.name.replaceAll(" ", "_").toLowerCase()}:${tool.name}`,
        execute: tool.execute.bind(tool),
      });
  }

  async executeTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new InvalidToolError(`Tool with name ${name} not found`);

    this.logger().info(`Executing tool ${name}`);
    const res = await tool.execute(args as z.infer<typeof tool.requiredArgs>);

    return res;
  }
}
