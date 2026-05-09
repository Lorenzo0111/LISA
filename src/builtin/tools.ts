import { z } from "zod";
import { assistant } from "../assistant";
import { defineTool } from "../handlers/tools";

export function registerBuiltInTools() {
  assistant.getHandler("tool").registerTool(
    defineTool({
      name: "random",
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
    }),
  );

  assistant.getHandler("tool").registerTool(
    defineTool({
      name: "get-date-time",
      description: "Get the current date and time",
      requiredArgs: z.object({}),
      async execute() {
        return { date: new Date().toString() };
      },
    }),
  );

  for (const handler of assistant.handlers.values()) {
    assistant.getHandler("tool").registerTools(handler);
  }
}
