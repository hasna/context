import type { EntityType, Visibility } from "../db/repositories.js";

export interface ParsedEntity {
  name: string;
  type: EntityType;
  signature: string;
  start_line: number;
  end_line: number;
  visibility: Visibility;
  metadata: Record<string, unknown>;
}

export interface ParsedFile {
  path: string;
  name: string;
  extension: string;
  content: string;
  entities: ParsedEntity[];
  imports: string[];
  exports: string[];
}

export interface ImportStatement {
  path: string;
  imported: string[];
  is_default: boolean;
  is_namespace: boolean;
  line: number;
}
