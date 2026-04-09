export interface SeedLibrary {
  name: string;
  slug: string;
  description: string;
  npm_package?: string;
  github_repo?: string;
  docs_url?: string;
  tags: string[];
  links?: Array<{ type: string; url: string; label?: string }>;
}
