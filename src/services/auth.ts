import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { prisma } from "./prisma";

const DEV_ORIGINS = [
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
];

/**
 * Origins a browser may call the API from. The dashboard served by this
 * instance (DASHBOARD_DIR) is same-origin and needs no entry.
 */
export const trustedOrigins = [
  ...(process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
  ...(process.env.NODE_ENV === "production" ? [] : DEV_ORIGINS),
];

export const auth = betterAuth({
  appName: "LISA",
  baseURL: process.env.BETTER_AUTH_URL,
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  plugins: [
    // The mobile app has no cookie jar, it sends the session token as a bearer
    bearer(),
    admin(),
  ],
  hooks: {
    // Only the owner signs up on their own, everyone else is added by an admin
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;

      if ((await prisma.user.count()) > 0)
        throw new APIError("FORBIDDEN", {
          message:
            "Registration is closed, ask an administrator for an account",
        });
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const first = (await prisma.user.count()) === 0;
          return { data: first ? { ...user, role: "admin" } : user };
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
