import { createOllama } from "ai-sdk-ollama";
import { z } from "zod";
import { BasicAIProvider } from "../../src/handlers/ai";
import { RegistrablePlugin } from "../../src/plugin";
import { InvalidToolError } from "../../src/types/errors";

export default class OllamaPlugin extends RegistrablePlugin {
  readonly name = "ollama";

  async register(): Promise<void> {
    const [modelId, baseUrl] = this.assistant
      .getHandler("setting")
      .getSettings(["OLLAMA_MODEL_ID", "OLLAMA_BASE_URL"]);

    if (!modelId || !baseUrl)
      throw new InvalidToolError("OLLAMA model ID or base URL not set");

    const ollama = createOllama({
      baseURL: baseUrl.value as string,
    });

    this.assistant.setAI(new BasicAIProvider(ollama(modelId.value as string)));
  }

  async unregister(): Promise<void> {}

  override getSettings() {
    return {
      OLLAMA_MODEL_ID: z.string().describe("Ollama model ID"),
      OLLAMA_BASE_URL: z
        .string()
        .default("http://localhost:11434")
        .describe("Ollama base URL"),
    };
  }
}
