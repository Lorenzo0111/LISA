import { initializeServer } from "./api/server";
import { registerBuiltInCommands } from "./builtin/commands";
import { registerTestingDevice } from "./builtin/testing";
import { registerBuiltInTools } from "./builtin/tools";
import { AssistantCLI } from "./cli";
import * as handlers from "./handlers";
import type { IntelligenceProvider } from "./handlers/ai";
import { type EventArgs, EventBus } from "./handlers/event-bus";
import { PluginLoader } from "./plugin/loader";
import { initializeLogger, logger } from "./services/logger";

export let assistant: Assistant;

type HandlerClasses = (typeof handlers)[keyof typeof handlers];
type HandlerInstances = InstanceType<HandlerClasses>;
type HandlerByName = {
  [H in HandlerInstances as H["name"]]: H;
};

export class Assistant {
  readonly eventBus = new EventBus();
  readonly pluginLoader = new PluginLoader();
  readonly handlers = new Map<
    keyof HandlerByName,
    HandlerByName[keyof HandlerByName]
  >();
  readonly cli = new AssistantCLI();

  constructor() {
    assistant = this;

    process.on("exit", async () => {
      await this.stop();
    });

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));

    for (const HandlerClass of Object.values(handlers) as HandlerClasses[]) {
      const handler = new HandlerClass() as HandlerByName[keyof HandlerByName];
      this.handlers.set(handler.name, handler);
    }
  }

  async start() {
    const startTime = Date.now();
    initializeLogger();

    for (const handler of this.handlers.values()) await handler.load();

    const PORT = initializeServer();
    logger.info(`Server listening on port ${PORT}`);

    registerBuiltInCommands();
    registerBuiltInTools();

    if (process.env.TESTING) registerTestingDevice();

    await this.pluginLoader.loadPlugins();

    this.eventBus.emit("startup");
    logger.info(`Application initialized in ${Date.now() - startTime}ms`);
  }

  async stop() {
    for (const handler of this.handlers.values()) await handler.unload();
    await this.pluginLoader.unloadPlugins();
  }

  async eval(message: string, context?: Record<string, string>) {
    return this.getHandler("request").handleRequest({
      content: message,
      context,
    });
  }

  on<T extends keyof EventArgs>(
    event: T,
    listener: (...args: EventArgs[T]) => void,
  ) {
    this.eventBus.on(event, listener);
  }

  setAI(ai: IntelligenceProvider) {
    logger.info(`AI provider set to ${ai.name}`);
    this.getHandler("request").setAI(ai);
  }

  getHandler<K extends keyof HandlerByName>(name: K): HandlerByName[K] {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Handler with name ${name} not found`);

    return handler as HandlerByName[K];
  }
}
