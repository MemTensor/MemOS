-- Apply after the space service has installed memos_project.pm_spaces and pm_domains.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memos_project.pm_retrieval_roots (
    tenant_id text NOT NULL,
    space_id text NOT NULL REFERENCES memos_project.pm_spaces(space_id) ON DELETE CASCADE,
    root_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 0),
    accepted_at timestamptz NOT NULL,
    immutable boolean NOT NULL,
    PRIMARY KEY (tenant_id, space_id, root_id)
);

-- A topic header and its entries share a root. A shared turn has one row per excerpt.
CREATE TABLE memos_project.pm_retrieval_items (
    tenant_id text NOT NULL,
    space_id text NOT NULL,
    root_id text NOT NULL,
    id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('topic','decision','experience','timeline','trajectory')),
    part integer NOT NULL,
    position integer NOT NULL,
    domains text[] NOT NULL,
    conversations text[] NOT NULL,
    payload jsonb NOT NULL,
    keywords tsvector NOT NULL,
    embedding vector,
    embedding_model text,
    PRIMARY KEY (tenant_id, space_id, id, part),
    FOREIGN KEY (tenant_id, space_id, root_id)
        REFERENCES memos_project.pm_retrieval_roots ON DELETE CASCADE
);
CREATE INDEX pm_retrieval_root_idx ON memos_project.pm_retrieval_items(tenant_id,space_id,root_id);
CREATE INDEX pm_retrieval_fts_idx ON memos_project.pm_retrieval_items USING gin(keywords);

CREATE TABLE memos_project.pm_retrieval_log (
    tenant_id text NOT NULL,
    space_id text NOT NULL REFERENCES memos_project.pm_spaces(space_id) ON DELETE CASCADE,
    conversation_id text NOT NULL,
    topic_id text NOT NULL,
    decision_ids text[] NOT NULL,
    conflicting_decision_ids text[] NOT NULL,
    recalled_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON memos_project.pm_retrieval_log(tenant_id,space_id,conversation_id,recalled_at);
