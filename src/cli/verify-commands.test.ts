import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("context verify CLI contract", () => {
  it("does not create a SQLite database for status when none exists", () => {
    const cwd = join(import.meta.dir, "../..");
    const root = mkdtempSync(join(tmpdir(), "context-status-readonly-"));
    const dbPath = join(root, "context.db");
    try {
      const status = Bun.spawnSync({
        cmd: ["bun", "src/cli/index.tsx", "status"],
        cwd,
        env: {
          ...process.env,
          HOME: join(root, "home"),
          CONTEXT_DB_PATH: dbPath,
          HASNA_CONTEXT_DB_PATH: dbPath,
          NO_COLOR: "1",
        },
      });
      const stdout = new TextDecoder().decode(status.stdout);

      expect(status.exitCode).toBe(0);
      expect(stdout).toContain("Libraries:       0");
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows verify command and smoke options in help", () => {
    const cwd = join(import.meta.dir, "../..");
    const help = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "--help"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    expect(help.exitCode).toBe(0);
    expect(new TextDecoder().decode(help.stdout)).toContain("verify");

    const verifyHelp = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "verify", "--help"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    const stdout = new TextDecoder().decode(verifyHelp.stdout);
    expect(verifyHelp.exitCode).toBe(0);
    expect(stdout).toContain("--no-publish");
    expect(stdout).toContain("--smoke");
    expect(stdout).toContain("--seed-smoke");
    expect(stdout).toContain("--required-smoke");
    expect(stdout).toContain("--required-live-smoke");
    expect(stdout).toContain("--seed-limit");
    expect(stdout).toContain("--external-smoke");
    expect(stdout).toContain("--concurrency");
    expect(stdout).toContain("--case-timeout-ms");
    expect(stdout).toContain("--require-full-docs");
    expect(stdout).toContain("--ai-smoke");
  });

  it("shows seed source selection and refresh options in help", () => {
    const cwd = join(import.meta.dir, "../..");
    const seedHelp = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "seed", "--help"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    const stdout = new TextDecoder().decode(seedHelp.stdout);

    expect(seedHelp.exitCode).toBe(0);
    expect(stdout).toContain("--groups");
    expect(stdout).toContain("--slugs");
    expect(stdout).toContain("--limit");
    expect(stdout).toContain("--new-only");
    expect(stdout).toContain("--open-connectors");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--embed");
  });

  it("shows live update timeout controls in help", () => {
    const cwd = join(import.meta.dir, "../..");
    const liveHelp = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "live", "--help"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    const stdout = new TextDecoder().decode(liveHelp.stdout);

    expect(liveHelp.exitCode).toBe(0);
    expect(stdout).toContain("--case-timeout-ms");
  });

  it("prints a machine-readable seed report", () => {
    const cwd = join(import.meta.dir, "../..");
    const seed = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "seed", "--groups", "llm", "--limit", "1", "--json"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    expect(seed.exitCode).toBe(0);
    const report = JSON.parse(new TextDecoder().decode(seed.stdout)) as {
      selected_count: number;
      failed_count: number;
      items: Array<{ seed_slug: string; source_type: string }>;
    };
    expect(report.selected_count).toBe(1);
    expect(report.failed_count).toBe(0);
    expect(report.items[0]?.seed_slug).toBe("vercel-ai-sdk");
    expect(report.items[0]?.source_type).toBe("llms_txt");
  });

  it("imports open-connectors packages as source seeds", () => {
    const cwd = join(import.meta.dir, "../..");
    const root = mkdtempSync(join(tmpdir(), "context-open-connectors-"));
    try {
      mkdirSync(join(root, ".connectors"), { recursive: true });
      mkdirSync(join(root, "connectors", "connect-figma"), { recursive: true });
      writeFileSync(
        join(root, ".connectors", "manifest.json"),
        JSON.stringify({ version: 1, connectors: ["figma"] })
      );
      writeFileSync(
        join(root, "connectors", "connect-figma", "package.json"),
        JSON.stringify({
          name: "@hasna/connect-figma",
          description: "Figma connector CLI",
          keywords: ["figma", "api", "connector"],
          repository: { url: "git+https://github.com/hasna/connectors.git" },
        })
      );
      writeFileSync(
        join(root, "connectors", "connect-figma", "README.md"),
        "# connect-figma\n\nUse https://www.figma.com/developers/api for API docs."
      );
      mkdirSync(join(root, "connectors", "connect-stripe"), { recursive: true });
      writeFileSync(
        join(root, "connectors", "connect-stripe", "package.json"),
        JSON.stringify({
          name: "@hasna/connect-stripe",
          description: "Stripe connector CLI",
          keywords: ["stripe", "api", "connector"],
        })
      );
      writeFileSync(
        join(root, "connectors", "connect-stripe", "README.md"),
        "# connect-stripe\n\nUse https://api.stripe.com/v1 for calls.\nconnect-stripe webhooks create --url \"https://...\""
      );

      const seed = Bun.spawnSync({
        cmd: [
          "bun",
          "src/cli/index.tsx",
          "seed",
          "--open-connectors",
          root,
          "--open-connectors-only",
          "--slugs",
          "Figma,Stripe",
          "--json",
        ],
        cwd,
        env: {
          ...process.env,
          CONTEXT_DB_PATH: ":memory:",
          HASNA_CONTEXT_DB_PATH: ":memory:",
          NO_COLOR: "1",
        },
      });
      expect(seed.exitCode).toBe(0);
      const report = JSON.parse(new TextDecoder().decode(seed.stdout)) as {
        selected_count: number;
        failed_count: number;
        items: Array<{ seed_slug: string; source_type: string; source_url: string | null }>;
      };
      expect(report.selected_count).toBe(2);
      expect(report.failed_count).toBe(0);
      expect(report.items[0]?.seed_slug).toBe("figma");
      expect(report.items[0]?.source_type).toBe("api");
      expect(report.items[0]?.source_url).toBe("https://www.figma.com/developers/api");
      expect(report.items[1]?.seed_slug).toBe("stripe");
      expect(report.items[1]?.source_type).toBe("api");
      expect(report.items[1]?.source_url).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges open-connectors duplicates into normal source seeds instead of shadowing them", () => {
    const cwd = join(import.meta.dir, "../..");
    const root = mkdtempSync(join(tmpdir(), "context-open-connectors-"));
    try {
      mkdirSync(join(root, "connectors", "connect-anthropic"), { recursive: true });
      writeFileSync(
        join(root, "connectors", "connect-anthropic", "package.json"),
        JSON.stringify({
          name: "@hasna/connect-anthropic",
          description: "Anthropic API connector CLI",
          keywords: ["anthropic", "api", "connector"],
          repository: { url: "git+https://github.com/hasna/connectors.git" },
        })
      );
      writeFileSync(
        join(root, "connectors", "connect-anthropic", "README.md"),
        "# connect-anthropic\n\nUse ANTHROPIC_API_KEY."
      );

      const seed = Bun.spawnSync({
        cmd: [
          "bun",
          "src/cli/index.tsx",
          "seed",
          "--open-connectors",
          root,
          "--slugs",
          "anthropic",
          "--json",
        ],
        cwd,
        env: {
          ...process.env,
          CONTEXT_DB_PATH: ":memory:",
          HASNA_CONTEXT_DB_PATH: ":memory:",
          NO_COLOR: "1",
        },
      });
      expect(seed.exitCode).toBe(0);
      const report = JSON.parse(new TextDecoder().decode(seed.stdout)) as {
        selected_count: number;
        failed_count: number;
        items: Array<{ seed_slug: string; source_type: string; source_url: string | null }>;
      };
      expect(report.selected_count).toBe(1);
      expect(report.failed_count).toBe(0);
      expect(report.items[0]?.seed_slug).toBe("anthropic");
      expect(report.items[0]?.source_type).toBe("api");
      expect(report.items[0]?.source_url).toBe("https://docs.anthropic.com");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid verify retriever inputs", () => {
    const cwd = join(import.meta.dir, "../..");
    const verify = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "verify", "--seed-retriever", "bogus", "--json"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    expect(verify.exitCode).toBe(1);
    expect(new TextDecoder().decode(verify.stderr)).toContain('Invalid retriever "bogus"');
  });

  it("rejects invalid add retrievers before no-crawl registration", () => {
    const cwd = join(import.meta.dir, "../..");
    const add = Bun.spawnSync({
      cmd: [
        "bun",
        "src/cli/index.tsx",
        "add",
        "Invalid No Crawl",
        "--url",
        "https://example.invalid/docs",
        "--no-crawl",
        "--retriever",
        "bogus",
      ],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        NO_COLOR: "1",
      },
    });
    expect(add.exitCode).toBe(1);
    expect(new TextDecoder().decode(add.stderr)).toContain('Invalid retriever "bogus"');
    expect(new TextDecoder().decode(add.stdout)).not.toContain("Registered");
  });

  it("rejects invalid default retriever env values for seed automation", () => {
    const cwd = join(import.meta.dir, "../..");
    const seed = Bun.spawnSync({
      cmd: ["bun", "src/cli/index.tsx", "seed", "--groups", "llm", "--limit", "1", "--json"],
      cwd,
      env: {
        ...process.env,
        CONTEXT_DB_PATH: ":memory:",
        HASNA_CONTEXT_DB_PATH: ":memory:",
        CONTEXT_RETRIEVER: "bogus",
        NO_COLOR: "1",
      },
    });
    expect(seed.exitCode).toBe(1);
    expect(new TextDecoder().decode(seed.stderr)).toContain('Invalid retriever "bogus"');
  });
});
