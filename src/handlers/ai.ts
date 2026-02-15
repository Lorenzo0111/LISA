import {
  type Agent,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type Tool,
  tool,
  ToolLoopAgent,
} from "ai";
import { assistant } from "../assistant";
import type { Message } from "../generated/prisma/client";
import type { ResponseType } from "../types/responses";

export abstract class IntelligenceProvider {
  abstract readonly name: string;

  abstract process(
    previousMessages: Message[],
    input: string,
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

    for (const toolData of assistant.toolsHandler.tools) {
      tools[toolData.name] = tool({
        description: toolData.description,
        inputSchema: toolData.requiredArgs,
        execute: async (args) =>
          await assistant.toolsHandler.executeTool(toolData.name, args),
      });
    }

    this.agent = new ToolLoopAgent({
      model: this.model,
      instructions:
        process.env.AI_SYSTEM_PROMPT ??
        `You are a helpful voice assistant called Lisa.
      Answer the user's question in a helpful and friendly manner.
      You can use tools to trigger actions like turning on lights or setting reminders.
      When you need to trigger an action for a device, retrieve the device and action id before triggering any action, you can do so by using the device-list or device-get tool.
      You always have to give a response to the user's prompt, it can also just be an acknowledgment if an action was triggered.
      
      Don't respond with long paragraphs, keep it short and concise.`,
      tools,
      stopWhen: stepCountIs(10),
      headers: {
        "X-Title": "LISA",
        "HTTP-Referer": "https://github.com/Lorenzo0111/LISA",
      },
    });
  }

  override async process(
    previousMessages: Message[],
    input: string,
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

    messages.push({
      role: "user",
      content: input,
    });

    const response = await this.agent.generate({ messages });

    return { content: response.text, tokens: response.usage.totalTokens };
  }
}
