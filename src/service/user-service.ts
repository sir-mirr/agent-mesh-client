import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface UserServiceOptions {
  configFile: string;
  stateDirectory: string;
  runtimeDirectory: string;
  secretDirectory: string;
}

const LABEL = "com.sirmirr.agent-mesh";
const RUNTIME_COMMANDS = ["tmux", "claude", "codex", "agy", "bun", "node"] as const;

export function buildServiceEnvironmentPath(
  home: string,
  platform: NodeJS.Platform,
  discoveredDirectories: readonly string[] = [],
): string {
  const candidates = [
    resolve(home, ".local", "bin"),
    resolve(home, ".bun", "bin"),
    ...(platform === "darwin"
      ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"]
      : [resolve(home, ".linuxbrew", "bin"), "/home/linuxbrew/.linuxbrew/bin"]),
    ...discoveredDirectories,
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(candidates.filter((item) => item && item !== "."))].join(":");
}

function serviceEnvironmentPath(): string {
  const discoveredDirectories = RUNTIME_COMMANDS
    .map((name) => Bun.which(name))
    .filter((path): path is string => typeof path === "string")
    .map(dirname);
  return buildServiceEnvironmentPath(homedir(), process.platform, discoveredDirectories);
}

function command(options: UserServiceOptions): string[] {
  const isBun = /bun(?:\.exe)?$/.test(process.execPath);
  return [
    process.execPath,
    ...(isBun ? [process.argv[1]!] : []),
    "daemon",
    "run",
    "--config",
    options.configFile,
    "--state-dir",
    options.stateDirectory,
    "--runtime-dir",
    options.runtimeDirectory,
    "--secret-dir",
    options.secretDirectory,
  ];
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function systemdEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function servicePath(): string {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  }
  if (process.platform === "linux") {
    return resolve(homedir(), ".config", "systemd", "user", "agent-mesh.service");
  }
  throw new Error(`User services are not supported on ${process.platform}`);
}

export async function installUserService(options: UserServiceOptions): Promise<unknown> {
  const argv = command(options);
  await mkdir(resolve(options.stateDirectory, "logs"), {
    recursive: true,
    mode: 0o700,
  });
  const path = servicePath();
  if (process.platform === "darwin") {
    const argumentsXml = argv.map((argument) => `      <string>${xml(argument)}</string>`).join("\n");
    const environmentPath = serviceEnvironmentPath();
    await atomicWrite(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(resolve(options.stateDirectory, "logs", "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(options.stateDirectory, "logs", "daemon.error.log"))}</string>
</dict>
</plist>
`,
    );
    const domain = `gui/${process.getuid?.() ?? 0}`;
    Bun.spawnSync(["launchctl", "bootout", domain, path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const loaded = Bun.spawnSync(["launchctl", "bootstrap", domain, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (loaded.exitCode !== 0) {
      throw new Error(loaded.stderr.toString("utf8").trim() || "launchctl bootstrap failed");
    }
    return { installed: true, manager: "launchd", path };
  }

  const exec = argv.map(systemdEscape).join(" ");
  const environmentPath = serviceEnvironmentPath();
  await atomicWrite(
    path,
    `[Unit]
Description=Agent Mesh client host daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=3
UMask=0077
Environment=${systemdEscape(`PATH=${environmentPath}`)}

[Install]
WantedBy=default.target
`,
  );
  const reloaded = Bun.spawnSync(["systemctl", "--user", "daemon-reload"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (reloaded.exitCode !== 0) throw new Error(reloaded.stderr.toString("utf8").trim());
  const enabled = Bun.spawnSync(
    ["systemctl", "--user", "enable", "--now", "agent-mesh.service"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (enabled.exitCode !== 0) throw new Error(enabled.stderr.toString("utf8").trim());
  return { installed: true, manager: "systemd-user", path };
}

export async function userServiceStatus(): Promise<unknown> {
  const path = servicePath();
  let installed = true;
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") installed = false;
    else throw error;
  }
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(
      ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${LABEL}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    return {
      installed,
      running: result.exitCode === 0,
      manager: "launchd",
      path,
    };
  }
  const result = Bun.spawnSync(
    ["systemctl", "--user", "is-active", "agent-mesh.service"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    installed,
    running: result.exitCode === 0,
    manager: "systemd-user",
    path,
  };
}

export async function stopUserService(): Promise<unknown> {
  const path = servicePath();
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(
      ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}`, path],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8");
      if (!detail.includes("Could not find service") && !detail.includes("No such process")) {
        throw new Error(detail.trim() || "launchctl bootout failed");
      }
    }
    return { stopped: true, manager: "launchd", path };
  }
  const result = Bun.spawnSync(["systemctl", "--user", "stop", "agent-mesh.service"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return { stopped: true, manager: "systemd-user", path };
}

export async function restartUserService(options: UserServiceOptions): Promise<unknown> {
  const status = await userServiceStatus() as { installed: boolean };
  if (!status.installed) return await installUserService(options);
  if (process.platform === "darwin") {
    await installUserService(options);
    return { restarted: true, manager: "launchd", path: servicePath() };
  }
  await installUserService(options);
  const result = Bun.spawnSync(
    ["systemctl", "--user", "restart", "agent-mesh.service"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return { restarted: true, manager: "systemd-user", path: servicePath() };
}

export async function userServiceLogs(
  options: Pick<UserServiceOptions, "stateDirectory">,
  lines = 100,
): Promise<{ stdout: string; stderr: string }> {
  const tail = (value: string) => value.split("\n").slice(-Math.max(1, lines) - 1).join("\n");
  const read = async (name: string) => {
    try {
      return tail(await readFile(resolve(options.stateDirectory, "logs", name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  return {
    stdout: await read("daemon.log"),
    stderr: await read("daemon.error.log"),
  };
}

export async function uninstallUserService(): Promise<unknown> {
  const path = servicePath();
  if (process.platform === "darwin") {
    Bun.spawnSync(
      ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}`, path],
      { stdout: "ignore", stderr: "ignore" },
    );
  } else {
    Bun.spawnSync(
      ["systemctl", "--user", "disable", "--now", "agent-mesh.service"],
      { stdout: "ignore", stderr: "ignore" },
    );
  }
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (process.platform === "linux") {
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  return { installed: false, path };
}
