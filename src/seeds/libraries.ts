import { BACKEND_SEED_LIBRARIES } from "./backend.js";
import { ECOSYSTEM_SEED_LIBRARIES } from "./ecosystem.js";
import { FRONTEND_SEED_LIBRARIES } from "./frontend.js";
import type { SeedLibrary } from "./types.js";

export type { SeedLibrary } from "./types.js";

export const SEED_LIBRARIES: SeedLibrary[] = [
  ...FRONTEND_SEED_LIBRARIES,
  ...BACKEND_SEED_LIBRARIES,
  ...ECOSYSTEM_SEED_LIBRARIES,
];
