import type { MeshMessageParams } from "@agent-mesh/contracts/schema";
import { SecretStore } from "../config/secrets";
import type { HubConfig, LaneConfig } from "../config/types";
import { IdentityKeyManager } from "../identity/key-manager";
import type { LaneOutbox } from "../outbox/lane-outbox";
import { AuditWorker, type AuditWorkerStatus } from "./audit-worker";
import { resolveHubEndpoints } from "./endpoints";
import { MeshClient } from "./mesh-client";
import {
  AgentIdentityConflictError,
  lookupAgentIdentity,
  provisionAgent,
} from "./provisioning";

export interface LaneHubStatus {
  state: "stopped" | "connecting" | "connected" | "approval" | "retrying" | "conflict";
  identity: string;
  fingerprint: string | null;
  keyStatus: string | null;
  lastError: string | null;
  audit: AuditWorkerStatus | null;
}

export class LaneHubConnection {
  readonly keyManager: IdentityKeyManager;
  readonly mesh: MeshClient;
  readonly auditWorker: AuditWorker;
  readonly #abort = new AbortController();
  readonly #handlers = new Set<
    (message: MeshMessageParams) => void | Promise<void>
  >();
  #loop: Promise<void> | null = null;
  #status: LaneHubStatus;

  constructor(
    readonly lane: LaneConfig,
    hub: HubConfig,
    outbox: LaneOutbox,
    secrets: SecretStore,
  ) {
    this.keyManager = new IdentityKeyManager(lane.identity, secrets);
    const endpoints = resolveHubEndpoints(hub.base_url, hub);
    this.mesh = new MeshClient(endpoints, lane.identity, this.keyManager);
    this.mesh.onMessage((message) => {
      for (const handler of this.#handlers) {
        void Promise.resolve(handler(message)).catch(() => undefined);
      }
    });
    this.auditWorker = new AuditWorker(outbox, this.mesh, this.keyManager);
    this.#status = {
      state: "stopped",
      identity: lane.identity,
      fingerprint: null,
      keyStatus: null,
      lastError: null,
      audit: null,
    };
  }

  get status(): LaneHubStatus {
    return { ...this.#status, audit: this.auditWorker.status };
  }

  onMessage(handler: (message: MeshMessageParams) => void | Promise<void>): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  start(): void {
    if (this.#loop) return;
    this.auditWorker.start();
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    this.mesh.close();
    await this.auditWorker.stop();
    await this.#loop;
    this.#loop = null;
    this.#status = { ...this.#status, state: "stopped" };
  }

  async send(
    to: string,
    content: string,
    replyTo?: string | null,
    clientMessageId?: string,
  ): Promise<unknown> {
    return await this.mesh.send(to, content, replyTo, clientMessageId);
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#abort.signal.aborted) {
      try {
        this.#status = { ...this.#status, state: "connecting", lastError: null };
        const key = await this.keyManager.ensure();
        this.#status = { ...this.#status, fingerprint: key.fingerprint };
        const registered = await lookupAgentIdentity(this.mesh.endpoints, this.lane.identity);
        let keyStatus: string;
        if (registered) {
          if (registered.deleted) {
            throw new AgentIdentityConflictError(
              this.lane.identity,
              "IDENTITY_DELETED",
              `Agent Identity is permanently reserved after deletion: ${this.lane.identity}`,
            );
          }
          const ownKey = registered.keys.find(
            (candidate) => candidate.fingerprint === key.fingerprint,
          );
          if (!ownKey) {
            throw new AgentIdentityConflictError(
              this.lane.identity,
              "IDENTITY_EXISTS",
              `Agent Identity belongs to a different key: ${this.lane.identity}`,
            );
          }
          keyStatus = ownKey.status;
        } else {
          const provisioned = await provisionAgent(this.mesh.endpoints, {
            identity: this.lane.identity,
            type: this.lane.agent_type,
            description: `Agent Mesh lane ${this.lane.id}`,
            public_key: key.publicKey,
            create_only: true,
          });
          keyStatus = provisioned.key?.status ?? "legacy-unverified";
        }
        this.#status = {
          ...this.#status,
          keyStatus,
        };
        await this.mesh.connect();
        this.#status = { ...this.#status, state: "connected", lastError: null };
        this.auditWorker.poke();
        attempt = 0;
        while (
          !this.#abort.signal.aborted &&
          this.mesh.status.state === "connected"
        ) {
          await this.#sleep(1_000);
        }
      } catch (error) {
        if (error instanceof AgentIdentityConflictError) {
          this.#status = {
            ...this.#status,
            state: "conflict",
            lastError: `${error.code}: ${error.message}`,
          };
          await new Promise<void>((resolve) => {
            if (this.#abort.signal.aborted) return resolve();
            this.#abort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          break;
        }
        const approval = this.mesh.status.state === "approval";
        this.#status = {
          ...this.#status,
          state: approval ? "approval" : "retrying",
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
      if (!this.#abort.signal.aborted) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
        attempt += 1;
        await this.#sleep(delay);
      }
    }
  }

  async #sleep(milliseconds: number): Promise<void> {
    if (this.#abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      this.#abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
