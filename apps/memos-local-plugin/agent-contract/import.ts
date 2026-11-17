export interface MemoryImportBundle {
  version?: number;
  traces?: unknown[];
  policies?: unknown[];
  worldModels?: unknown[];
  skills?: unknown[];
}

export interface MemoryImportOptions {
  /** Preserve source ownership unless the caller explicitly requests migration. */
  ownership?: "preserve" | "target";
  /** Target the active agent's named profile; omitted means its active profile. */
  targetProfileId?: string;
  /** Validate and estimate visibility without writing any records. */
  dryRun?: boolean;
}

export interface MemoryImportIssue {
  kind: "trace" | "policy" | "worldModel" | "skill";
  /** Zero-based index in the corresponding bundle collection. */
  index: number;
  field?: string;
  code: string;
  message: string;
}

export interface MemoryImportResult {
  imported: number;
  /** Backwards-compatible total: duplicates + invalid + failed. */
  skipped: number;
  duplicates: number;
  invalid: number;
  failed: number;
  /** Successful (or preview candidate) rows visible to the active profile. */
  visible: number;
  hidden: number;
  dryRun: boolean;
  /** At most 50 diagnostics; never includes row text or raw database errors. */
  issues: MemoryImportIssue[];
}
