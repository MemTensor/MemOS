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

-- 5. 原文：每条消息存一份，多个 Space 共用
CREATE TABLE IF NOT EXISTS project_memory.messages (
  project_id       text NOT NULL,
  conversation_key text NOT NULL,                                     -- 有会话 ID 时等于它；没有时为 task:{task_id}
  message_id       text NOT NULL,                                     -- 调用方 id；缺省由算法生成
  conversation_id  text,                                              -- 对外会话 ID，未传为 NULL
  turn_id          text NOT NULL,                                     -- 所在 Turn：Turn 第一条消息的 message_id
  turn_seq         bigint NOT NULL,                                   -- Turn 在会话内的受理顺序
  msg_seq          int    NOT NULL,                                   -- 消息在 Turn 内的顺序
  role             text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  role_id          text,
  role_name        text,
  content          text NOT NULL,                                     -- 清洗后的正文，完整保存，不截断
  tool_calls       jsonb,
  tool_call_id     text,
  experience_notes jsonb,
  chat_time        timestamptz NOT NULL,
  accepted_at      timestamptz NOT NULL,
  task_id          text NOT NULL,                                     -- 首次受理它的 Task
  user_id          text NOT NULL,                                     -- 调用主体
  agent_id         jsonb,                                             -- 字符串或数组，原样
  content_sha256   text NOT NULL,                                     -- 同 ID 不同内容判 MESSAGE_ID_CONFLICT
  PRIMARY KEY (project_id, conversation_key, message_id)
);
CREATE INDEX IF NOT EXISTS messages_turn_idx ON project_memory.messages (project_id, conversation_key, turn_seq, msg_seq);

