-- 项目记忆存储：PostgreSQL + pgvector，schema project_memory（按《项目记忆算法部分表结构评审》）
-- 幂等执行（各语句均带 IF NOT EXISTS 或存在性判断）
-- 扩展需由高权限账号预先安装，PostgresProjectDB 启动时检查，缺失时报错：
--   CREATE EXTENSION IF NOT EXISTS vector;       -- 向量列与 hnsw 索引
--   CREATE EXTENSION IF NOT EXISTS btree_gist;   -- episodes 区间不重叠约束
--   CREATE EXTENSION IF NOT EXISTS zhparser;     -- 使用 zhparser 分词时
-- 向量维度（规范为 1024）与中文分词配置两处占位符由 PostgresProjectDB 按配置替换
-- add_jobs 由 Add 插件的存储创建，不在本文件

CREATE SCHEMA IF NOT EXISTS project_memory;

-- 中文分词配置：生产为 zhparser；本地测试可配置为 simple（COPY = simple）
{text_search_config}

-- 空间
CREATE TABLE IF NOT EXISTS project_memory.spaces (
    id              TEXT PRIMARY KEY,                       -- 对外 space_id
    project_id      TEXT NOT NULL,                          -- 开发者项目归属
    space_name      TEXT NOT NULL,                          -- 空间名称，不要求唯一
    instructions    TEXT,                                   -- 空间整理指令，未设置为 NULL
    create_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    clear_time      TIMESTAMPTZ,                            -- 最近一次清空记忆的时间；受理早于它的整理任务不再写回
    -- Add 内部列，由 Add 插件的存储读写
    resource_bindings   JSONB NOT NULL DEFAULT '[]'::JSONB, -- 登记的代码仓库、文档来源
    last_formation_time TIMESTAMPTZ,                        -- 最近一次 Formation 的时间
    formation_version   BIGINT NOT NULL DEFAULT 0           -- Formation 的并发版本号，每做一次加 1
);
-- 按项目列出空间
CREATE INDEX IF NOT EXISTS idx_spaces_project ON project_memory.spaces (project_id);

-- 领域
CREATE TABLE IF NOT EXISTS project_memory.domains (
    id              TEXT PRIMARY KEY,                       -- 内部 domain_id
    space_id        TEXT NOT NULL,
    domain          TEXT NOT NULL,                          -- 对外领域名称
    description     TEXT NOT NULL DEFAULT '',
    create_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (space_id) REFERENCES project_memory.spaces (id) ON DELETE CASCADE,  -- 删除空间时级联删除领域
    UNIQUE (space_id, domain),
    UNIQUE (space_id, id)                                   -- 供主题表做同空间外键
);

-- 主题
CREATE TABLE IF NOT EXISTS project_memory.topics (
    id                  TEXT PRIMARY KEY,                       -- 主题 ID，存储层生成，以 topic_ 开头
    space_id            TEXT NOT NULL,                          -- 所属空间
    domain_id           TEXT NOT NULL,                          -- 所属领域，须属于同一空间
    topic_name          TEXT NOT NULL,                          -- 名称
    topic_summary       TEXT NOT NULL,                          -- 摘要
    topic_description   TEXT NOT NULL,                          -- 描述

    sources             JSONB NOT NULL DEFAULT '[]'::JSONB,     -- 来源会话数组：{conversation_id, user_id, agent_id}，只用于展示
    conversation_ids    TEXT[] NOT NULL DEFAULT '{}',           -- 由 sources 派生：非空 conversation_id，与 sources 同次写入

    extra               JSONB NOT NULL DEFAULT '{}'::JSONB,     -- 预留字段；存储层写 rank_time / rank（见 ranking.py）
    embedding           vector({embedding_dimension}),          -- 主题检索向量
    version             BIGINT NOT NULL DEFAULT 1,              -- 乐观锁：主题或其条目每次变更加 1（update_decision 只加条目版本，见 base.py）
    search_tsv          TSVECTOR GENERATED ALWAYS AS (          -- 名称 + 摘要 + 描述的全文索引，数据库自动维护
        to_tsvector('project_memory.zh', topic_name || ' ' || topic_summary || ' ' || topic_description)
    ) STORED,
    create_time         TIMESTAMPTZ NOT NULL,                   -- 第一个 Episode 第一条消息的 chat_time（会话时间）
    update_time         TIMESTAMPTZ NOT NULL,                   -- 最近一个 Episode 最后一条消息的 chat_time（会话时间）
    commit_time         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 最近一次提交的服务器时间

    anchors             JSONB NOT NULL DEFAULT '[]'::JSONB,     -- 关联的锚点，结构待算法确定【尚未对齐】
    anchor_keys         TEXT[] NOT NULL DEFAULT '{}',           -- 由 anchors 派生的检索键，与 anchors 同次写入

    UNIQUE (space_id, id),                                      -- 供条目表做同空间外键
    FOREIGN KEY (space_id) REFERENCES project_memory.spaces (id) ON DELETE CASCADE,  -- 删除空间时级联删除主题
    FOREIGN KEY (space_id, domain_id) REFERENCES project_memory.domains (space_id, id)  -- 领域被引用时禁止删除
);
-- 空间内按更新时间分页
CREATE INDEX IF NOT EXISTS idx_topics_space_updated     ON project_memory.topics (space_id, update_time DESC, id);
-- 空间内按领域筛选、检查领域引用
CREATE INDEX IF NOT EXISTS idx_topics_space_domain      ON project_memory.topics (space_id, domain_id);
-- 同会话召回、search 的 conversation_id 优先（conversation_ids @> ARRAY[:conversation_id]）
CREATE INDEX IF NOT EXISTS idx_topics_conversation_ids  ON project_memory.topics USING gin (conversation_ids);
-- 主题向量召回
CREATE INDEX IF NOT EXISTS idx_topics_embedding         ON project_memory.topics USING hnsw (embedding vector_cosine_ops);
-- 主题全文召回
CREATE INDEX IF NOT EXISTS idx_topics_search_tsv        ON project_memory.topics USING gin (search_tsv);
-- 锚点召回（待算法确定）
CREATE INDEX IF NOT EXISTS idx_topics_anchor_keys       ON project_memory.topics USING gin (anchor_keys);

