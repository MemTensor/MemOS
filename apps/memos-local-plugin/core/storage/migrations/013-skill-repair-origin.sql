-- Repair-candidate skills: minted from a constructive negative (a failure whose
-- feedback named a corrective fix), unproven until trials validate them.
--   repair_origin = 1  → unvalidated repair; uses the stricter promotion bar.
--   strict_trial  = 1  → trials judge pass by full credit only (verifier origin),
--                        not the loose r_task >= 0.5 threshold.
ALTER TABLE skills ADD COLUMN repair_origin INTEGER NOT NULL DEFAULT 0 CHECK (repair_origin IN (0,1));
ALTER TABLE skills ADD COLUMN strict_trial INTEGER NOT NULL DEFAULT 0 CHECK (strict_trial IN (0,1));
