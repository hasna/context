# @hasna/context

Self-hosted documentation context server for AI coding agents — crawl, index, and query library docs via MCP + CLI + HTTP

[![npm](https://img.shields.io/npm/v/@hasna/context)](https://www.npmjs.com/package/@hasna/context)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/context
```

## CLI Usage

```bash
context --help
```

## MCP Server

```bash
context-mcp
```

12 tools available.

## REST API

```bash
context-serve
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service context
cloud sync pull --service context
```

## Data Directory

Data is stored in `~/.hasna/context/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
