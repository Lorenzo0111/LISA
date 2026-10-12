import z from "zod";
import { Handler } from "./handler";
import { type AnyTool, defineTool } from "./tools";

export interface NotificationChannel {
  readonly name: string;
  readonly description: string;

  /**
   * Deliver a message. The target is channel specific (for example a user id);
   * when omitted the channel decides who receives it.
   */
  send(message: string, target?: string): Promise<void>;
}

export interface NotificationOptions {
  channel?: string;
  target?: string;
}

export class NotificationHandler extends Handler {
  readonly name = "notification";
  private readonly channels = new Map<string, NotificationChannel>();

  async load(): Promise<void> {}
  async unload(): Promise<void> {}

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
    this.logger().info(`Registered notification channel ${channel.name}`);
  }

  unregisterChannel(channel: NotificationChannel): void {
    // A reconnecting client may already have replaced the channel
    if (this.channels.get(channel.name) !== channel) return;

    this.channels.delete(channel.name);
    this.logger().info(`Unregistered notification channel ${channel.name}`);
  }

  getChannels(): NotificationChannel[] {
    return [...this.channels.values()];
  }

  /**
   * Send a message to the user without them asking first.
   * Falls back to the NOTIFICATION_DEFAULT_CHANNEL setting, then to every
   * registered channel. Returns the names of the channels that delivered it.
   */
  async notify(
    message: string,
    options: NotificationOptions = {},
  ): Promise<string[]> {
    const requested = options.channel && this.channels.get(options.channel);
    const fallback = this.channels.get(
      this.assistant
        .getHandler("setting")
        .getSetting<string>("NOTIFICATION_DEFAULT_CHANNEL")?.value ?? "",
    );

    // The target only makes sense for the channel it was meant for
    const deliveries: [NotificationChannel, string | undefined][] = requested
      ? [[requested, options.target]]
      : fallback
        ? [[fallback, undefined]]
        : this.getChannels().map((channel) => [channel, undefined]);

    const delivered: string[] = [];
    for (const [channel, target] of deliveries) {
      try {
        await channel.send(message, target);
        delivered.push(channel.name);
      } catch (e) {
        this.logger().error(
          `Failed to notify through ${channel.name}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }

    if (delivered.length === 0)
      this.logger().warn(`No channel could deliver notification: ${message}`);

    return delivered;
  }

  override getTools(): AnyTool[] {
    const self = this;

    return [
      defineTool({
        name: "list",
        description:
          "List the channels (for example telegram or a voice speaker) a notification can be sent through",
        requiredArgs: z.object({}),
        async execute() {
          return {
            channels: self.getChannels().map((channel) => ({
              name: channel.name,
              description: channel.description,
            })),
          };
        },
      }),
      defineTool({
        name: "send",
        description:
          "Send a message to the user through a notification channel. Only use it to reach a channel other than the one the user is talking from, your normal response is already delivered to them.",
        requiredArgs: z.object({
          message: z.string().min(1),
          channel: z
            .string()
            .optional()
            .describe("Channel name. Omit to use the default channel"),
          target: z
            .string()
            .optional()
            .describe("Channel specific recipient, for example a user id"),
        }),
        async execute(args) {
          const delivered = await self.notify(args.message, {
            channel: args.channel,
            target: args.target,
          });

          return { success: delivered.length > 0, delivered };
        },
      }),
    ];
  }
}
