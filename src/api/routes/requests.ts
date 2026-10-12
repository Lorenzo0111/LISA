import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";
import { prisma } from "../../services/prisma";
import { requestSchema } from "../../types/requests";
import { speakerIdSchema } from "../../types/speakers";
import { type AppEnv, isAdmin } from "../context";

const scopeSchema = z.enum(["mine", "all"]).default("mine");

export const requestsRoute = new Hono<AppEnv>()
  .post(
    "/create",
    zValidator(
      "json",
      requestSchema.extend({
        // Speaker that reads the answer out loud, on top of returning it
        speakOn: speakerIdSchema.optional(),
      }),
    ),
    async (ctx) => {
      const { speakOn, ...body } = ctx.req.valid("json");
      const actor = ctx.get("actor");

      if (actor.kind === "machine") {
        const res = await assistant.getHandler("request").handleRequest(body);
        return ctx.json(res);
      }

      const res = await assistant.getHandler("request").handleRequest({
        content: body.content,
        userId: actor.user.id,
        context: {
          ...body.context,
          // Also where timers created by this request report back to
          source: speakOn ?? "dashboard",
          user: actor.user.name,
        },
      });

      const delivered = speakOn
        ? await assistant
            .getHandler("notification")
            .notify(res.content, { channel: speakOn })
        : [];

      return ctx.json({ ...res, spoken: delivered.length > 0 });
    },
  )
  .get(
    "/",
    zValidator(
      "query",
      z.object({
        scope: scopeSchema,
        limit: z.coerce.number().int().min(1).max(100).default(30),
        before: z.coerce.number().int().positive().optional(),
      }),
    ),
    async (ctx) => {
      const { scope, limit, before } = ctx.req.valid("query");
      const actor = ctx.get("actor");

      if (scope === "all" && !isAdmin(actor))
        return ctx.json({ error: "Only administrators can do this" }, 403);

      const messages = await prisma.message.findMany({
        where: {
          id: before ? { lt: before } : undefined,
          userId:
            scope === "mine" && actor.kind === "user"
              ? actor.user.id
              : undefined,
        },
        orderBy: { id: "desc" },
        take: limit,
        include: { user: { select: { name: true } } },
      });

      return ctx.json(
        messages.map(({ user, userId: _, ...message }) => ({
          ...message,
          user: user?.name ?? null,
        })),
      );
    },
  )
  .delete(
    "/",
    zValidator("query", z.object({ scope: scopeSchema })),
    async (ctx) => {
      const { scope } = ctx.req.valid("query");
      const actor = ctx.get("actor");

      if ((scope === "all" || actor.kind === "machine") && !isAdmin(actor))
        return ctx.json({ error: "Only administrators can do this" }, 403);

      const { count } = await prisma.message.deleteMany({
        where: {
          userId:
            scope === "mine" && actor.kind === "user"
              ? actor.user.id
              : undefined,
        },
      });

      return ctx.json({ success: true, deleted: count });
    },
  );
