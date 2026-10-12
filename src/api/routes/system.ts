import { Hono } from "hono";
import { assistant } from "../../assistant";
import { prisma } from "../../services/prisma";

const VERSION = "1.0.0";

/** What a client needs before it can sign in. Not authenticated. */
export const publicSystemRoute = new Hono().get("/info", async (ctx) => {
  return ctx.json({
    name: "LISA",
    version: VERSION,
    // Nobody has an account yet: the next sign up becomes the administrator
    setupRequired: (await prisma.user.count()) === 0,
  });
});

export const systemRoute = new Hono().get("/health", (ctx) => {
  return ctx.json({
    status: "ok",
    version: VERSION,
    uptime: Math.round(process.uptime()),
    ai: assistant.getHandler("request").aiInfo(),
    plugins: assistant.pluginLoader.plugins.map((plugin) => plugin.name),
    tools: assistant.getHandler("tool").tools.length,
  });
});
