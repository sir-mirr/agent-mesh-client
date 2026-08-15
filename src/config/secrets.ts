import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

function validateSecretName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new Error("Secret name must be a safe opaque filename");
  }
}

export class SecretStore {
  constructor(readonly directory: string) {}

  path(name: string): string {
    validateSecretName(name);
    return join(this.directory, name);
  }

  async set(name: string, value: string): Promise<void> {
    if (value.length === 0) throw new Error("Secret value must not be empty");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const target = this.path(name);
    const temporary = `${target}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async get(name: string): Promise<string> {
    return await readFile(this.path(name), "utf8");
  }

  async remove(name: string): Promise<boolean> {
    try {
      await unlink(this.path(name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
