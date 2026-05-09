import z from "zod";
import type { Timer } from "../generated/prisma/client";
import { prisma } from "../services/prisma";
import { Handler } from "./handler";
import { type AnyTool, defineTool } from "./tools";

export class TimerHandler extends Handler {
  readonly name = "timer";
  private interval: NodeJS.Timeout | null = null;

  async load(): Promise<void> {
    this.assistant.eventBus.on("startup", () => {
      if (!this.interval) {
        this.interval = setInterval(this.executeTimers.bind(this), 1000);
        this.logger().info("Timer executor started");
      }
    });
  }

  async unload(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.logger().info("Timer executor stopped");
  }

  async getTimer(name: string): Promise<Timer | null> {
    return await prisma.timer.findFirst({
      where: {
        name,
        executed: false,
      },
    });
  }

  async getTimers(): Promise<Timer[]> {
    return await prisma.timer.findMany({
      where: {
        executed: false,
      },
    });
  }

  async scheduleTimer(
    name: string,
    seconds: number,
    action: string,
    context?: Record<string, string>,
  ): Promise<Timer> {
    if (seconds < 0) throw new Error("Seconds must be a non-negative integer");

    const runAt = new Date(Date.now() + seconds * 1000);

    const record = await prisma.timer.create({
      data: {
        name,
        runAt,
        action,
        context,
      },
    });

    this.logger().info(
      `Scheduled timer: ${name} to run at ${runAt.toISOString()}`,
    );

    return record;
  }

  async executeTimers() {
    const timers = await prisma.timer.updateManyAndReturn({
      where: {
        executed: false,
        runAt: {
          lte: new Date(),
        },
      },
      data: {
        executed: true,
      },
    });

    timers.forEach((timer) => {
      this.logger().info(`Executing timer: ${timer.name}`);

      this.assistant.getHandler("request").handleRequest({
        type: "TIMER",
        content: timer.action,
        context: (timer.context as Record<string, string>) || {},
      });
    });
  }

  override getTools(): AnyTool[] {
    const self = this;

    return [
      defineTool({
        name: "list",
        description: "List all timers",
        requiredArgs: z.object({}),
        async execute() {
          return { timers: await self.getTimers() };
        },
      }),
      defineTool({
        name: "get",
        description: "Get a specific timer",
        requiredArgs: z.object({
          name: z.string(),
        }),
        async execute(args) {
          const timer = await self.getTimer(args.name);
          if (!timer) return { error: "Timer not found" };

          return timer;
        },
      }),
      defineTool({
        name: "create",
        description:
          "Create a new scheduled task that will run after a certain number of seconds",
        requiredArgs: z.object({
          name: z.string().describe("A small description of what timer is for"),
          seconds: z.number().min(0),
          action: z
            .string()
            .describe(
              "The prompt that will be given to the assistant when the timer executes. The prompt will be sent on a blank session with the same tools you have now so include all the details and context needed",
            ),
          context: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Additional context to be passed when the timer executes. An example could be the platform and the user who created the request",
            ),
        }),
        async execute(args) {
          await self.scheduleTimer(
            args.name,
            args.seconds,
            args.action,
            args.context,
          );

          return {
            success: true,
          };
        },
      }),
    ];
  }
}
