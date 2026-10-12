import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";
import {
  registerSpeakerSchema,
  updateSpeakerSchema,
} from "../../types/speakers";
import type { AppEnv } from "../context";
import { adminMiddleware } from "../middlewares/auth";

export const speakersRoute = new Hono<AppEnv>()
  .get("/", async (ctx) => {
    return ctx.json(await assistant.getHandler("speaker").getSpeakers());
  })
  // A voice worker announces itself here when it starts and gets its
  // configuration back
  .post(
    "/register",
    adminMiddleware,
    zValidator("json", registerSpeakerSchema),
    async (ctx) => {
      const speaker = await assistant
        .getHandler("speaker")
        .register(ctx.req.valid("json"));

      return ctx.json(speaker);
    },
  )
  .get("/:id", async (ctx) => {
    const speaker = await assistant
      .getHandler("speaker")
      .getSpeaker(ctx.req.param("id"));
    if (!speaker) return ctx.json({ error: "Speaker not found" }, 404);

    return ctx.json(speaker);
  })
  .patch(
    "/:id",
    adminMiddleware,
    zValidator("json", updateSpeakerSchema),
    async (ctx) => {
      try {
        const speaker = await assistant
          .getHandler("speaker")
          .updateSpeaker(ctx.req.param("id"), ctx.req.valid("json"));
        if (!speaker) return ctx.json({ error: "Speaker not found" }, 404);

        return ctx.json(speaker);
      } catch (e) {
        if (!(e instanceof z.ZodError)) throw e;

        return ctx.json({ error: z.prettifyError(e) }, 400);
      }
    },
  )
  .delete("/:id", adminMiddleware, async (ctx) => {
    const removed = await assistant
      .getHandler("speaker")
      .removeSpeaker(ctx.req.param("id"));
    if (!removed) return ctx.json({ error: "Speaker not found" }, 404);

    return ctx.json({ success: true });
  })
  .post(
    "/:id/say",
    zValidator(
      "json",
      z.object({ message: z.string().trim().min(1).max(1000) }),
    ),
    async (ctx) => {
      const id = ctx.req.param("id");
      const handler = assistant.getHandler("speaker");

      if (!(await handler.getSpeaker(id)))
        return ctx.json({ error: "Speaker not found" }, 404);
      if (!handler.isOnline(id))
        return ctx.json({ error: "Speaker is offline" }, 409);

      const delivered = await assistant
        .getHandler("notification")
        .notify(ctx.req.valid("json").message, { channel: id });

      return ctx.json({ success: delivered.length > 0 });
    },
  );
