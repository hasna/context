import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export type PublishReadinessSeverity = "info" | "warning" | "error";

export interface PublishReadinessIssue {
  code: string;
  severity: PublishReadinessSeverity;
  message: string;
}

export interface PublishReadinessFile {
  path: string;
  exists: boolean;
  size_bytes: number | null;
  executable: boolean | null;
}

export interface PublishReadinessReport {
  generated_at: string;
  package: {
    name: string;
    version: string;
    registry: string | null;
    access: string | null;
    latest_registry_version: string | null;
    version_is_publishable: boolean | null;
  };
  files: PublishReadinessFile[];
  checks: {
    has_required_scripts: boolean;
    has_required_files: boolean;
    has_required_bins: boolean;
    has_required_exports: boolean;
    has_declaration_build_step: boolean;
    has_public_publish_config: boolean;
    has_fresh_dist: boolean;
    package_version_newer_than_registry: boolean | null;
  };
  issues: PublishReadinessIssue[];
  ready: boolean;
}

export interface PublishReadinessOptions {
  rootDir?: string;
  includeRegistry?: boolean;
  registryLatestVersion?: string | null;
}

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, string>;
  publishConfig?: {
    registry?: string;
    access?: string;
  };
}

const REQUIRED_SCRIPTS = ["build", "typecheck", "test", "prepublishOnly"];
const REQUIRED_PACKAGE_FILES = ["dist", "README.md", "LICENSE"];
const REQUIRED_BINS = {
  context: "dist/cli/index.js",
  "context-mcp": "dist/mcp/index.js",
  "context-serve": "dist/server/index.js",
};
const REQUIRED_EXPORT_PATHS = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/storage.js",
  "dist/storage.d.ts",
];
const PACKAGE_NAME = "@hasna/context";

export async function getPublishReadinessReport(
  options: PublishReadinessOptions = {}
): Promise<PublishReadinessReport> {
  const rootDir = options.rootDir ?? resolvePackageRootDir();
  const pkg = readPackageJson(rootDir);
  const latestRegistryVersion = options.registryLatestVersion !== undefined
    ? options.registryLatestVersion
    : options.includeRegistry
      ? await fetchLatestRegistryVersion(pkg)
      : null;

  return buildPublishReadinessReport(rootDir, pkg, latestRegistryVersion);
}

