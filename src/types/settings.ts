import { z } from "zod";

export const enabledPluginsSchema = z.array(z.string());

export const defaultNotificationChannelSchema = z
  .string()
  .optional()
  .describe(
    "Channel used for notifications that are not tied to a specific channel",
  );
