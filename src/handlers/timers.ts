import { Cron } from "croner";
import z from "zod";
import type { Timer } from "../generated/prisma/client";
import { prisma } from "../services/prisma";
import { Handler } from "./handler";
import { type AnyTool, defineTool } from "./tools";

function nextCronRun(cron: string): Date {
  const next = new Cron(cron).nextRun();
  if (!next) throw new Error(`Cron expression ${cron} never runs`);

  return next;
}

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

  async scheduleRecurring(
    name: string,
    cron: string,
    action: string,
    context?: Record<string, string>,
  ): Promise<Timer> {
    const [runAt, following] = new Cron(cron).nextRuns(2);
    if (!runAt) throw new Error(`Cron expression ${cron} never runs`);
    if (following && following.getTime() - runAt.getTime() < 60000)
      throw new Error("Recurring timers cannot run more than once a minute");

    const record = await prisma.timer.create({
      data: {
        name,
        runAt,
        cron,
        action,
        context,
      },
    });

    this.logger().info(
      `Scheduled recurring timer: ${name} (${cron}), next run at ${runAt.toISOString()}`,
    );

    return record;
  }

  async cancelTimer(id: number): Promise<Timer | null> {
    const timer = await prisma.timer.findFirst({
      where: { id, executed: false },
    });
    if (!timer) return null;

    return await prisma.timer.delete({ where: { id } });
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

    for (const timer of timers) {
      // Recurring timers are re-armed before running so a slow or failing
      // run cannot make them miss the next occurrence
      if (timer.cron) await this.rearmTimer(timer.id, timer.cron);

      this.executeTimer(timer).catch((e) =>
        this.logger().error(
          `Timer ${timer.name} failed: ${e instanceof Error ? e.message : e}`,
        ),
      );
    }
  }

  private async rearmTimer(id: number, cron: string) {
    try {
      await prisma.timer.update({
        where: { id },
        data: { executed: false, runAt: nextCronRun(cron) },
      });
    } catch (e) {
      this.logger().error(
        `Could not re-arm timer ${id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private async executeTimer(timer: Timer) {
    this.logger().info(`Executing timer: ${timer.name}`);

    const context = (timer.context as Record<string, string>) || {};
    const response = await this.assistant.getHandler("request").handleRequest({
      type: "TIMER",
      content: timer.action,
      context,
    });

    // Nobody is waiting for this response, so push it back to where the
    // timer was created from
    await this.assistant.getHandler("notification").notify(response.content, {
      channel: context.source,
      target: context.user_id,
    });
  }

  override getTools(): AnyTool[] {
    const self = this;

    return [
      defineTool({
        name: "list",
        description: "List all timers and recurring schedules",
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
          "Create a scheduled task. Pass seconds to run it once after a delay, or cron to run it on a recurring schedule. Whatever the assistant answers when the task runs is delivered automatically to the user who created it.",
        requiredArgs: z.object({
          name: z.string().describe("A small description of what timer is for"),
          seconds: z
            .number()
            .min(0)
            .optional()
            .describe("Delay before a one-off task runs"),
          cron: z
            .string()
            .optional()
            .describe(
              "Five field cron expression (minute hour day-of-month month day-of-week) in local time for a recurring task, for example '0 8 * * 1-5' for every weekday at 8:00",
            ),
          action: z
            .string()
            .describe(
              "The prompt that will be given to the assistant when the timer executes. The prompt will be sent on a blank session with the same tools you have now so include all the details and context needed. Its response is sent to the user, so do not ask it to send a message",
            ),
          context: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Additional context to be passed when the timer executes. The context of the current request is included automatically",
            ),
        }),
        async execute(args) {
          if ((args.seconds === undefined) === (args.cron === undefined))
            return { error: "Provide exactly one of seconds or cron" };

          // Remember where the request came from so the result can be
          // delivered back there
          const context = {
            ...self.assistant.getHandler("request").currentRequest()?.context,
            ...args.context,
          };

          if (args.cron !== undefined) {
            try {
              const timer = await self.scheduleRecurring(
                args.name,
                args.cron,
                args.action,
                context,
              );

              return { success: true, id: timer.id, nextRun: timer.runAt };
            } catch (e) {
              return {
                error: `Invalid cron expression: ${
                  e instanceof Error ? e.message : e
                }`,
              };
            }
          }

          const timer = await self.scheduleTimer(
            args.name,
            args.seconds as number,
            args.action,
            context,
          );

          return { success: true, id: timer.id };
        },
      }),
      defineTool({
        name: "cancel",
        description:
          "Cancel a pending timer or stop a recurring schedule by its id",
        requiredArgs: z.object({
          id: z.number().int().positive(),
        }),
        async execute(args) {
          const timer = await self.cancelTimer(args.id);
          if (!timer) return { error: "Timer not found" };

          return { success: true };
        },
      }),
    ];
  }
}