export function resolvePackageRootDir(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let current = startDir;
  while (true) {
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
        if (pkg.name === PACKAGE_NAME) return current;
      } catch {
        // Keep walking; publish readiness should not trust unrelated package files.
      }
    }

    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function buildPublishReadinessReport(
  rootDir: string,
  pkg: PackageJson,
  latestRegistryVersion: string | null = null
): PublishReadinessReport {
  const issues: PublishReadinessIssue[] = [];
  const filePaths = unique([
    "package.json",
    ...REQUIRED_PACKAGE_FILES,
    pkg.main,
    pkg.types,
    ...Object.values(pkg.bin ?? {}),
    ...REQUIRED_EXPORT_PATHS,
  ].filter(Boolean) as string[]);
  const files = filePaths.map((path) => inspectFile(rootDir, path));

  const hasRequiredScripts = REQUIRED_SCRIPTS.every((script) => Boolean(pkg.scripts?.[script]));
  const hasRequiredFiles = REQUIRED_PACKAGE_FILES.every((file) => pkg.files?.includes(file) && existsSync(join(rootDir, file)));
  const hasRequiredBins = Object.entries(REQUIRED_BINS).every(([name, path]) =>
    pkg.bin?.[name] === path && isExistingFile(rootDir, path)
  );
  const hasRequiredExports = hasMainExports(pkg) && REQUIRED_EXPORT_PATHS.every((path) => isExistingFile(rootDir, path));
  const hasDeclarationBuildStep = hasBlockingDeclarationBuildStep(pkg);
  const hasPublicPublishConfig = pkg.publishConfig?.registry === "https://registry.npmjs.org" &&
    pkg.publishConfig.access === "public";
  const distFreshness = getDistFreshness(rootDir, pkg);
  const hasFreshDist = distFreshness.fresh;
  const packageVersionNewerThanRegistry = latestRegistryVersion
    ? compareSemver(pkg.version ?? "0.0.0", latestRegistryVersion) > 0
    : null;

  if (!pkg.name) {
    issues.push(error("missing_package_name", "package.json is missing a package name."));
  }
  if (!pkg.version) {
    issues.push(error("missing_package_version", "package.json is missing a version."));
  }
  if (!hasRequiredScripts) {
    issues.push(error("missing_scripts", `package.json must define scripts: ${REQUIRED_SCRIPTS.join(", ")}.`));
  }
  if (!hasRequiredFiles) {
    issues.push(error("missing_package_files", "package files must include dist, README.md, and LICENSE, and those paths must exist."));
  }
  if (!hasRequiredBins) {
    issues.push(error("missing_bins", "package bin entries for context, context-mcp, and context-serve must point to built dist files."));
  }
  if (!hasRequiredExports) {
    issues.push(error("missing_exports", "package exports/main/types must point to built dist entrypoints."));
  }
  if (!hasDeclarationBuildStep) {
    issues.push(error(
      "declaration_build_not_enforced",
      "Build script must run TypeScript declaration emit as a blocking step before publishing."
    ));
  }
  if (!hasPublicPublishConfig) {
    issues.push(error("publish_config", "publishConfig must target the public npm registry with public access."));
  }
  if (!hasFreshDist && distFreshness.source && distFreshness.output) {
    issues.push(error(
      "stale_dist",
      `Built dist is older than source file ${distFreshness.source.path}; run bun run build before publishing.`
    ));
  }
  for (const file of files) {
    if (!file.exists) issues.push(error("missing_file", `Required publish file is missing: ${file.path}.`));
  }
  for (const path of Object.values(REQUIRED_BINS)) {
    const file = files.find((item) => item.path === path);
    if (file?.exists && file.executable === false) {
      issues.push(error("bin_not_executable", `Binary file is not executable: ${path}.`));
    }
  }
  if (latestRegistryVersion && packageVersionNewerThanRegistry === false) {
    issues.push(error(
      "version_not_publishable",
      `Local version ${pkg.version ?? "(missing)"} is not newer than npm latest ${latestRegistryVersion}.`
    ));
  }
  if (!latestRegistryVersion) {
    issues.push({
      code: "registry_not_checked",
      severity: "info",
      message: "Registry version was not checked. Run with registry lookup before publishing.",
    });
  }

  const ready = !issues.some((issue) => issue.severity === "error");
  return {
    generated_at: new Date().toISOString(),
    package: {
      name: pkg.name ?? "",
      version: pkg.version ?? "",
      registry: pkg.publishConfig?.registry ?? null,
      access: pkg.publishConfig?.access ?? null,
      latest_registry_version: latestRegistryVersion,
      version_is_publishable: packageVersionNewerThanRegistry,
    },
    files,
    checks: {
      has_required_scripts: hasRequiredScripts,
      has_required_files: hasRequiredFiles,
      has_required_bins: hasRequiredBins,
      has_required_exports: hasRequiredExports,
      has_declaration_build_step: hasDeclarationBuildStep,
      has_public_publish_config: hasPublicPublishConfig,
      has_fresh_dist: hasFreshDist,
      package_version_newer_than_registry: packageVersionNewerThanRegistry,
    },
    issues,
    ready,
  };
}

