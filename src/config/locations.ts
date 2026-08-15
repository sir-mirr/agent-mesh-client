import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface AgentMeshLocations {
  configDirectory: string;
  configFile: string;
  stateDirectory: string;
  secretDirectory: string;
  runtimeDirectory: string;
}

export function defaultLocations(env = process.env): AgentMeshLocations {
  const configDirectory = join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "agent-mesh",
  );
  const stateDirectory = join(
    env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "agent-mesh",
  );
  const runtimeDirectory = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "agent-mesh")
    : platform() === "darwin"
      ? join(homedir(), "Library", "Caches", "agent-mesh", "runtime")
      : join(stateDirectory, "runtime");
  return {
    configDirectory,
    configFile: join(configDirectory, "config.yaml"),
    stateDirectory,
    secretDirectory: join(configDirectory, "secrets"),
    runtimeDirectory,
  };
}
