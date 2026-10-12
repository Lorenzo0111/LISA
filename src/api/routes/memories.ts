import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { assistant } from "../../assistant";
import { formatMemory } from "../../handlers/memory";
import type { AppEnv } from "../context";

const memorySchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(20000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const memoriesRoute = new Hono<AppEnv>()
  .get("/", async (ctx) => {
    const memories = await assistant.getHandler("memory").listMemories();
    return ctx.json(memories.map(formatMemory));
  })
  .post("/", zValidator("json", memorySchema), async (ctx) => {
    const body = ctx.req.valid("json");
    const memory = await assistant
      .getHandler("memory")
      .createMemory(body.title, body.content, body.tags);

    return ctx.json(formatMemory(memory), 201);
  })
  .patch(
    "/:id{[0-9]+}",
    zValidator(
      "json",
      memorySchema.partial({ title: true, content: true }).extend({
        tags: memorySchema.shape.tags.optional(),
      }),
    ),
    async (ctx) => {
      const memory = await assistant
        .getHandler("memory")
        .updateMemory(Number(ctx.req.param("id")), ctx.req.valid("json"));
      if (!memory) return ctx.json({ error: "Memory not found" }, 404);

      return ctx.json(formatMemory(memory));
    },
  )
  .delete("/:id{[0-9]+}", async (ctx) => {
    const memory = await assistant
      .getHandler("memory")
      .deleteMemory(Number(ctx.req.param("id")));
    if (!memory) return ctx.json({ error: "Memory not found" }, 404);

    return ctx.json({ success: true });
  });
