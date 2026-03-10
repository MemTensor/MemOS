/**
 * Mock skill data for testing the Skills viewer page.
 * Run: npx tsx scripts/mock-skills.ts
 */
import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const dbPath = path.join(os.homedir(), ".openclaw", "memos-local", "memos.db");
console.log(`Opening DB: ${dbPath}`);
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    version     INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL DEFAULT 'active',
    tags        TEXT NOT NULL DEFAULT '[]',
    source_type TEXT NOT NULL DEFAULT 'task',
    dir_path    TEXT NOT NULL DEFAULT '',
    installed   INTEGER NOT NULL DEFAULT 0,
    quality_score REAL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
  CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

  CREATE TABLE IF NOT EXISTS skill_versions (
    id              TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL REFERENCES skills(id),
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    changelog       TEXT NOT NULL DEFAULT '',
    upgrade_type    TEXT NOT NULL DEFAULT 'create',
    source_task_id  TEXT,
    metrics         TEXT NOT NULL DEFAULT '{}',
    quality_score   REAL,
    created_at      INTEGER NOT NULL,
    UNIQUE(skill_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);

  CREATE TABLE IF NOT EXISTS task_skills (
    task_id    TEXT NOT NULL,
    skill_id   TEXT NOT NULL REFERENCES skills(id),
    relation   TEXT NOT NULL DEFAULT 'generated_from',
    version_at INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, skill_id)
  );
`);
console.log("Ensured skill tables exist");

// Migrate quality_score columns if missing
try {
  const skillCols = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
  if (!skillCols.some(c => c.name === "quality_score")) {
    db.exec("ALTER TABLE skills ADD COLUMN quality_score REAL");
    console.log("Migrated: added quality_score to skills");
  }
  const vCols = db.prepare("PRAGMA table_info(skill_versions)").all() as Array<{ name: string }>;
  if (!vCols.some(c => c.name === "quality_score")) {
    db.exec("ALTER TABLE skill_versions ADD COLUMN quality_score REAL");
    console.log("Migrated: added quality_score to skill_versions");
  }
  if (!vCols.some(c => c.name === "change_summary")) {
    db.exec("ALTER TABLE skill_versions ADD COLUMN change_summary TEXT NOT NULL DEFAULT ''");
    console.log("Migrated: added change_summary to skill_versions");
  }
} catch (e) { console.log("Migration check:", e); }

const now = Date.now();

const skills = [
  {
    id: uuid(),
    name: "docker-node-deploy",
    description: "如何将 Node.js 应用部署到 Docker 容器中。当用户需要容器化部署、Dockerfile 编写、镜像构建、端口映射、多阶段构建，或任何将 Node 应用打包为 Docker 容器的场景时，使用此技能。",
    version: 2,
    status: "active",
    tags: JSON.stringify(["docker", "node.js", "deployment", "devops"]),
    sourceType: "task",
    dirPath: path.join(os.homedir(), ".openclaw", "skills-store", "docker-node-deploy"),
    installed: 1,
    createdAt: now - 7 * 86400000,
    updatedAt: now - 2 * 86400000,
    content_v1: `---
name: "docker-node-deploy"
description: "如何将 Node.js 应用部署到 Docker 容器中。当用户需要容器化部署、Dockerfile 编写、镜像构建、端口映射、多阶段构建，或任何将 Node 应用打包为 Docker 容器的场景时，使用此技能。"
metadata: { "openclaw": { "emoji": "🐳" } }
---

# Docker Node.js 部署指南

将 Node.js 应用安全、高效地打包为 Docker 容器并运行。

## 适用场景
- 需要将 Node.js 后端服务容器化
- 需要编写优化的 Dockerfile（多阶段构建）
- 需要处理端口映射、环境变量注入
- 需要在 CI/CD 中构建 Docker 镜像

## 步骤

### 1. 创建 Dockerfile（多阶段构建）

