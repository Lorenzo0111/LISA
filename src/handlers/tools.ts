import type { z } from "zod";
import { InvalidToolError } from "../types/errors";
import { Handler } from "./handler";

export type ToolSchema = z.ZodObject<Record<string, z.ZodType<unknown>>>;
export type AnyTool = Tool<ToolSchema>;

export interface Tool<TSchema extends ToolSchema = ToolSchema> {
  readonly name: string;
  readonly description: string;
  readonly requiredArgs: TSchema;

  execute(args: z.infer<TSchema>): Promise<unknown>;
}

export function defineTool<const TSchema extends ToolSchema>(
  tool: Tool<TSchema>,
): Tool<TSchema> {
  return tool;
}

export interface ToolRecorder {
  name: string;
  getTools(): AnyTool[];
}

export class ToolHandler extends Handler {
  readonly name = "tool";
  readonly tools: AnyTool[] = [];

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  registerTool(tool: AnyTool): void {
    const existingTool = this.tools.find((t) => t.name === tool.name);
    if (existingTool)
      throw new InvalidToolError(`Tool with name ${tool.name} already exists`);

    this.tools.push(tool);
  }

  registerTools(recorder: ToolRecorder): void {
    for (const tool of recorder.getTools())
      this.registerTool({
        ...tool,
        name: `${recorder.name.replaceAll(" ", "_").toLowerCase()}-${tool.name}`,
        execute: tool.execute.bind(tool),
      });
  }

  async executeTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new InvalidToolError(`Tool with name ${name} not found`);

    this.logger().info(`Executing tool ${name}`);
    const parsedArgs = tool.requiredArgs.parse(args);
    const res = await tool.execute(parsedArgs);

    return res;
  }
}
