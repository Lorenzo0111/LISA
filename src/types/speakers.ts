import { z } from "zod";

/** Everything about a voice worker that the dashboard can change remotely. */
export const speakerConfigSchema = z.object({
  wakeWord: z.string().trim().min(1).max(40).default("lisa"),
  // Other spellings Whisper may produce for the wake word
  wakeWordAliases: z
    .array(z.string().trim().min(1).max(40))
    .max(10)
    .default([]),
  // Whisper language code, null for auto-detect
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable()
    .default(null),
  wakeModel: z.string().trim().min(1).max(60).default("tiny"),
  transcriptionModel: z.string().trim().min(1).max(60).default("small"),
  vadThreshold: z.number().min(0.1).max(0.95).default(0.5),
  endSilenceSeconds: z.number().min(0.3).max(3).default(0.8),
  followUpSeconds: z.number().min(2).max(20).default(6),
  ttsEngine: z.enum(["piper", "system", "none"]).default("piper"),
  // Piper voice name, null to pick the default voice of the language
  ttsVoice: z.string().trim().min(1).max(120).nullable().default(null),
  ttsSpeed: z.number().min(0.5).max(2).default(1),
  micMuted: z.boolean().default(false),
});

export type SpeakerConfig = z.infer<typeof speakerConfigSchema>;

export const speakerIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]+$/i)
  .max(60);

export const registerSpeakerSchema = z.object({
  id: speakerIdSchema,
  name: z.string().trim().min(1).max(60).optional(),
  hostname: z.string().max(120).optional(),
  version: z.string().max(40).optional(),
  // What the worker would use on its own (.env), kept for a speaker seen for the first time
  defaults: z.record(z.string(), z.unknown()).optional(),
});

export const updateSpeakerSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  room: z.string().trim().max(60).nullable().optional(),
  // Only the fields to change, checked against speakerConfigSchema once merged
  config: z.record(z.string(), z.unknown()).optional(),
});