-- 条目：决策、经验、演变轨迹各一行；决策的旧结论（status 1）与冲突项（status 2）为挂在所属决策下的子行
CREATE TABLE IF NOT EXISTS project_memory.project_entries (
    id                  TEXT PRIMARY KEY,                       -- 条目 ID，可单独读取
    topic_id            TEXT NOT NULL,                          -- 所属主题
    space_id            TEXT NOT NULL,                          -- 所属空间
    entry_type          TEXT NOT NULL CHECK (entry_type IN ('decision', 'experience', 'timeline')),
    status              SMALLINT NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2)),  -- 0 active / 1 archived / 2 conflict
    parent_decision_id  TEXT,                                   -- 决策的 archived、conflict 行：所属决策的 id
    content             TEXT NOT NULL,                          -- 正文；经验为卡片拼成的 task_intent｜problem｜principle
    chat_time           TIMESTAMPTZ NOT NULL,                   -- 发生时间，取自对应消息的 chat_time
    user_ids            TEXT[] NOT NULL DEFAULT '{}',           -- 相关成员
    extra               JSONB NOT NULL DEFAULT '{}'::JSONB,     -- 展示字段，结构见 item.py
    embedding           vector({embedding_dimension}),          -- 条目检索向量
    create_time         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 创建时间
    update_time         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 最近修改时间
    version             BIGINT NOT NULL DEFAULT 1,              -- 条目版本，每次修改加 1
    search_tsv          TSVECTOR GENERATED ALWAYS AS (          -- content 的全文索引，数据库自动维护
        to_tsvector('project_memory.zh', content)
    ) STORED,

    FOREIGN KEY (space_id, topic_id)
        REFERENCES project_memory.topics (space_id, id) ON DELETE CASCADE,          -- 删除主题时级联删除条目
    UNIQUE (topic_id, id),
    FOREIGN KEY (topic_id, parent_decision_id)
        REFERENCES project_memory.project_entries (topic_id, id) ON DELETE CASCADE,  -- 子行与所属决策同主题；父行须为 status = 0 的决策，由存储层保证
    CHECK (status <> 2 OR entry_type = 'decision'),                                 -- 只有决策有冲突项
    CHECK ((entry_type = 'decision' AND status <> 0) = (parent_decision_id IS NOT NULL))  -- 决策的旧结论、冲突项必须挂到所属决策
);
-- 按主题读取当前条目，并按发生时间排序
CREATE INDEX IF NOT EXISTS idx_entries_topic      ON project_memory.project_entries (topic_id, entry_type, status, chat_time);
-- 读取一条决策的旧结论与冲突项
CREATE INDEX IF NOT EXISTS idx_entries_parent     ON project_memory.project_entries (parent_decision_id, status, chat_time) WHERE parent_decision_id IS NOT NULL;
-- 空间内按类型、状态筛选
CREATE INDEX IF NOT EXISTS idx_entries_space_type ON project_memory.project_entries (space_id, entry_type, status);
-- 条目向量召回
CREATE INDEX IF NOT EXISTS idx_entries_embedding  ON project_memory.project_entries USING hnsw (embedding vector_cosine_ops);
-- 条目全文召回
CREATE INDEX IF NOT EXISTS idx_entries_search_tsv ON project_memory.project_entries USING gin (search_tsv);

