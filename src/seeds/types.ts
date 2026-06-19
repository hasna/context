import type { LibrarySourceType } from "../types/index.js";

export interface SeedLibrary {
  name: string;
  slug: string;
  description: string;
  npm_package?: string;
  github_repo?: string;
  docs_url?: string;
  version?: string;
  source_type?: LibrarySourceType | string;
  source_url?: string;
  freshness_days?: number;
  priority?: number;
  tags: string[];
  links?: Array<{ type: string; url: string; label?: string }>;
}
