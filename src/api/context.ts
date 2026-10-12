import type { AuthSession } from "../services/auth";

/** Who is calling: a dashboard user, or a machine holding SECRET_TOKEN (a voice worker). */
export type Actor =
  | { kind: "machine" }
  | {
      kind: "user";
      user: AuthSession["user"];
      session: AuthSession["session"];
    };

export type AppEnv = { Variables: { actor: Actor } };

export function isAdmin(actor: Actor): boolean {
  return actor.kind === "machine" || actor.user.role === "admin";
}
