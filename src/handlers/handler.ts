import { assistant } from "../assistant";
import { createLogger } from "../services/logger";
import type { AnyTool } from "./tools";

export abstract class Handler {
  abstract readonly name: string;
  protected readonly logger = () => createLogger(`handler: ${this.name}`);
  protected readonly assistant = assistant;

  abstract load(): Promise<void>;
  abstract unload(): Promise<void>;

  getTools(): AnyTool[] {
    return [];
  }
}
