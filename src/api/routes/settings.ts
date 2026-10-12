import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";
import type { AppEnv } from "../context";
import { adminMiddleware } from "../middlewares/auth";

// Settings hold API keys and tokens, so they are for administrators only
export const settingsRoute = new Hono<AppEnv>()
  .use(adminMiddleware)
  .get("/", async (ctx) => {
    const settings = await assistant.getHandler("setting").describeSettings();

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
      const handler = assistant.getHandler("setting");

      // null clears the setting, anything else has to fit its schema
      const schema = handler.getSchema(key);
      if (schema && value !== null && value !== undefined) {
        let parsed: ReturnType<z.ZodType["safeParse"]> | undefined;
        try {
          parsed = z
            .fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
            .safeParse(value);
        } catch {
          // A schema zod cannot rebuild is not a reason to refuse the value
        }

        if (parsed && !parsed.success)
          return ctx.json(
            { error: `Invalid value: ${z.prettifyError(parsed.error)}` },
            400,
          );
      }

      await handler.setSetting(key, value ?? null);

      return ctx.json({
        success: true,
      });
    },
  );
