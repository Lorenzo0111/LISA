import { Hono } from "hono";
import { assistant } from "../../assistant";
import type { AppEnv } from "../context";
import { adminMiddleware } from "../middlewares/auth";

export const pluginsRoute = new Hono<AppEnv>()
  .use(adminMiddleware)
  .get("/", (ctx) => {
    return ctx.json(assistant.pluginLoader.describePlugins());
  })
  .post("/:name/:action{enable|disable|reload}", async (ctx) => {
    const { name, action } = ctx.req.param();
    const loader = assistant.pluginLoader;

    if (!loader.availablePlugins().includes(name))
      return ctx.json({ error: `Plugin ${name} not found` }, 404);

    if (action === "enable") await loader.enablePlugin(name);
    else if (action === "disable") await loader.disablePlugin(name);
    else {
      await loader.unloadPlugin(name);
      await loader.loadPlugin(name);
    }

    return ctx.json(
      loader.describePlugins().find((plugin) => plugin.name === name),
    );
  });
