import { z } from "zod";

export const enabledPluginsSchema = z.array(z.string());

export const systemPromptSchema = z
  .string()
  .optional()
  .describe(
    "Replaces the built-in system prompt. Leave empty to use the default one",
  );

export const systemMemorySchema = z
  .boolean()
  .default(true)
  .describe("Lets the assistant read and write long-term memories");

export const defaultNotificationChannelSchema = z
  .string()
  .optional()
  .describe(
    "Channel used for notifications that are not tied to a specific channel",
  );
