import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { BasicAIProvider } from "../../src/handlers/ai";
import { RegistrablePlugin } from "../../src/plugin";

export default class OpenRouterPlugin extends RegistrablePlugin {
  readonly name = "openrouter";

  async register(): Promise<void> {
    const [apiKey, model] = this.assistant.settingsManager.getSettings([
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
    ]);

    const openrouter = createOpenRouter({
      apiKey: apiKey?.value as string,
    });

    this.assistant.setAI(
      new BasicAIProvider(
        openrouter((model?.value as string) ?? "openrouter/auto"),
      ),
    );
  }

  async unregister(): Promise<void> {}

  override getSettings(): Record<string, z.ZodTypeAny> {
    return {
      OPENROUTER_API_KEY: z
        .string()
        .optional()
        .describe("API key for OpenRouter"),
      OPENROUTER_MODEL: z
        .string()
        .optional()
        .default("openrouter/auto")
        .describe("Model to use for OpenRouter"),
    };
  }
}
