import z from "zod";
import type { Memory } from "../generated/prisma/client";
import { prisma } from "../services/prisma";
import { Handler } from "./handler";
import { type AnyTool, defineTool } from "./tools";

const tagSchema = z.array(z.string().trim().min(1)).default([]);

function formatMemory(memory: Memory) {
  return {
    ...memory,
    tags: memory.tags?.split(",").map((tag) => tag.trim()) || [],
  };
}

export class MemoryHandler extends Handler {
  readonly name = "memory";

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  async createMemory(title: string, content: string, tags: string[] = []) {
    return await prisma.memory.create({
      data: {
        title,
        content,
        tags: tags.length > 0 ? tags.join(",") : null,
      },
    });
  }

  async getMemory(id: number): Promise<Memory | null> {
    return await prisma.memory.findUnique({
      where: { id },
    });
  }

  async listTitles(): Promise<Record<number, string>> {
    const memories = await prisma.memory.findMany({
      select: { id: true, title: true },
      orderBy: { updatedAt: "desc" },
    });

    return memories.reduce(
      (acc, memory) => {
        acc[memory.id] = memory.title;
        return acc;
      },
      {} as Record<number, string>,
    );
  }

  async listMemories(tags?: string[]): Promise<Memory[]> {
    const memories = await prisma.memory.findMany({
      orderBy: { updatedAt: "desc" },
    });

    if (!tags || tags.length === 0) return memories;

    const tagSet = new Set(tags.map((tag) => tag.trim()).filter(Boolean));
    return memories.filter((memory) => {
      if (!memory.tags) return false;
      const memoryTags = memory.tags.split(",").map((tag) => tag.trim());
      return memoryTags.some((tag) => tagSet.has(tag));
    });
  }

  async updateMemory(
    id: number,
    data: { title?: string; content?: string; tags?: string[] },
  ): Promise<Memory | null> {
    const existingMemory = await this.getMemory(id);
    if (!existingMemory) return null;

    return await prisma.memory.update({
      where: { id },
      data: {
        title: data.title,
        content: data.content,
        tags: data.tags === undefined ? undefined : data.tags.join(","),
      },
    });
  }

  async deleteMemory(id: number): Promise<Memory | null> {
    const existingMemory = await this.getMemory(id);
    if (!existingMemory) return null;

    return await prisma.memory.delete({
      where: { id },
    });
  }

  override getTools(): AnyTool[] {
    const self = this;

    return [
      defineTool({
        name: "create",
        description:
          "Store a durable memory in markdown format. Use this when the user asks you to remember facts, preferences, plans, or other useful long-term context.",
        requiredArgs: z.object({
          title: z.string().min(1).describe("A short title for the memory"),
          content: z
            .string()
            .min(1)
            .describe(
              "The memory body in markdown format. Prefer concise bullet points or short sections.",
            ),
          tags: tagSchema.describe(
            "Optional lowercase tags that describe the memory topic",
          ),
        }),
        async execute(args) {
          const memory = await self.createMemory(
            args.title,
            args.content,
            args.tags,
          );

          return { success: true, memory: formatMemory(memory) };
        },
      }),
      defineTool({
        name: "list",
        description:
          "List stored memories. Optionally filter by tags to find relevant long-term context.",
        requiredArgs: z.object({
          tags: tagSchema.describe(
            "Optional english tags to filter memories by",
          ),
        }),
        async execute(args) {
          const memories = await self.listMemories(args.tags);
          return { memories: memories.map(formatMemory) };
        },
      }),
      defineTool({
        name: "get",
        description:
          "Get one stored memory by id, including its markdown body.",
        requiredArgs: z.object({
          id: z.number().int().positive(),
        }),
        async execute(args) {
          const memory = await self.getMemory(args.id);
          if (!memory) return { error: "Memory not found" };

          return formatMemory(memory);
        },
      }),
      defineTool({
        name: "update",
        description:
          "Update an existing stored memory. Content should remain valid markdown.",
        requiredArgs: z.object({
          id: z.number().int().positive(),
          title: z.string().min(1).optional(),
          content: z.string().min(1).optional(),
          tags: tagSchema
            .optional()
            .describe("Replacement tags for this memory"),
        }),
        async execute(args) {
          const memory = await self.updateMemory(args.id, {
            title: args.title,
            content: args.content,
            tags: args.tags,
          });
          if (!memory) return { error: "Memory not found" };

          return { success: true, memory: formatMemory(memory) };
        },
      }),
      defineTool({
        name: "delete",
        description: "Delete a stored memory by id.",
        requiredArgs: z.object({
          id: z.number().int().positive(),
        }),
        async execute(args) {
          const memory = await self.deleteMemory(args.id);
          if (!memory) return { error: "Memory not found" };

          return { success: true, memory: formatMemory(memory) };
        },
      }),
    ];
  }
}
