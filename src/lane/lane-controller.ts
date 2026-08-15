import { resolve } from "node:path";
import { laneStorageName } from "../config/paths";
import type { ChannelConfig, LaneConfig } from "../config/types";
import { DurableChannelHandler } from "./channel-handler";
import { LaneOutbox } from "../outbox/lane-outbox";
import type { StoredAuditEvent } from "../outbox/types";
import { RuntimeInbox } from "../runtime/inbox";

export interface LaneControllerOptions {
  config: LaneConfig;
  stateRoot: string;
  onInbound?: (event: StoredAuditEvent) => void | Promise<void>;
}

export class LaneController {
  readonly config: LaneConfig;
  readonly stateDirectory: string;
  readonly outbox: LaneOutbox;
  readonly channelHandler: DurableChannelHandler;
  readonly runtimeInbox: RuntimeInbox;

  constructor(options: LaneControllerOptions) {
    this.config = options.config;
    this.stateDirectory = resolve(
      options.stateRoot,
      "lanes",
      laneStorageName(options.config.id),
    );
    this.outbox = new LaneOutbox(options.config.id, this.stateDirectory);
    this.runtimeInbox = new RuntimeInbox(this.stateDirectory);
    this.channelHandler = new DurableChannelHandler(this.outbox, {
      onAccepted: async (event) => {
        this.runtimeInbox.enqueueChannel(event);
        await options.onInbound?.(event);
      },
    });
  }

  async initialize(): Promise<void> {
    await this.outbox.initialize();
    await this.runtimeInbox.initialize();
  }

  close(): void {
    this.outbox.close();
    this.runtimeInbox.close();
  }

  updateChannels(channels: ChannelConfig[]): void {
    this.config.channels = channels;
  }
}
