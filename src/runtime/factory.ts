import type { RuntimeConfig } from "../config/types";
import type { RuntimeAdapter } from "./adapter";
import { RuntimeAdapterError } from "./adapter";
import { AntigravityAdapter } from "./antigravity";
import { CodexAppServerAdapter } from "./codex-app-server";

export function createRuntimeAdapter(
  config: RuntimeConfig,
  onDiagnostic?: (message: string, error?: unknown) => void,
): RuntimeAdapter {
  switch (config.kind) {
    case "codex":
      return new CodexAppServerAdapter(config, onDiagnostic);
    case "antigravity":
      return new AntigravityAdapter(config);
    case "claude":
      throw new RuntimeAdapterError(
        "RUNTIME_NOT_READY",
        "Claude runtime adapter is not initialized",
      );
  }
}
