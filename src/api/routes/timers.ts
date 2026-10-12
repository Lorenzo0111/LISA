import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";
import { speakerIdSchema } from "../../types/speakers";
import type { AppEnv } from "../context";

export const timersRoute = new Hono<AppEnv>()
  .get("/", async (ctx) => {
    const timers = await assistant.getHandler("timer").getTimers();

    return ctx.json(
      timers.sort((a, b) => a.runAt.getTime() - b.runAt.getTime()),
    );
  })
  .post(
    "/",
    zValidator(
      "json",
      z
        .object({
          name: z.string().trim().min(1).max(80),
          // Prompt the assistant runs when the timer fires
          action: z.string().trim().min(1).max(2000),
          seconds: z.number().int().min(1).optional(),
          cron: z.string().trim().min(1).optional(),
          // Channel that receives the result, for example a speaker id
          notify: speakerIdSchema.optional(),
        })
        .refine(
          (body) => (body.seconds === undefined) !== (body.cron === undefined),
          {
            message: "Provide exactly one of seconds or cron",
          },
        ),
    ),
    async (ctx) => {
      const body = ctx.req.valid("json");
      const handler = assistant.getHandler("timer");
      const context = { source: body.notify ?? "dashboard" };

      try {
        const timer =
          body.cron !== undefined
            ? await handler.scheduleRecurring(
                body.name,
                body.cron,
                body.action,
                context,
              )
            : await handler.scheduleTimer(
                body.name,
                body.seconds as number,
                body.action,
                context,
              );

        return ctx.json(timer, 201);
      } catch (e) {
        return ctx.json(
          { error: e instanceof Error ? e.message : String(e) },
          400,
        );
      }
    },
  )
  .delete("/:id{[0-9]+}", async (ctx) => {
    const timer = await assistant
      .getHandler("timer")
      .cancelTimer(Number(ctx.req.param("id")));
    if (!timer) return ctx.json({ error: "Timer not found" }, 404);

    return ctx.json({ success: true });
  });
