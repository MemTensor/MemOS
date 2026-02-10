-- =============================================================================
-- PolarDB Apache AGE Compatibility Check Script
-- =============================================================================
-- Run this script to verify your Apache AGE version and test compatibility
--
-- Usage:
--   psql -U postgres -d your_database -f pr1-migration-script.sql
-- =============================================================================

\echo '======================================================================'
\echo 'PolarDB Apache AGE Compatibility Check'
\echo '======================================================================'
\echo ''

-- Check Apache AGE version
\echo 'Checking Apache AGE version...'
SELECT extversion AS age_version
FROM pg_extension
WHERE extname = 'age';

\echo ''
\echo 'Checking PostgreSQL version...'
SELECT version();

\echo ''
\echo '======================================================================'
\echo 'Testing agtype_access_operator compatibility'
\echo '======================================================================'

-- Create temporary test table
DROP TABLE IF EXISTS temp_age_test;
CREATE TEMP TABLE temp_age_test (
    id TEXT PRIMARY KEY,
    properties JSONB
);

-- Insert test data
INSERT INTO temp_age_test (id, properties) VALUES
    ('test_1', '{"memory_type": "memo", "user_name": "alice", "content": "Hello"}'),
    ('test_2', '{"memory_type": "episode", "user_name": "bob", "content": "World"}');

\echo ''
\echo 'Test 1: OLD syntax (will FAIL on AGE 1.5+)'
\echo 'Query: agtype_access_operator(properties, ...)'

SELECT COUNT(*) AS test1_result FROM (
    SELECT *
    FROM temp_age_test
    WHERE ag_catalog.agtype_access_operator(properties, '"memory_type"'::agtype) = '"memo"'::agtype
) AS subquery;

\echo ''
\echo 'Test 2: NEW syntax (will WORK on all AGE versions)'
\echo 'Query: agtype_access_operator(properties::text::agtype, ...)'

SELECT COUNT(*) AS test2_result FROM (
    SELECT *
    FROM temp_age_test
    WHERE ag_catalog.agtype_access_operator(properties::text::agtype, '"memory_type"'::agtype) = '"memo"'::agtype
) AS subquery;

\echo ''
\echo '======================================================================'
\echo 'Compatibility Test Results'
\echo '======================================================================'
\echo 'If Test 1 failed with type error: YOU NEED THIS PR'
\echo 'If Test 2 succeeded: This PR will fix your issues'
\echo ''
\echo 'Expected results:'
\echo '  AGE 1.4.x: Both tests succeed'
\echo '  AGE 1.5.0+: Test 1 fails, Test 2 succeeds'
\echo '======================================================================'

-- Cleanup
DROP TABLE IF EXISTS temp_age_test;