\`\`\`dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
\`\`\`

为什么用多阶段：减少最终镜像大小约 60%，不包含开发依赖和源码。

### 2. 创建 .dockerignore

\`\`\`
node_modules
.git
*.md
.env
\`\`\`

### 3. 构建和运行

\`\`\`bash
docker build -t my-app:latest .
docker run -d -p 3000:3000 --name my-app --env-file .env.production my-app:latest
\`\`\`

## 踩坑指南

**错误方式**：直接 \`COPY . .\` 不用 .dockerignore → 镜像巨大，包含 node_modules 和 .git
**正确方式**：分层 COPY，先 package.json 再源码，利用 Docker 缓存层

**错误方式**：用 \`npm install\` 而不是 \`npm ci\` → 可能安装不一致的依赖
**正确方式**：生产构建必须用 \`npm ci\`

## 关键配置

- Alpine 镜像比 Debian 小约 100MB
- 多阶段构建减少 60% 镜像体积
- \`--omit=dev\` 不安装开发依赖

## 注意事项
- Node.js >= 18 推荐使用 node:20-alpine
- 确保 .env 文件不被打包进镜像
- 健康检查建议添加 HEALTHCHECK 指令
`,
    content_v2: `---
name: "docker-node-deploy"
description: "如何将 Node.js 应用部署到 Docker 容器中。当用户需要容器化部署、Dockerfile 编写、镜像构建、端口映射、多阶段构建，或任何将 Node 应用打包为 Docker 容器的场景时，使用此技能。"
metadata: { "openclaw": { "emoji": "🐳" } }
---

# Docker Node.js 部署指南

将 Node.js 应用安全、高效地打包为 Docker 容器并运行。

## 适用场景
- 需要将 Node.js 后端服务容器化
- 需要编写优化的 Dockerfile（多阶段构建）
- 需要处理端口映射、环境变量注入
- 需要在 CI/CD 中构建 Docker 镜像
- 需要配置健康检查和优雅停机

## 步骤

### 1. 创建 Dockerfile（多阶段构建 + 健康检查）

\`\`\`dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
\`\`\`

为什么用多阶段：减少最终镜像大小约 60%，不包含开发依赖和源码。
v2 新增：HEALTHCHECK 指令，确保容器健康监测。

### 2. 创建 .dockerignore

\`\`\`
node_modules
.git
*.md
.env
dist
\`\`\`

### 3. 构建和运行

\`\`\`bash
docker build -t my-app:latest .
docker run -d -p 3000:3000 --name my-app --env-file .env.production --restart unless-stopped my-app:latest
\`\`\`

v2 新增：\`--restart unless-stopped\` 确保容器异常退出后自动重启。

## 踩坑指南

**错误方式**：直接 \`COPY . .\` 不用 .dockerignore → 镜像巨大
**正确方式**：分层 COPY + .dockerignore

**错误方式**：用 \`npm install\` 而不是 \`npm ci\`
**正确方式**：生产构建必须用 \`npm ci\`

**错误方式**：不加 --restart 策略 → 容器挂了不自动恢复
**正确方式**：添加 \`--restart unless-stopped\`

## 注意事项
- Node.js >= 18 推荐使用 node:20-alpine
- 确保 .env 文件不被打包进镜像
- 添加 /health 端点用于容器健康检查

<!-- v2: 新增 HEALTHCHECK、--restart 策略、优化 .dockerignore -->
`,
  },
  {
    id: uuid(),
    name: "sqlite-migration-pattern",
    description: "SQLite 数据库 schema 迁移的最佳实践。当需要给 SQLite 数据库添加新列、新表、修改索引，或处理向后兼容的 schema 变更时使用此技能。适用于任何使用 better-sqlite3 或类似驱动的 Node.js 项目。",
    version: 1,
    status: "active",
    tags: JSON.stringify(["sqlite", "migration", "database", "schema"]),
    sourceType: "task",
    dirPath: path.join(os.homedir(), ".openclaw", "skills-store", "sqlite-migration-pattern"),
    installed: 0,
    createdAt: now - 3 * 86400000,
    updatedAt: now - 3 * 86400000,
    content_v1: `---
name: "sqlite-migration-pattern"
description: "SQLite 数据库 schema 迁移的最佳实践。当需要给 SQLite 数据库添加新列、新表、修改索引，或处理向后兼容的 schema 变更时使用此技能。"
metadata: { "openclaw": { "emoji": "🗄️" } }
---

# SQLite Migration 最佳实践

在 Node.js + better-sqlite3 项目中安全地进行 schema 迁移。

## 适用场景
- 需要给现有表添加新列
- 需要创建新的关联表
- 需要保持向后兼容（旧数据库能自动迁移）

## 步骤

### 1. 添加新列的安全方式

\`\`\`typescript
private migrateNewColumn(): void {
  const cols = this.db.prepare("PRAGMA table_info(my_table)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === "new_column")) {
    this.db.exec("ALTER TABLE my_table ADD COLUMN new_column TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_my_table_new ON my_table(new_column)");
    this.log.info("Migrated: added new_column to my_table");
  }
}
\`\`\`

为什么要先检查：ALTER TABLE ADD COLUMN 如果列已存在会报错，PRAGMA table_info 是安全的幂等检查。

### 2. 创建新表（幂等）

\`\`\`sql
CREATE TABLE IF NOT EXISTS new_table (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_new_table_name ON new_table(name);
\`\`\`

### 3. 在 migrate() 中按顺序调用

\`\`\`typescript
migrate(): void {
  this.createCoreTables();
  this.migrateV2Columns();
  this.migrateV3Tables();
}
\`\`\`

## 踩坑指南

**错误方式**：直接执行 ALTER TABLE 不检查 → 第二次启动会报错
**正确方式**：用 PRAGMA table_info 检查列是否存在

**错误方式**：在 CREATE TABLE 后忘记加 IF NOT EXISTS
**正确方式**：始终使用 IF NOT EXISTS

## 注意事项
- SQLite 不支持 DROP COLUMN（3.35.0+ 才支持）
- SQLite 不支持 ALTER COLUMN，只能 ADD COLUMN
- 迁移顺序很重要：先建表、再加列、再加索引
`,
  },
  {
    id: uuid(),
    name: "typescript-strict-config",
    description: "TypeScript 严格模式配置与常见类型错误修复指南。当遇到 TS 编译错误、需要配置 tsconfig.json 严格选项、处理类型推断问题、或从 JS 迁移到 TS 时使用此技能。",
    version: 1,
    status: "draft",
    tags: JSON.stringify(["typescript", "config", "strict-mode", "type-safety"]),
    sourceType: "task",
    dirPath: path.join(os.homedir(), ".openclaw", "skills-store", "typescript-strict-config"),
    installed: 1,
    createdAt: now - 5 * 86400000,
    updatedAt: now - 5 * 86400000,
    content_v1: `---
name: "typescript-strict-config"
description: "TypeScript 严格模式配置与常见类型错误修复指南。当遇到 TS 编译错误、需要配置 tsconfig.json 严格选项、处理类型推断问题时使用此技能。"
metadata: { "openclaw": { "emoji": "📘" } }
---

# TypeScript 严格模式指南

配置 TypeScript 严格模式，修复常见类型错误。

## 适用场景
- 新项目需要配置 tsconfig.json
- 启用 strict 模式后出现大量报错
- 处理 null/undefined 类型安全

## 推荐配置

\`\`\`json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
\`\`\`

## 常见错误和修复

### Object is possibly undefined
\`\`\`typescript
// 错误
const val = obj.prop.nested;
// 正确
const val = obj.prop?.nested;
// 或断言（确定有值时）
const val = obj.prop!.nested;
\`\`\`

### Type X is not assignable to type Y
\`\`\`typescript
// 错误：直接用 as any
const row = db.prepare("...").get() as any;
// 正确：定义接口
interface MyRow { id: string; name: string }
const row = db.prepare("...").get() as MyRow | undefined;
\`\`\`

## 注意事项
- \`strict: true\` 等于同时启用 7 个 strict 子选项
- \`skipLibCheck: true\` 可以大幅加快编译速度
- 从 JS 迁移时建议先用 \`strict: false\`，逐步启用
`,
  },
];

