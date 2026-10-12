import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, trustedOrigins } from "../services/auth";
import type { AppEnv } from "./context";
import { authMiddleware } from "./middlewares/auth";
import { dashboardMiddleware } from "./middlewares/dashboard";
import { errorMiddleware, loggerMiddleware } from "./middlewares/utilities";
import { devicesRoute } from "./routes/devices";
import { memoriesRoute } from "./routes/memories";
import { notificationsRoute } from "./routes/notifications";
import { pluginsRoute } from "./routes/plugins";
import { requestsRoute } from "./routes/requests";
import { settingsRoute } from "./routes/settings";
import { speakersRoute } from "./routes/speakers";
import { publicSystemRoute, systemRoute } from "./routes/system";
import { timersRoute } from "./routes/timers";

const api = new Hono<AppEnv>()
  .route("/system", publicSystemRoute)
  .use(authMiddleware)
  .route("/system", systemRoute)
  .route("/requests", requestsRoute)
  .route("/settings", settingsRoute)
  .route("/plugins", pluginsRoute)
  .route("/devices", devicesRoute)
  .route("/speakers", speakersRoute)
  .route("/timers", timersRoute)
  .route("/memories", memoriesRoute)
  .route("/notifications", notificationsRoute);

export const apiServer = new Hono()
  .use(loggerMiddleware)
  .use(
    cors({
      origin: (origin) => (trustedOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      // The session token of a mobile sign in
      exposeHeaders: ["set-auth-token"],
    }),
  )
  .use(errorMiddleware)
  .on(["GET", "POST"], "/api/auth/*", (ctx) => auth.handler(ctx.req.raw))
  .route("/api", api)
  .use(dashboardMiddleware)
  // The API also answers without the /api prefix, which is what voice workers
  // and older clients call
  .route("/", api);

export function initializeServer() {
  const PORT = process.env.PORT || 3000;

  Bun.serve({
    fetch: apiServer.fetch,
    port: PORT,
    // Model responses and notification streams outlive the 10 second default
    idleTimeout: 255,
  });

  return PORT;
}
