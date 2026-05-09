import { z } from "zod";
import { assistant } from "../assistant";

export function registerBuiltInTools() {
  assistant.getHandler("tool").registerTool({
    name: "builtin:random",
    description: "Generate a random number",
    requiredArgs: z.object({
      min: z.number(),
      max: z.number(),
    }),
    async execute(args) {
      return {
        random: Math.round(Math.random() * (args.max - args.min) + args.min),
      };
    },
  });

  assistant.getHandler("tool").registerTool({
    name: "builtin:get-date-time",
    description: "Get the current date and time",
    requiredArgs: z.object({}),
    async execute() {
      return { date: new Date().toString() };
    },
  });

  assistant.handlers.forEach((handler) =>
    assistant.getHandler("tool").registerTools(handler),
  );
}
