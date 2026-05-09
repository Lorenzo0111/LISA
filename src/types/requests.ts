import { z } from "zod";
import type { MessageType } from "../generated/prisma/enums";

export const requestSchema = z.object({
  content: z.string(),
  context: z.record(z.string(), z.string()).optional(),
});

export type RequestType = z.infer<typeof requestSchema> & {
  type?: MessageType;
};
