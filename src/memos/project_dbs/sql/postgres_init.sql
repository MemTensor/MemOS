-- 项目记忆存储：PostgreSQL + pgvector，schema project_memory
-- 幂等执行（各语句均带 IF NOT EXISTS 或存在性判断）；vector 扩展需由高权限账号预先安装（CREATE EXTENSION IF NOT EXISTS vector;）
-- 向量维度与中文分词配置两处占位符由 PostgresProjectDB 按配置替换
-- vector、zhparser（使用 zhparser 时）扩展需由高权限账号预先安装

CREATE SCHEMA IF NOT EXISTS project_memory;

-- 中文分词配置：生产为 zhparser；本地测试可配置为 simple（COPY = simple）
{text_search_config}

-- 空间
CREATE TABLE IF NOT EXISTS project_memory.spaces (
    id              TEXT PRIMARY KEY,                       -- 对外 space_id
    project_id      TEXT NOT NULL,                          -- 开发者项目归属
    space_name      TEXT NOT NULL,                          -- 空间名称，不要求唯一
    instructions    TEXT,                                   -- 项目指令，未设置为 NULL
    create_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    update_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 配置最近更新时间
    cleared_at      TIMESTAMPTZ                             -- 最近一次清空记忆的时间；受理早于它的整理任务不再写回
);
-- 按项目列出空间
CREATE INDEX IF NOT EXISTS idx_spaces_project ON project_memory.spaces (project_id);

-- 领域
CREATE TABLE IF NOT EXISTS project_memory.domains (
    id              TEXT PRIMARY KEY,                       -- 内部 domain_id
    space_id        TEXT NOT NULL,                          -- 所属空间
    domain          TEXT NOT NULL,                          -- 对外领域名称，同空间唯一
    description     TEXT NOT NULL DEFAULT '',               -- 领域说明
    create_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    update_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 最近修改时间
    FOREIGN KEY (space_id) REFERENCES project_memory.spaces (id) ON DELETE CASCADE,  -- 删除空间时级联删除领域
    UNIQUE (space_id, domain),
    UNIQUE (space_id, id)                                   -- 供主题表做同空间外键
);

-- 主题
CREATE TABLE IF NOT EXISTS project_memory.topics (
    id                  TEXT PRIMARY KEY,                       -- 主题 ID，对外 Topic ID
    space_id            TEXT NOT NULL,                          -- 所属空间
    domain_id           TEXT NOT NULL,                          -- 所属领域，须属于同一空间
    topic_name          TEXT NOT NULL,                          -- 名称
    topic_summary       TEXT NOT NULL,                          -- 摘要
    topic_description   TEXT NOT NULL,                          -- 描述
    sources             JSONB NOT NULL DEFAULT '[]'::JSONB,     -- 来源会话数组：{conversation_id, user_id, agent_id}
    extra               JSONB NOT NULL DEFAULT '{}'::JSONB,     -- 预留字段
    embedding           vector({embedding_dimension}),                           -- 主题检索向量
    create_time         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    update_time         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 最近更新时间，包含条目变化
    version             BIGINT NOT NULL DEFAULT 1,              -- 乐观锁：主题或其条目每次变更加 1
    search_tsv          TSVECTOR GENERATED ALWAYS AS (          -- 名称 + 摘要 + 描述的全文索引，数据库自动维护
        to_tsvector('project_memory.zh', topic_name || ' ' || topic_summary || ' ' || topic_description)
    ) STORED,
    -- 以下字段待算法确定
    anchors             JSONB NOT NULL DEFAULT '[]'::JSONB,     -- 关联的文件、模块、符号及证据
    anchor_keys         TEXT[] NOT NULL DEFAULT '{}',           -- 由 anchors 派生的检索键，与 anchors 同次写入
    UNIQUE (space_id, id),                                      -- 供条目表做同空间外键
    FOREIGN KEY (space_id) REFERENCES project_memory.spaces (id) ON DELETE CASCADE,  -- 删除空间时级联删除主题
    FOREIGN KEY (space_id, domain_id) REFERENCES project_memory.domains (space_id, id)  -- 领域被引用时禁止删除
);
-- 空间内按更新时间分页
CREATE INDEX IF NOT EXISTS idx_topics_space_updated ON project_memory.topics (space_id, update_time DESC, id);
-- 空间内按领域筛选、检查领域引用
CREATE INDEX IF NOT EXISTS idx_topics_space_domain  ON project_memory.topics (space_id, domain_id);
-- 主题向量召回
CREATE INDEX IF NOT EXISTS idx_topics_embedding     ON project_memory.topics USING hnsw (embedding vector_cosine_ops);
-- 主题全文召回
CREATE INDEX IF NOT EXISTS idx_topics_search_tsv    ON project_memory.topics USING gin (search_tsv);
-- 锚点召回（待算法确定）
CREATE INDEX IF NOT EXISTS idx_topics_anchor_keys   ON project_memory.topics USING gin (anchor_keys);

-- 条目：决策、经验、演变轨迹，每条一行
CREATE TABLE IF NOT EXISTS project_memory.project_entries (
    id              TEXT PRIMARY KEY,                       -- 条目 ID，可单独读取
    topic_id        TEXT NOT NULL,                          -- 所属主题
    space_id        TEXT NOT NULL,                          -- 所属空间
    entry_type      TEXT NOT NULL,                          -- 条目类型：decision / experience / timeline
    content         TEXT NOT NULL,                          -- 正文；经验为卡片拼成的 task_intent｜problem｜principle
    time            TIMESTAMPTZ NOT NULL,                   -- 发生时间，取自对应消息的 chat_time
    user_ids        TEXT[] NOT NULL DEFAULT '{}',           -- 相关成员
    history         JSONB NOT NULL DEFAULT '[]'::JSONB,     -- decision 专属：被取代的历次结论，结构见 item.py HistoryItem
    conflicts       JSONB NOT NULL DEFAULT '[]'::JSONB,     -- decision 专属：未解决的不同结论，结构见 item.py ConflictItem
    extra           JSONB NOT NULL DEFAULT '{}'::JSONB,     -- 条目类型专属字段，结构见 item.py DecisionExtra / ExperienceExtra / TimelineExtra
    embedding       vector({embedding_dimension}),                           -- 条目检索向量
    create_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    update_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 最近修改时间
    version         BIGINT NOT NULL DEFAULT 1,              -- 条目版本，每次修改加 1
    search_tsv      TSVECTOR GENERATED ALWAYS AS (          -- content 的全文索引，数据库自动维护
        to_tsvector('project_memory.zh', content)
    ) STORED,
    FOREIGN KEY (space_id, topic_id)
        REFERENCES project_memory.topics (space_id, id) ON DELETE CASCADE   -- 删除主题时级联删除条目
);
-- 按主题读取条目，并按发生时间排序
CREATE INDEX IF NOT EXISTS idx_entries_topic      ON project_memory.project_entries (topic_id, entry_type, time);
-- 空间内按类型筛选
CREATE INDEX IF NOT EXISTS idx_entries_space_type ON project_memory.project_entries (space_id, entry_type);
-- 条目向量召回
CREATE INDEX IF NOT EXISTS idx_entries_embedding  ON project_memory.project_entries USING hnsw (embedding vector_cosine_ops);
-- 条目全文召回
CREATE INDEX IF NOT EXISTS idx_entries_search_tsv ON project_memory.project_entries USING gin (search_tsv);
