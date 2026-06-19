import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("context storage CLI contract", () => {
  it("shows storage command in help", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "--help"],
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });

    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("storage");
    expect(stdout).not.toContain("cloud");
  });

  it("registers storage commands without a migration alias", () => {
    const source = readFileSync(join(import.meta.dir, "storage.ts"), "utf8");

    expect(source).toContain("registerStorageCommands");
    expect(source).toContain('program.command("storage")');
    expect(source).not.toContain('program.command("cloud"');
  });
});
