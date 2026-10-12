import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";

export const devicesRoute = new Hono()
  .get("/", async (ctx) => {
    const devices = await assistant.getHandler("device").getDevices();
    return ctx.json(devices);
  })
  .get("/:id", async (ctx) => {
    const id = ctx.req.param("id");

    const device = await assistant.getHandler("device").getDevice(id);
    if (!device) return ctx.json({ error: "Device not found" }, 404);

    return ctx.json({
      ...device,
      adapter: undefined,
    });
  })
  .post(
    "/:id/execute",
    zValidator(
      "json",
      z.object({
        action: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (ctx) => {
      const id = ctx.req.param("id");
      const body = ctx.req.valid("json");

      const res = await assistant
        .getHandler("device")
        .executeAction(id, body.action, body.params);
      return ctx.json({
        success: res,
      });
    },
  );
