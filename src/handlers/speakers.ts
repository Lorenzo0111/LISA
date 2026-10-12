import type { z } from "zod";
import type { Speaker } from "../generated/prisma/client";
import { prisma } from "../services/prisma";
import {
  type registerSpeakerSchema,
  type SpeakerConfig,
  speakerConfigSchema,
  type updateSpeakerSchema,
} from "../types/speakers";
import { Handler } from "./handler";

/** The open notification stream of a worker, used to push configuration to it. */
export interface SpeakerConnection {
  pushConfig(config: SpeakerConfig): Promise<void>;
}

function parseConfig(raw: unknown): SpeakerConfig {
  const parsed = speakerConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : speakerConfigSchema.parse({});
}

function storedConfig(speaker: Speaker): SpeakerConfig {
  try {
    return parseConfig(speaker.config ? JSON.parse(speaker.config) : {});
  } catch {
    return parseConfig({});
  }
}

export class SpeakerHandler extends Handler {
  readonly name = "speaker";
  private readonly connections = new Map<string, SpeakerConnection>();

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  private format(speaker: Speaker) {
    return {
      id: speaker.id,
      name: speaker.name,
      room: speaker.room,
      config: storedConfig(speaker),
      hostname: speaker.hostname,
      version: speaker.version,
      online: this.connections.has(speaker.id),
      lastSeenAt: speaker.lastSeenAt,
      createdAt: speaker.createdAt,
    };
  }

  isOnline(id: string): boolean {
    return this.connections.has(id);
  }

  async getSpeakers() {
    const speakers = await prisma.speaker.findMany({
      orderBy: { createdAt: "asc" },
    });

    return speakers.map((speaker) => this.format(speaker));
  }

  async getSpeaker(id: string) {
    const speaker = await prisma.speaker.findUnique({ where: { id } });
    return speaker && this.format(speaker);
  }

  /** Called by a worker when it starts. Returns the configuration it has to use. */
  async register(data: z.infer<typeof registerSpeakerSchema>) {
    const existing = await prisma.speaker.findUnique({
      where: { id: data.id },
    });

    const speaker = existing
      ? await prisma.speaker.update({
          where: { id: data.id },
          data: {
            hostname: data.hostname,
            version: data.version,
            lastSeenAt: new Date(),
          },
        })
      : await prisma.speaker.create({
          data: {
            id: data.id,
            name: data.name ?? data.id,
            hostname: data.hostname,
            version: data.version,
            config: JSON.stringify(parseConfig(data.defaults)),
            lastSeenAt: new Date(),
          },
        });

    if (!existing) this.logger().info(`Registered new speaker ${speaker.id}`);

    return this.format(speaker);
  }

  async updateSpeaker(id: string, data: z.infer<typeof updateSpeakerSchema>) {
    const existing = await prisma.speaker.findUnique({ where: { id } });
    if (!existing) return null;

    // Throws a ZodError when a changed field is not valid
    const config = speakerConfigSchema.parse({
      ...storedConfig(existing),
      ...data.config,
    });
    const speaker = await prisma.speaker.update({
      where: { id },
      data: {
        name: data.name,
        room: data.room === "" ? null : data.room,
        config: JSON.stringify(config),
      },
    });

    if (data.config)
      await this.connections
        .get(id)
        ?.pushConfig(config)
        .catch((e) =>
          this.logger().warn(
            `Could not push configuration to ${id}: ${
              e instanceof Error ? e.message : e
            }`,
          ),
        );

    return this.format(speaker);
  }

  async removeSpeaker(id: string): Promise<boolean> {
    const existing = await prisma.speaker.findUnique({ where: { id } });
    if (!existing) return false;

    await prisma.speaker.delete({ where: { id } });
    return true;
  }

  /** Ties a notification stream to a registered speaker. */
  async connect(id: string, connection: SpeakerConnection): Promise<boolean> {
    const speaker = await prisma.speaker.findUnique({ where: { id } });
    if (!speaker) return false;

    this.connections.set(id, connection);
    await prisma.speaker.update({
      where: { id },
      data: { lastSeenAt: new Date() },
    });

    return true;
  }

  async disconnect(id: string, connection: SpeakerConnection): Promise<void> {
    // A reconnecting worker may already have replaced the connection
    if (this.connections.get(id) !== connection) return;

    this.connections.delete(id);
    await prisma.speaker
      .update({ where: { id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }
}