async function fetchLatestRegistryVersion(pkg: PackageJson): Promise<string | null> {
  if (!pkg.name) return null;
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace("%2F", "%2f")}/latest`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const json = await response.json() as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

function readPackageJson(rootDir: string): PackageJson {
  return JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageJson;
}

function inspectFile(rootDir: string, path: string): PublishReadinessFile {
  const absolutePath = join(rootDir, path);
  if (!existsSync(absolutePath)) {
    return { path, exists: false, size_bytes: null, executable: null };
  }
  const stats = statSync(absolutePath);
  return {
    path,
    exists: true,
    size_bytes: stats.isFile() ? stats.size : 0,
    executable: stats.isFile() ? Boolean(stats.mode & 0o111) : null,
  };
}

function isExistingFile(rootDir: string, path: string): boolean {
  try {
    return statSync(join(rootDir, path)).isFile();
  } catch {
    return false;
  }
}

function hasMainExports(pkg: PackageJson): boolean {
  if (pkg.main !== "dist/index.js" || pkg.types !== "dist/index.d.ts") return false;
  const rootExport = pkg.exports?.["."] as { import?: string; types?: string } | undefined;
  const storageExport = pkg.exports?.["./storage"] as { import?: string; types?: string } | undefined;
  return rootExport?.import === "./dist/index.js" &&
    rootExport.types === "./dist/index.d.ts" &&
    storageExport?.import === "./dist/storage.js" &&
    storageExport.types === "./dist/storage.d.ts";
}

function hasBlockingDeclarationBuildStep(pkg: PackageJson): boolean {
  const build = pkg.scripts?.build;
  if (!build) return false;
  if (!/\btsc\b[^&|;]*--emitDeclarationOnly\b/.test(build)) return false;
  return !/\btsc\b[^&|;]*--emitDeclarationOnly\b[^&;]*(\|\|\s*true|\|\|)/.test(build);
}

interface MtimeFile {
  path: string;
  mtimeMs: number;
}

function getDistFreshness(
  rootDir: string,
  pkg: PackageJson
): { fresh: boolean; source: MtimeFile | null; output: MtimeFile | null } {
  const source = latestSourceFile(rootDir);
  if (!source) return { fresh: true, source: null, output: null };

  const outputs = unique([
    pkg.main,
    pkg.types,
    ...Object.values(pkg.bin ?? {}),
    ...REQUIRED_EXPORT_PATHS,
  ].filter(Boolean) as string[])
    .map((path) => statMtime(rootDir, path))
    .filter((file): file is MtimeFile => Boolean(file));

  if (outputs.length === 0) return { fresh: false, source, output: null };

  const output = outputs.reduce((oldest, file) => file.mtimeMs < oldest.mtimeMs ? file : oldest);
  return {
    fresh: output.mtimeMs >= source.mtimeMs,
    source,
    output,
  };
}

function latestSourceFile(rootDir: string): MtimeFile | null {
  const srcRoot = join(rootDir, "src");
  if (!existsSync(srcRoot)) return null;

  const files: MtimeFile[] = [];
  collectSourceFiles(rootDir, "src", files);
  if (files.length === 0) return null;
  return files.reduce((latest, file) => file.mtimeMs > latest.mtimeMs ? file : latest);
}

function collectSourceFiles(rootDir: string, relativeDir: string, files: MtimeFile[]): void {
  const absoluteDir = join(rootDir, relativeDir);
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(rootDir, relativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const stat = statSync(join(rootDir, relativePath));
    files.push({ path: relativePath, mtimeMs: stat.mtimeMs });
  }
}

function statMtime(rootDir: string, path: string): MtimeFile | null {
  try {
    return { path, mtimeMs: statSync(join(rootDir, path)).mtimeMs };
  } catch {
    return null;
  }
}

function compareSemver(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return 1;
    if (a[i]! < b[i]!) return -1;
  }
  return 0;
}

function parseVersion(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.replace(/^[^\d]*/, "").split(".");
  return [toInt(major), toInt(minor), toInt(patch)];
}

function toInt(value: string): number {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function error(code: string, message: string): PublishReadinessIssue {
  return { code, severity: "error", message };
}
