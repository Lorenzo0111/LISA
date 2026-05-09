import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";

export const settingsRoute = new Hono()
  .get("/", async (ctx) => {
    const settings = assistant.getHandler("setting").allSettings();

    return ctx.json(settings);
  })
  .post(
    "/:key",
    zValidator(
      "json",
      z.object({
        value: z.unknown(),
      }),
    ),
    async (ctx) => {
      const key = ctx.req.param("key");
      const { value } = ctx.req.valid("json");

      await assistant.getHandler("setting").setSetting(key, value);

      return ctx.json({
        success: true,
      });
    },
  );
