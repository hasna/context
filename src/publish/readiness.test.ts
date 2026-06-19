import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { buildPublishReadinessReport, getPublishReadinessReport } from "./readiness.js";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `context-publish-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildPublishReadinessReport", () => {
  it("uses the installed context package root instead of the caller cwd by default", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "caller-project",
      version: "1.0.0",
    }));

    const oldCwd = process.cwd();
    process.chdir(root);
    try {
      const report = await getPublishReadinessReport();
      expect(report.package.name).toBe("@hasna/context");
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("reports a built package as publish-ready when version is newer than registry", () => {
    writePackageJson("0.1.13");
    writeRequiredFiles();

    const report = buildPublishReadinessReport(root, readTestPackage("0.1.13"), "0.1.12");

    expect(report.ready).toBe(true);
    expect(report.checks.has_required_bins).toBe(true);
    expect(report.checks.has_required_exports).toBe(true);
    expect(report.checks.has_declaration_build_step).toBe(true);
    expect(report.checks.has_fresh_dist).toBe(true);
    expect(report.checks.package_version_newer_than_registry).toBe(true);
    expect(report.issues.some((issue) => issue.severity === "error")).toBe(false);
  });

  it("blocks publishing when dist is older than source files", () => {
    writePackageJson("0.1.13");
    writeRequiredFiles();
    const sourcePath = join(root, "src/cli/index.tsx");
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export {};\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(sourcePath, future, future);

    const report = buildPublishReadinessReport(root, readTestPackage("0.1.13"), "0.1.12");

    expect(report.ready).toBe(false);
    expect(report.checks.has_fresh_dist).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("stale_dist");
  });

  it("blocks publishing when local version is not newer than registry latest", () => {
    writePackageJson("0.1.13");
    writeRequiredFiles();

    const report = buildPublishReadinessReport(root, readTestPackage("0.1.13"), "0.1.13");

    expect(report.ready).toBe(false);
    expect(report.checks.package_version_newer_than_registry).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("version_not_publishable");
  });

  it("reports missing dist artifacts", () => {
    writePackageJson("0.1.13");
    writeFileSync(join(root, "README.md"), "# README");
    writeFileSync(join(root, "LICENSE"), "license");

    const report = buildPublishReadinessReport(root, readTestPackage("0.1.13"), "0.1.12");

    expect(report.ready).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("missing_package_files");
    expect(report.issues.map((issue) => issue.code)).toContain("missing_bins");
    expect(report.issues.map((issue) => issue.code)).toContain("missing_exports");
  });

  it("blocks publishing when declaration emit is masked in the build script", () => {
    writePackageJson("0.1.13", "bun run clean && bun build && (tsc --emitDeclarationOnly --outDir dist || true)");
    writeRequiredFiles();

    const report = buildPublishReadinessReport(root, readTestPackage("0.1.13", "bun run clean && bun build && (tsc --emitDeclarationOnly --outDir dist || true)"), "0.1.12");

    expect(report.ready).toBe(false);
    expect(report.checks.has_declaration_build_step).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("declaration_build_not_enforced");
  });
});

function writePackageJson(version: string, build = "bun run clean && bun build && tsc --emitDeclarationOnly --outDir dist"): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(readTestPackage(version, build), null, 2)
  );
}

function readTestPackage(version: string, build = "bun run clean && bun build && tsc --emitDeclarationOnly --outDir dist") {
  return {
    name: "@hasna/context",
    version,
    main: "dist/index.js",
    types: "dist/index.d.ts",
    bin: {
      context: "dist/cli/index.js",
      "context-mcp": "dist/mcp/index.js",
      "context-serve": "dist/server/index.js",
    },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./storage": {
        types: "./dist/storage.d.ts",
        import: "./dist/storage.js",
      },
    },
    files: ["dist", "LICENSE", "README.md"],
    scripts: {
      build,
      typecheck: "tsc --noEmit",
      test: "bun test",
      prepublishOnly: "bun run build",
    },
    publishConfig: {
      registry: "https://registry.npmjs.org",
      access: "public",
    },
  };
}

function writeRequiredFiles(): void {
  const files = [
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/storage.js",
    "dist/storage.d.ts",
    "dist/cli/index.js",
    "dist/mcp/index.js",
    "dist/server/index.js",
  ];

  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.includes(".d.ts") ? "export {};" : "#!/usr/bin/env bun\n");
    if (file.endsWith(".js")) chmodSync(path, 0o755);
  }
}
