import { describe, expect, test } from "bun:test";
import { buildServiceEnvironmentPath } from "../src/service/user-service";

describe("user service environment", () => {
  test("makes Homebrew and user-installed runtime commands visible to launchd", () => {
    const path = buildServiceEnvironmentPath(
      "/Users/example",
      "darwin",
      ["/Applications/ChatGPT.app/Contents/Resources", "/opt/homebrew/bin"],
    ).split(":");

    expect(path).toContain("/Users/example/.local/bin");
    expect(path).toContain("/Users/example/.bun/bin");
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/Applications/ChatGPT.app/Contents/Resources");
    expect(path.filter((item) => item === "/opt/homebrew/bin")).toHaveLength(1);
    expect(path).toContain("/usr/bin");
  });

  test("includes common Linux user and Linuxbrew command locations", () => {
    const path = buildServiceEnvironmentPath("/home/example", "linux").split(":");
    expect(path).toContain("/home/example/.local/bin");
    expect(path).toContain("/home/example/.linuxbrew/bin");
    expect(path).toContain("/home/linuxbrew/.linuxbrew/bin");
  });
});
