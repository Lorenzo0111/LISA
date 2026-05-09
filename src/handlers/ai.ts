import {
  type Agent,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  ToolLoopAgent,
  tool,
} from "ai";
import { assistant } from "../assistant";
import { generateSystemPrompt } from "../constants/ai";
import type { Message } from "../generated/prisma/client";
import type { ResponseType } from "../types/responses";

export abstract class IntelligenceProvider {
  abstract readonly name: string;

  abstract process(
    previousMessages: Message[],
    input: string,
    context?: Record<string, string>,
  ): Promise<ResponseType>;
}

export class BasicAIProvider extends IntelligenceProvider {
  name = "Basic";
  model: LanguageModel;
  agent: Agent;

  constructor(model: LanguageModel) {
    super();
    this.model = model;

    const tools: Record<string, Tool> = {};
    const toolNames: Record<string, string> = {};

    for (const toolData of assistant.getHandler("tool").tools) {
      tools[toolData.name] = tool({
        description: toolData.description,
        inputSchema: toolData.requiredArgs,
        execute: async (args) =>
          await assistant.getHandler("tool").executeTool(toolData.name, args),
      });
      toolNames[toolData.name] = toolData.description;
    }

    this.agent = new ToolLoopAgent({
      model: this.model,
      prepareCall: async (settings) => {
        const [AI_SYSTEM_PROMPT, AI_SYSTEM_MEMORY] = assistant
          .getHandler("setting")
          .getSettings(["AI_SYSTEM_PROMPT", "AI_SYSTEM_MEMORY"]);

        let memoryTitles: Record<number, string> = {};

        if (AI_SYSTEM_MEMORY?.value !== "0")
          memoryTitles = await assistant.getHandler("memory").listTitles();

        return {
          ...settings,
          instructions:
            (AI_SYSTEM_PROMPT?.value as string) ??
            generateSystemPrompt({
              tools: toolNames,
              memory: {
                enabled: AI_SYSTEM_MEMORY?.value !== "0",
                titles: memoryTitles,
              },
            }),
        };
      },
      tools,
      headers: {
        "X-Title": "LISA",
        "HTTP-Referer": "https://github.com/Lorenzo0111/LISA",
      },
    });
  }

  override async process(
    previousMessages: Message[],
    input: string,
    context?: Record<string, string>,
  ): Promise<ResponseType> {
    const messages: ModelMessage[] = [];

    for (const message of previousMessages) {
      messages.push({
        role: "user",
        content: message.request,
      });

      messages.push({
        role: "assistant",
        content: message.response,
      });
    }

    let contextStr = "";
    if (context && Object.keys(context).length > 0) {
      contextStr = "[";
      for (const [key, value] of Object.entries(context)) {
        contextStr += `${key}: ${value}, `;
      }
      contextStr = `${contextStr.slice(0, -2)}]`;
    }

    messages.push({
      role: "user",
      content: `${contextStr} ${input}`,
    });

    const response = await this.agent.generate({ messages });

    return { content: response.text, tokens: response.usage.totalTokens };
  }
}
