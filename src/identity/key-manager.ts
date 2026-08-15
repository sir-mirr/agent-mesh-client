import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  keyFingerprint,
  requestSignaturePreimage,
  uploadSignaturePreimage,
  formatUploadAuthorization,
  type RequestSignature,
} from "@agent-mesh/contracts";
import { SecretStore } from "../config/secrets";
import { laneStorageName } from "../config/paths";
import { prefixedId } from "../util/ids";

interface PersistedIdentityKey {
  version: 1;
  algorithm: "ed25519";
  public_key: string;
  private_key_pkcs8: string;
  created_at: string;
}

export interface IdentityKeyInfo {
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export class IdentityKeyManager {
  readonly #secretName: string;
  #record: PersistedIdentityKey | null = null;
  #privateKey: KeyObject | null = null;

  constructor(
    readonly identity: string,
    readonly secrets: SecretStore,
  ) {
    this.#secretName = `${laneStorageName(identity)}.ed25519.json`;
  }

  async ensure(): Promise<IdentityKeyInfo> {
    if (!this.#record) {
      try {
        this.#record = JSON.parse(
          await this.secrets.get(this.#secretName),
        ) as PersistedIdentityKey;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const jwk = publicKey.export({ format: "jwk" });
        if (!jwk.x) throw new Error("Generated Ed25519 key has no raw public component");
        this.#record = {
          version: 1,
          algorithm: "ed25519",
          public_key: jwk.x,
          private_key_pkcs8: privateKey
            .export({ format: "der", type: "pkcs8" })
            .toString("base64"),
          created_at: new Date().toISOString(),
        };
        await this.secrets.set(this.#secretName, JSON.stringify(this.#record));
      }
    }
    this.#validateRecord(this.#record);
    return {
      publicKey: this.#record.public_key,
      fingerprint: keyFingerprint(this.#record.public_key),
      createdAt: this.#record.created_at,
    };
  }

  async signRequest(
    method: string,
    rawParams: Uint8Array,
  ): Promise<RequestSignature> {
    const info = await this.ensure();
    const nonce = prefixedId("nonce");
    const iat = Math.floor(Date.now() / 1000);
    const value = sign(
      null,
      requestSignaturePreimage({
        method,
        kid: info.fingerprint,
        nonce,
        iat,
        rawParams,
      }),
      this.#getPrivateKey(),
    ).toString("base64url");
    return {
      alg: "ed25519",
      kid: info.fingerprint,
      nonce,
      iat,
      value,
    };
  }

  async uploadAuthorization(input: {
    nonce: string;
    blobKey: string;
    sha256: string;
    size: number;
  }): Promise<string> {
    const info = await this.ensure();
    const signature = sign(
      null,
      uploadSignaturePreimage(input),
      this.#getPrivateKey(),
    ).toString("base64url");
    return formatUploadAuthorization({
      kid: info.fingerprint,
      nonce: input.nonce,
      signature,
    });
  }

  #getPrivateKey(): KeyObject {
    if (!this.#record) throw new Error("Identity key is not initialized");
    this.#privateKey ??= createPrivateKey({
      key: Buffer.from(this.#record.private_key_pkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    return this.#privateKey;
  }

  #validateRecord(record: PersistedIdentityKey): void {
    if (
      record.version !== 1 ||
      record.algorithm !== "ed25519" ||
      typeof record.public_key !== "string" ||
      typeof record.private_key_pkcs8 !== "string"
    ) {
      throw new Error("Stored identity key is invalid");
    }
    keyFingerprint(record.public_key);
  }
}
