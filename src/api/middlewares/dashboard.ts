import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createMiddleware } from "hono/factory";

/**
 * Serves the exported dashboard (a single page app) from DASHBOARD_DIR, so a
 * self-hosted instance needs nothing but this server. API calls are left
 * alone: only existing files and page navigations are answered here.
 */
export const dashboardMiddleware = createMiddleware(async (ctx, next) => {
  const dir = process.env.DASHBOARD_DIR && resolve(process.env.DASHBOARD_DIR);
  const { pathname } = new URL(ctx.req.url);

  if (!dir || ctx.req.method !== "GET" || pathname.startsWith("/api/"))
    return await next();

  const path = resolve(dir, `.${decodeURIComponent(pathname)}`);
  const file = Bun.file(path);

  if (path.startsWith(dir + sep) && existsSync(path) && (await file.exists()))
    if ((await file.stat()).isFile()) return new Response(file);

  if (ctx.req.header("Accept")?.includes("text/html"))
    return new Response(Bun.file(resolve(dir, "index.html")));

  return await next();
});
