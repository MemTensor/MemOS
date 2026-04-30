-- Lease fields for multi-process-safe embedding retry claims.

ALTER TABLE embedding_retry_queue ADD COLUMN claimed_by TEXT;
ALTER TABLE embedding_retry_queue ADD COLUMN lease_until INTEGER;
