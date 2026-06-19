import { describe, expect, it } from "bun:test";
import {
  getDocumentationSource,
  inferSourceMetadata,
  listDocumentationSources,
  normalizeSourceType,
} from "./index.js";

describe("documentation sources", () => {
  it("normalizes source type aliases", () => {
    expect(normalizeSourceType("llms.txt")).toBe("llms_txt");
    expect(normalizeSourceType("open-api")).toBe("openapi");
    expect(normalizeSourceType("repo")).toBe("github");
    expect(() => normalizeSourceType("unknown")).toThrow("Unknown documentation source type");
  });

  it("lists sources with refresh defaults", () => {
    const sources = listDocumentationSources();
    expect(sources.some((source) => source.id === "openapi")).toBe(true);
    expect(getDocumentationSource("docs").origin).toBe("web");
    expect(getDocumentationSource("openapi").origin).toBe("api_spec");
    expect(getDocumentationSource("npm").defaultFreshnessDays).toBe(1);
  });

  it("infers OpenAPI and llms.txt sources from URLs", () => {
    expect(
      inferSourceMetadata({
        name: "Example API",
        docs_url: "https://example.com/openapi.json",
      }).source_type
    ).toBe("openapi");

    expect(
      inferSourceMetadata({
        name: "AI Docs",
        source_url: "https://example.com/llms.txt",
      }).source_type
    ).toBe("llms_txt");
  });

  it("infers package and repository source URLs", () => {
    expect(
      inferSourceMetadata({ name: "React", github_repo: "facebook/react" }).source_url
    ).toBe("https://github.com/facebook/react");

    expect(
      inferSourceMetadata({ name: "AI SDK OpenAI", npm_package: "@ai-sdk/openai" }).source_url
    ).toBe("https://www.npmjs.com/package/%40ai-sdk%2Fopenai");
  });

  it("rejects invalid docs and source URLs at the shared source boundary", () => {
    expect(() =>
      inferSourceMetadata({ name: "Bad Docs URL", docs_url: "not-a-url" })
    ).toThrow('Invalid docs_url "not-a-url"');

    expect(() =>
      inferSourceMetadata({ name: "Bad Source URL", source_url: "not-a-url", source_type: "docs" })
    ).toThrow('Invalid source_url "not-a-url"');
  });

  it("allows GitHub repo shorthand source URLs for repository sources", () => {
    expect(
      inferSourceMetadata({
        name: "Verify Repo",
        source_type: "github",
        source_url: "verify/local-github",
      }).source_url
    ).toBe("verify/local-github");
  });
});
