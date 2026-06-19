import type { Command } from "commander";
import chalk from "chalk";
import { getPublishReadinessReport } from "../publish/readiness.js";

export function registerPublishCommands(program: Command): void {
  program
    .command("publish-check")
    .description("Audit package readiness before publishing to npm")
    .option("--registry", "Check the current latest npm registry version")
    .option("--latest <version>", "Use a supplied latest registry version instead of network lookup")
    .option("--json", "Output JSON")
    .action(async (opts: { registry?: boolean; latest?: string; json?: boolean }) => {
      const report = await getPublishReadinessReport({
        includeRegistry: opts.registry,
        registryLatestVersion: opts.latest,
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (!report.ready) process.exitCode = 1;
        return;
      }

      const status = report.ready ? chalk.green("ready") : chalk.red("not ready");
      console.log(chalk.bold("\nPublish Readiness\n"));
      console.log(`  Package:   ${report.package.name}@${report.package.version}`);
      console.log(`  Registry:  ${report.package.registry ?? "(none)"}`);
      if (report.package.latest_registry_version) {
        console.log(`  npm latest: ${report.package.latest_registry_version}`);
      }
      console.log(`  Status:    ${status}`);

      console.log(chalk.bold("\nChecks"));
      console.log(`  scripts:        ${formatCheck(report.checks.has_required_scripts)}`);
      console.log(`  files:          ${formatCheck(report.checks.has_required_files)}`);
      console.log(`  bins:           ${formatCheck(report.checks.has_required_bins)}`);
      console.log(`  exports:        ${formatCheck(report.checks.has_required_exports)}`);
      console.log(`  declarations:   ${formatCheck(report.checks.has_declaration_build_step)}`);
      console.log(`  publish config: ${formatCheck(report.checks.has_public_publish_config)}`);
      if (report.checks.package_version_newer_than_registry !== null) {
        console.log(`  version:        ${formatCheck(report.checks.package_version_newer_than_registry)}`);
      }

      if (report.issues.length > 0) {
        console.log(chalk.bold("\nIssues"));
        for (const issue of report.issues) {
          const color = issue.severity === "error" ? chalk.red : issue.severity === "warning" ? chalk.yellow : chalk.gray;
          console.log(color(`  ${issue.severity}: ${issue.message}`));
        }
      }
      console.log();

      if (!report.ready) process.exitCode = 1;
    });
}

function formatCheck(value: boolean): string {
  return value ? chalk.green("ok") : chalk.red("fail");
}