-- 原文：每条消息存一份，多个 Space 共用；由 Add 插件的存储读写
CREATE TABLE IF NOT EXISTS project_memory.messages (
    project_id          TEXT NOT NULL,                          -- 租户
    conversation_key    TEXT NOT NULL,                          -- 会话 ID；没传时为 task:{task_id}
    message_id          TEXT NOT NULL,                          -- 调用方消息 ID，缺省由受理生成
    msg_seq             BIGINT NOT NULL,                        -- 会话内序号，从 1 开始，受理时分配
    role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    role_id             TEXT,                                   -- 发言成员外部 ID；user 消息没传时填调用方 user_id
    role_name           TEXT,                                   -- 发言成员显示名
    agent_id            TEXT,                                   -- 调用方 agent_id；没传为空
    content             TEXT NOT NULL,                          -- 清洗后的正文，完整保存，不截断
    tool_calls          JSONB,                                  -- 工具调用原样
    tool_call_id        TEXT,                                   -- tool 消息对应的调用 ID
    chat_time           TIMESTAMPTZ NOT NULL,                   -- 消息发生时间
    accept_time         TIMESTAMPTZ NOT NULL,                   -- 首次受理时间
    task_id             TEXT NOT NULL,                          -- 首次受理它的 Task
    experience_notes    JSONB,                                  -- Agent 当场写的经验稿，原样保存
    content_sha256      TEXT NOT NULL,                          -- 同 ID 不同内容判 MESSAGE_ID_CONFLICT
    search_tsv          TSVECTOR GENERATED ALWAYS AS (          -- content 的全文索引，数据库自动维护
        to_tsvector('project_memory.zh', content)
    ) STORED,

    PRIMARY KEY (project_id, conversation_key, message_id),
    UNIQUE (project_id, conversation_key, msg_seq)              -- 也用于按会话顺序读回、按 Episode 区间取消息
);
-- 原文全文检索
CREATE INDEX IF NOT EXISTS idx_messages_search_tsv ON project_memory.messages USING gin (search_tsv);

-- Episode：一个 Space 内同一会话一段连续消息，messages.msg_seq 的闭区间；由 Add 插件的存储读写
CREATE TABLE IF NOT EXISTS project_memory.episodes (
    id                  TEXT PRIMARY KEY,                       -- Episode ID
    space_id            TEXT NOT NULL,                          -- 所属空间
    conversation_key    TEXT NOT NULL,                          -- 同 messages
    message_seq_start   BIGINT NOT NULL,                        -- 第一条消息的 msg_seq
    message_seq_end     BIGINT NOT NULL,                        -- 最后一条消息的 msg_seq
    previous_episode_id TEXT,                                   -- reopen 方案 B：同 Space、同会话的前一个 Episode
    topic_id            TEXT,                                   -- 归入的主题；为空表示未归入
    episode_summary     TEXT,                                   -- M02 轨迹摘要
    first_chat_time     TIMESTAMPTZ NOT NULL,                   -- 第一条消息的 chat_time
    last_chat_time      TIMESTAMPTZ NOT NULL,                   -- 最后一条消息的 chat_time
    embedding           vector({embedding_dimension}),          -- 轨迹摘要向量
    search_tsv          TSVECTOR GENERATED ALWAYS AS (          -- 轨迹摘要的全文索引，数据库自动维护
        to_tsvector('project_memory.zh', COALESCE(episode_summary, ''))
    ) STORED,
    create_time         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 建行时间

    FOREIGN KEY (space_id) REFERENCES project_memory.spaces (id) ON DELETE CASCADE,    -- 删除空间时级联删除 Episode
    FOREIGN KEY (previous_episode_id) REFERENCES project_memory.episodes (id) ON DELETE SET NULL,
    FOREIGN KEY (topic_id) REFERENCES project_memory.topics (id) ON DELETE SET NULL,   -- 主题删除后 Episode 保留

    CHECK (message_seq_start <= message_seq_end),
    EXCLUDE USING gist (                                        -- 同 Space、同会话区间不重叠
        space_id WITH =, conversation_key WITH =,
        int8range(message_seq_start, message_seq_end, '[]') WITH &&
    )
);
-- reopen：取同 Space、同会话最近的前一个 Episode
CREATE INDEX IF NOT EXISTS idx_episodes_conversation ON project_memory.episodes (space_id, conversation_key, create_time DESC);
-- 按主题列出归入的 Episode
CREATE INDEX IF NOT EXISTS idx_episodes_topic        ON project_memory.episodes (topic_id);
-- 摘要全文检索
CREATE INDEX IF NOT EXISTS idx_episodes_search_tsv   ON project_memory.episodes USING gin (search_tsv);
-- 摘要向量检索
CREATE INDEX IF NOT EXISTS idx_episodes_embedding    ON project_memory.episodes USING hnsw (embedding vector_cosine_ops);