-- 6. Episode：一个 Space 内同一会话连续 Turn 的积累、抽取、归类、提交；也承载 Default Topic 暂存
CREATE TABLE IF NOT EXISTS project_memory.episodes (
  id                  text PRIMARY KEY,
  space_id            text NOT NULL REFERENCES project_memory.spaces (id) ON DELETE CASCADE,
  project_id          text NOT NULL,
  conversation_key    text NOT NULL,
  conversation_id     text,
  user_id             text NOT NULL,                                  -- 第一个 Turn 的调用方；Stream 键用
  domains             text[] NOT NULL,                                -- 本段候选领域
  previous_episode_id text REFERENCES project_memory.episodes (id),                       -- reopen B：同 Space、同会话的前一段
  -- 积累与关闭
  state               text NOT NULL CHECK (state IN ('open','closed','extracting','extracted')),
  close_reason        text CHECK (close_reason IN ('task_boundary','idle','turn_count','max_wait','volume','no_conversation')),
  opened_at           timestamptz NOT NULL,
  last_turn_at        timestamptz NOT NULL,
  idle_due_at         timestamptz,
  max_wait_due_at     timestamptz,
  closed_at           timestamptz,
  dispatched_at       timestamptz,                                    -- project_add_process 投递成功
  suspected_boundary_turn_ids text[] NOT NULL DEFAULT '{}',
  -- M02 抽取结果
  extract_status      text CHECK (extract_status IN ('drafted','skipped','failed')),
  episode_summary     text,
  drafts              jsonb NOT NULL DEFAULT '[]',                    -- 各带 origin_task_id 与证据引用
  anchors             jsonb NOT NULL DEFAULT '[]',                    -- 本段的锚点观察与解析结果
  anchor_keys         text[] NOT NULL DEFAULT '{}',
  extracted_at        timestamptz,
  -- 归类与提交
  stage               text NOT NULL CHECK (stage IN ('episode_open','extracting','organizing_queued','organizing',
                                                     'awaiting_merge','committing','retry_wait','done')),
  attempt             int  NOT NULL DEFAULT 0,
  organize_result     jsonb,                                          -- 等 M05 期间的归类结果、基线 version
  commit_key          text UNIQUE,                                    -- {episode_id}:{attempt}，只在提交事务里写
  outcome             text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','committed','staged','skipped','failed')),
  result              jsonb,                                          -- 提交回执（含 topic_ids），与 commit_key 同事务
  created_topic_ids   text[] NOT NULL DEFAULT '{}',
  next_retry_at       timestamptz,
  error               jsonb,
  last_error          jsonb,
  warnings            jsonb NOT NULL DEFAULT '[]',
  -- Default Topic 暂存（outcome = staged 时）
  staged_status       text CHECK (staged_status IN ('active','moved','archived','long_unassigned')),
  staged_domain_id    text,
  staged_reason       text,
  staged_at           timestamptz,
  staged_attempts     int  NOT NULL DEFAULT 0,
  moved_to_topic_id   text,
  staged_tsv          tsvector,                                       -- episode_summary；不含 Draft 正文
  staged_embedding    vector({embedding_dimension}),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, id),
  FOREIGN KEY (space_id, staged_domain_id) REFERENCES project_memory.domains (space_id, id),
  CHECK ((state = 'open') = (closed_at IS NULL)),
  CHECK ((staged_status = 'moved') = (moved_to_topic_id IS NOT NULL)),
  CHECK ((staged_status IS NULL) = (staged_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS episodes_one_open        ON project_memory.episodes (space_id, conversation_key) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS episodes_previous_idx           ON project_memory.episodes (space_id, conversation_key, closed_at DESC) WHERE state <> 'open';
CREATE INDEX IF NOT EXISTS episodes_due_idx                ON project_memory.episodes (LEAST(idle_due_at, max_wait_due_at)) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS episodes_undispatched_idx       ON project_memory.episodes (dispatched_at NULLS FIRST) WHERE state = 'closed';
CREATE INDEX IF NOT EXISTS episodes_retry_idx              ON project_memory.episodes (next_retry_at) WHERE stage = 'retry_wait';
CREATE INDEX IF NOT EXISTS episodes_merge_wait_idx         ON project_memory.episodes (updated_at) WHERE stage = 'awaiting_merge';
CREATE INDEX IF NOT EXISTS episodes_staged_active_idx      ON project_memory.episodes (space_id, staged_at DESC) WHERE staged_status = 'active';
CREATE INDEX IF NOT EXISTS episodes_staged_fts_idx         ON project_memory.episodes USING gin (staged_tsv) WHERE staged_status = 'active';
CREATE INDEX IF NOT EXISTS episodes_staged_embedding_idx   ON project_memory.episodes USING hnsw (staged_embedding vector_cosine_ops) WHERE staged_status = 'active';
CREATE INDEX IF NOT EXISTS episodes_anchor_keys_idx        ON project_memory.episodes USING gin (anchor_keys);

-- 7. Turn 在某个 Space 的归属与 Task 归属
CREATE TABLE IF NOT EXISTS project_memory.episode_turns (
  space_id         text NOT NULL,
  conversation_key text NOT NULL,
  turn_id          text NOT NULL,
  project_id       text NOT NULL,
  episode_id       text NOT NULL,
  turn_seq         int  NOT NULL,                                     -- Episode 内顺序
  message_count    int  NOT NULL,                                     -- 本 Turn 的消息数（open_episode_messages 用）
  task_id          text NOT NULL,
  user_id          text NOT NULL,
  agent_id         jsonb,
  chat_time        timestamptz NOT NULL,
  accepted_at      timestamptz NOT NULL,
  PRIMARY KEY (space_id, conversation_key, turn_id),                  -- 一个 Space 内一个 Turn 只有一个归属
  FOREIGN KEY (space_id, episode_id) REFERENCES project_memory.episodes (space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_key, turn_id) REFERENCES project_memory.messages (project_id, conversation_key, message_id)
);
CREATE INDEX IF NOT EXISTS episode_turns_task_idx    ON project_memory.episode_turns (project_id, task_id);
CREATE INDEX IF NOT EXISTS episode_turns_episode_idx ON project_memory.episode_turns (episode_id, turn_seq);
