/**
 * Shared string constants for episode recovery reasons.
 *
 * Both `memory-core.ts` (which sets recoveryReason) and `capture.ts`
 * (which checks it) import from here so a rename can't silently
 * break the orphan-skip guard.
 */
export const RECOVERY_REASONS = {
  DIRTY_REWARD_RESCORE: "dirty_reward_rescore",
} as const;

export type RecoveryReason = (typeof RECOVERY_REASONS)[keyof typeof RECOVERY_REASONS];
