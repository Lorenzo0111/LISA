import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { assistant } from "../../assistant";
import type { NotificationChannel } from "../../handlers/notifications";
import type { SpeakerConnection } from "../../handlers/speakers";

// Channels created by the stream route, the only ones a client may replace
const streamChannels = new WeakSet<NotificationChannel>();

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

      const existing = notifications
        .getChannels()
        .find((channel) => channel.name === name);
      if (existing && !streamChannels.has(existing))
        return ctx.json({ error: `Channel ${name} is already in use` }, 409);

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

        // A registered speaker also gets its configuration through the stream
        const speakers = assistant.getHandler("speaker");
        const connection: SpeakerConnection = {
          async pushConfig(config) {
            await stream.writeSSE({
              event: "config",
              data: JSON.stringify(config),
            });
          },
        };
        // Listen first, a client leaving during the first write must not be missed
        const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
        if (stream.aborted) return;

        let heartbeat: ReturnType<typeof setInterval> | undefined;

        try {
          streamChannels.add(channel);

          notifications.registerChannel(channel);
          await speakers.connect(name, connection);

          await stream.writeSSE({ event: "ping", data: "" });

          heartbeat = setInterval(() => {
            stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
          }, 15000);

          await closed;
        } finally {
          clearInterval(heartbeat);
          notifications.unregisterChannel(channel);
          await speakers.disconnect(name, connection);
        }
      });
    },
  );
