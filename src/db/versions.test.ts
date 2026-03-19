import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { createLibrary } from "./libraries.js";
import { upsertDocument } from "./documents.js";
import {
  saveDocumentVersion,
  getDocumentVersions,
  getDocumentVersionCount,
  getLatestVersion,
  pruneOldVersions,
  hashContent,
} from "./versions.js";

let documentId: string;

beforeEach(() => {
  process.env["CONTEXT_DB_PATH"] = ":memory:";
  resetDatabase();
  const lib = createLibrary({ name: "TestLib" });
  const doc = upsertDocument({ library_id: lib.id, url: "https://test.com" });
  documentId = doc.id;
});

afterEach(() => {
  resetDatabase();
});

describe("hashContent", () => {
  it("produces consistent 16-char hex hash", () => {
    const h = hashContent("hello world");
    expect(h).toHaveLength(16);
    expect(hashContent("hello world")).toBe(h);
    expect(hashContent("different")).not.toBe(h);
  });
});

describe("saveDocumentVersion", () => {
  it("saves first version as v1", () => {
    const v = saveDocumentVersion({
      document_id: documentId,
      url: "https://test.com",
      content: "Initial content of the document.",
    });
    expect(v).not.toBeNull();
    expect(v!.version_number).toBe(1);
  });

  it("saves new version when content changes", () => {
    saveDocumentVersion({
      document_id: documentId,
      url: "https://test.com",
      content: "Version one content here.",
    });
    const v2 = saveDocumentVersion({
      document_id: documentId,
      url: "https://test.com",
      content: "Version two content — different now.",
    });
    expect(v2).not.toBeNull();
    expect(v2!.version_number).toBe(2);
  });

  it("returns null when content is unchanged", () => {
    const content = "Same content every time.";
    saveDocumentVersion({ document_id: documentId, url: "https://test.com", content });
    const v2 = saveDocumentVersion({ document_id: documentId, url: "https://test.com", content });
    expect(v2).toBeNull();
  });
});

describe("getDocumentVersions", () => {
  it("returns versions in descending order", () => {
    for (let i = 0; i < 3; i++) {
      saveDocumentVersion({
        document_id: documentId,
        url: "https://test.com",
        content: `Content revision ${i} with unique text.`,
      });
    }
    const versions = getDocumentVersions(documentId);
    expect(versions).toHaveLength(3);
    expect(versions[0]!.version_number).toBe(3);
    expect(versions[2]!.version_number).toBe(1);
  });
});

describe("getDocumentVersionCount", () => {
  it("counts versions correctly", () => {
    expect(getDocumentVersionCount(documentId)).toBe(0);
    saveDocumentVersion({
      document_id: documentId,
      url: "https://test.com",
      content: "First unique content.",
    });
    expect(getDocumentVersionCount(documentId)).toBe(1);
    saveDocumentVersion({
      document_id: documentId,
      url: "https://test.com",
      content: "Second different content.",
    });
    expect(getDocumentVersionCount(documentId)).toBe(2);
  });
});

describe("getLatestVersion", () => {
  it("returns null when no versions", () => {
    expect(getLatestVersion(documentId)).toBeNull();
  });

  it("returns the highest version", () => {
    saveDocumentVersion({ document_id: documentId, url: "https://test.com", content: "First v." });
    saveDocumentVersion({ document_id: documentId, url: "https://test.com", content: "Second v." });
    const latest = getLatestVersion(documentId);
    expect(latest!.version_number).toBe(2);
  });
});

describe("pruneOldVersions", () => {
  it("keeps only N most recent versions", () => {
    for (let i = 0; i < 8; i++) {
      saveDocumentVersion({
        document_id: documentId,
        url: "https://test.com",
        content: `Revision ${i} with distinct content.`,
      });
    }
    pruneOldVersions(documentId, 3);
    const versions = getDocumentVersions(documentId);
    expect(versions).toHaveLength(3);
    expect(versions[0]!.version_number).toBe(8);
  });
});