// Get some existing task IDs for linking
const existingTasks = db.prepare("SELECT id, title FROM tasks WHERE status = 'completed' ORDER BY started_at DESC LIMIT 5").all() as Array<{ id: string; title: string }>;
console.log(`Found ${existingTasks.length} existing tasks for linking`);

for (const skill of skills) {
  // Create skill-store directory
  fs.mkdirSync(skill.dirPath, { recursive: true });
  fs.writeFileSync(path.join(skill.dirPath, "SKILL.md"), (skill as any).content_v2 || skill.content_v1, "utf-8");

  // Create sample scripts/references for docker skill
  if (skill.name === "docker-node-deploy") {
    const scriptsDir = path.join(skill.dirPath, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "build.sh"), "#!/bin/bash\ndocker build -t my-app:latest .\n", "utf-8");
    fs.writeFileSync(path.join(scriptsDir, "run.sh"), "#!/bin/bash\ndocker run -d -p 3000:3000 --name my-app --restart unless-stopped my-app:latest\n", "utf-8");
    const refsDir = path.join(skill.dirPath, "references");
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(refsDir, "docker-best-practices.md"), "# Docker Best Practices\n\n- Use multi-stage builds\n- Use .dockerignore\n- Use HEALTHCHECK\n", "utf-8");
    const evalsDir = path.join(skill.dirPath, "evals");
    fs.mkdirSync(evalsDir, { recursive: true });
    fs.writeFileSync(path.join(evalsDir, "evals.json"), JSON.stringify({
      skill_name: "docker-node-deploy",
      evals: [
        { id: 1, prompt: "帮我把 Node.js 项目打包成 Docker 镜像", expectations: ["使用多阶段构建", "包含 .dockerignore"] },
        { id: 2, prompt: "我的 Docker 容器经常崩溃，怎么自动重启", expectations: ["使用 --restart 策略", "添加 HEALTHCHECK"] },
      ],
    }, null, 2), "utf-8");
  }

  // Insert skill
  const qualityScore = skill.name === 'docker-node-deploy' ? 8.5 : skill.name === 'sqlite-migration-pattern' ? 7.2 : 5.0;
  db.prepare(`INSERT OR REPLACE INTO skills (id, name, description, version, status, tags, source_type, dir_path, installed, quality_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    skill.id, skill.name, skill.description, skill.version, skill.status,
    skill.tags, skill.sourceType, skill.dirPath, skill.installed, qualityScore,
    skill.createdAt, skill.updatedAt,
  );

  // Insert version 1
  const v1Summary = skill.name === 'docker-node-deploy'
    ? '首次从 Docker 部署 Node.js 的实际执行记录中提炼生成。涵盖多阶段构建 Dockerfile 编写、.dockerignore 配置、镜像构建与运行命令。记录了生产环境常见的错误方式（如直接 COPY 不用 .dockerignore、npm install 替代 npm ci）及其正确做法。包含 2 个辅助脚本（build.sh、run.sh）和 2 个测试用例。'
    : skill.name === 'sqlite-migration-pattern'
    ? '从实际项目中 SQLite schema 迁移的执行经验提炼而成。覆盖了添加新列的安全检查方式（PRAGMA table_info）、CREATE TABLE IF NOT EXISTS 的幂等性保证、以及按顺序组织 migrate 函数的最佳实践。避免了常见的"第二次启动报错"和"忘加 IF NOT EXISTS"问题。'
    : '从 TypeScript 严格模式配置的实践中提炼。包含推荐的 tsconfig.json 配置项、Object is possibly undefined 和 Type X is not assignable to Y 的典型修复方案。适合从 JS 迁移到 TS 或首次启用 strict 模式的项目。质量评分偏低，标记为 draft 待改进。';

  db.prepare(`INSERT OR REPLACE INTO skill_versions (id, skill_id, version, content, changelog, change_summary, upgrade_type, source_task_id, metrics, quality_score, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uuid(), skill.id, 1, skill.content_v1,
    `Initial generation`,
    v1Summary,
    "create", existingTasks[0]?.id ?? null, "{}", qualityScore,
    skill.createdAt,
  );

  // Insert version 2 if exists
  if ((skill as any).content_v2 && skill.version >= 2) {
    const v2Summary = '新增容器健康检查（HEALTHCHECK）和自动重启策略（--restart unless-stopped），解决了容器异常退出后无法自动恢复的问题。同时优化了 .dockerignore，增加了 dist 目录排除。这些改进来自一次实际的生产环境排障——容器频繁 crash 但无人察觉，加入 HEALTHCHECK 后运维平台可以自动检测并重启不健康的容器。';
    db.prepare(`INSERT OR REPLACE INTO skill_versions (id, skill_id, version, content, changelog, change_summary, upgrade_type, source_task_id, metrics, quality_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      uuid(), skill.id, 2, (skill as any).content_v2,
      `Added HEALTHCHECK, --restart policy, optimized .dockerignore`,
      v2Summary,
      "extend", existingTasks[1]?.id ?? null,
      JSON.stringify({ dimensions: ["more_robust", "new_scenario"], confidence: 0.85 }), qualityScore,
      skill.updatedAt,
    );
  }

  // Link to existing tasks
  if (existingTasks.length > 0) {
    const taskIdx = skills.indexOf(skill) % existingTasks.length;
    db.prepare(`INSERT OR REPLACE INTO task_skills (task_id, skill_id, relation, version_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      existingTasks[taskIdx].id, skill.id, "generated_from", 1, skill.createdAt,
    );
  }

  console.log(`  ✓ Skill "${skill.name}" v${skill.version} (installed=${skill.installed})`);
}

db.close();
console.log(`\nDone! Inserted ${skills.length} mock skills.`);
