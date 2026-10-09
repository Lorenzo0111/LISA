import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { assistant } from "../../assistant";
import type { NotificationChannel } from "../../handlers/notifications";

export const notificationsRoute = new Hono()
  .get("/channels", (ctx) => {
    return ctx.json(
      assistant
        .getHandler("notification")
        .getChannels()
        .map((channel) => ({
          name: channel.name,
          description: channel.description,
        })),
    );
  })
  .post(
    "/send",
    zValidator(
      "json",
      z.object({
        message: z.string().min(1),
        channel: z.string().optional(),
        target: z.string().optional(),
      }),
    ),
    async (ctx) => {
      const { message, ...options } = ctx.req.valid("json");
      const delivered = await assistant
        .getHandler("notification")
        .notify(message, options);

      return ctx.json({ success: delivered.length > 0, delivered });
    },
  )
  .get(
    "/stream",
    zValidator(
      "query",
      z.object({
        channel: z
          .string()
          .regex(/^[a-z0-9_-]+$/i)
          .default("voice"),
      }),
    ),
    (ctx) => {
      const { channel: name } = ctx.req.valid("query");
      const notifications = assistant.getHandler("notification");

      return streamSSE(ctx, async (stream) => {
        const channel: NotificationChannel = {
          name,
          description: `Client connected to the ${name} notification stream`,
          async send(message) {
            await stream.writeSSE({
              event: "notification",
              data: JSON.stringify({ message }),
            });
          },
        };

        notifications.registerChannel(channel);

        await stream.writeSSE({ event: "ping", data: "" });

        const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
        const heartbeat = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 15000);

        try {
          await closed;
        } finally {
          clearInterval(heartbeat);
          notifications.unregisterChannel(channel);
        }
      });
    },
  );
