import { createOpenAI } from "@ai-sdk/openai";
import { type ZodType, z } from "zod";
import { BasicAIProvider } from "../../src/handlers/ai";
import { RegistrablePlugin } from "../../src/plugin";

export default class OpenAIPlugin extends RegistrablePlugin {
  readonly name = "openai";

  async register(): Promise<void> {
    const [baseUrl, apiKey, model] = this.assistant.settingsManager.getSettings(
      ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"],
    );

    const openai = createOpenAI({
      baseURL: baseUrl?.value as string,
      apiKey: apiKey?.value as string,
    });

    this.assistant.setAI(
      new BasicAIProvider(openai((model?.value as string) ?? "gpt-5-mini")),
    );
  }

  async unregister(): Promise<void> {}

  override getSettings(): Record<string, ZodType<unknown>> {
    return {
      OPENAI_BASE_URL: z
        .string()
        .optional()
        .default("https://api.openai.com/v1")
        .describe("Base URL for OpenAI API"),
      OPENAI_API_KEY: z.string().optional().describe("API key for OpenAI API"),
      OPENAI_MODEL: z
        .string()
        .optional()
        .default("gpt-5-mini")
        .describe("Model to use for OpenAI API"),
    };
  }
}
