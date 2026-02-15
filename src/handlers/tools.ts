/** biome-ignore-all lint/suspicious/noExplicitAny: Any is required for schema shape */
import type { z } from "zod";
import { createLogger } from "../services/logger";
import { InvalidToolError } from "../types/errors";

export abstract class Tool<T extends z.ZodObject<any> = z.ZodObject<any>> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly requiredArgs: T;

  abstract execute(args: z.infer<T>): Promise<unknown>;
}

export class ToolHandler {
  private readonly logger = createLogger("tool-manager");
  readonly tools: Tool<any>[] = [];

  registerTool(tool: Tool<any>): void {
    const existingTool = this.tools.find((t) => t.name === tool.name);
    if (existingTool)
      throw new InvalidToolError(`Tool with name ${tool.name} already exists`);

    this.tools.push(tool);
  }

  async executeTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new InvalidToolError(`Tool with name ${name} not found`);

    this.logger.info(`Executing tool ${name}`);
    const res = await tool.execute(args as z.infer<typeof tool.requiredArgs>);

    return res;
  }
}
