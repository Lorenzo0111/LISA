import { createMiddleware } from "hono/factory";
import { auth } from "../../services/auth";
import { type AppEnv, isAdmin } from "../context";

export const authMiddleware = createMiddleware<AppEnv>(async (ctx, next) => {
  const token = ctx.req.header("Authorization")?.split(" ")[1];

  if (token && process.env.SECRET_TOKEN && token === process.env.SECRET_TOKEN) {
    ctx.set("actor", { kind: "machine" });
    return await next();
  }

  const session = await auth.api.getSession({ headers: ctx.req.raw.headers });
  if (!session) {
    return ctx.json(
      {
        error: "Unauthorized",
      },
      401,
    );
  }

  ctx.set("actor", { kind: "user", ...session });
  return await next();
});

/** For routes that change how the assistant is set up. */
export const adminMiddleware = createMiddleware<AppEnv>(async (ctx, next) => {
  if (!isAdmin(ctx.get("actor")))
    return ctx.json({ error: "Only administrators can do this" }, 403);

  return await next();
});
