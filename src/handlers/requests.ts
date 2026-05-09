import { assistant } from "../assistant";
import { prisma } from "../services/prisma";
import { InvalidSetupError } from "../types/errors";
import type { RequestType } from "../types/requests";
import type { ResponseType } from "../types/responses";
import type { IntelligenceProvider } from "./ai";
import { Handler } from "./handler";

export class RequestHandler extends Handler {
  readonly name = "request";
  private ai?: IntelligenceProvider;

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  async handleRequest(request: RequestType): Promise<ResponseType> {
    if (!this.ai) throw new InvalidSetupError("AI provider is not set");

    this.logger().info(`Handling request: ${request.content}`);
    assistant.eventBus.emit("request:create", request);

    const previousMessages =
      request.type === "USER"
        ? await prisma.message.findMany({
            where: {
              createdAt: { gte: new Date(Date.now() - 120000) },
              type: "USER",
            },
            orderBy: { createdAt: "desc" },
            take: 5,
          })
        : [];

    const response = await this.ai.process(
      previousMessages,
      request.content,
      request.context,
    );

    await prisma.message.create({
      data: {
        type: request.type,
        request: request.content,
        response: response.content,
        tokens: response.tokens ?? 0,
      },
    });

    assistant.eventBus.emit("request:process", request, response);

    return response;
  }

  setAI(ai: IntelligenceProvider) {
    this.ai = ai;
  }
}
