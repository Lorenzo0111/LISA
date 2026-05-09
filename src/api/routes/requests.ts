import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { assistant } from "../../assistant";
import { requestSchema } from "../../types/requests";

export const requestsRoute = new Hono().post(
  "/create",
  zValidator("json", requestSchema),
  async (ctx) => {
    const body = ctx.req.valid("json");
    const res = await assistant.getHandler("request").handleRequest(body);

    return ctx.json(res);
  },
);
