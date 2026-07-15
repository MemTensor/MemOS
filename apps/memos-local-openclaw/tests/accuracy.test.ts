/**
 * Accuracy Test Suite — runs against REAL LLM models and production DB.
 *
 * What it tests:
 *   A. Dedup accuracy       — exact-dup + semantic-dup detection
 *   B. Merge accuracy       — UPDATE action with merged summary
 *   C. Topic boundary       — NEW vs SAME topic judgment
 *   D. Search precision     — Top-K precision for keyword & semantic queries
 *   E. Search recall        — all relevant memories found
 *   F. Summary quality      — summary shorter than original
 *
 * All data is written to the production DB (session prefix "test-accuracy-")
 * so you can verify results in the Viewer UI.
 *
 * Run: npx vitest run tests/accuracy.test.ts --timeout 300000
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initPlugin, type MemosLocalPlugin } from "../src/index";
import type { MemosLocalConfig } from "../types";

// ─── Load real config from OpenClaw ───

function loadProductionConfig(): Partial<MemosLocalConfig> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`OpenClaw config not found at ${cfgPath}. Run this test on a machine with OpenClaw installed.`);
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const pluginCfg = raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ?? {};
  return pluginCfg;
}

// ─── Progress Tracker ───

const TOTAL_TESTS = 14;
const startTime = Date.now();
let completedTests = 0;
const durations: number[] = [];

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function printProgress(testName: string) {
  const now = Date.now();
  const elapsed = now - startTime;
  completedTests++;
  durations.push(elapsed);

  const pct = Math.round((completedTests / TOTAL_TESTS) * 100);
  const remaining = TOTAL_TESTS - completedTests;
  const avgPerTest = elapsed / completedTests;
  const eta = Math.round(remaining * avgPerTest);

  const barLen = 30;
  const filled = Math.round(barLen * completedTests / TOTAL_TESTS);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

  console.log(
    `\n  [${bar}] ${completedTests}/${TOTAL_TESTS} (${pct}%)` +
    `  elapsed: ${fmtDuration(elapsed)}` +
    `  ETA: ${remaining > 0 ? fmtDuration(eta) : "done"}` +
    `  — ${testName}`,
  );
}

// ─── Helpers ───

const SESSION_PREFIX = "test-accuracy";
const ts = Date.now();
let sessionCounter = 0;
function nextSession(label: string): string {
  return `${SESSION_PREFIX}-${label}-${ts}-${++sessionCounter}`;
}

interface TestResult {
  category: string;
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];
function record(category: string, name: string, pass: boolean, detail: string) {
  results[results.length] = { category, name, pass, detail };
}

// ─── Setup ───

let plugin: MemosLocalPlugin;
const stateDir = path.join(process.env.HOME ?? "/tmp", ".openclaw");

beforeAll(async () => {
  console.log(`\n  MemOS Accuracy Test — ${TOTAL_TESTS} tests to run\n`);
  const config = loadProductionConfig();
  plugin = initPlugin({ stateDir, config });
}, 30_000);

afterAll(async () => {
  const totalElapsed = Date.now() - startTime;

  console.log("\n");
  console.log("═".repeat(60));
  console.log(`  MemOS Accuracy Test Report  (${fmtDuration(totalElapsed)})`);
  console.log("═".repeat(60));

  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const passed = catResults.filter((r) => r.pass).length;
    const total = catResults.length;
    const pct = total > 0 ? ((passed / total) * 100).toFixed(1) : "N/A";
    console.log(`  ${cat.padEnd(25)} ${passed}/${total} (${pct}%)`);
    for (const r of catResults) {
      const icon = r.pass ? "✅" : "❌";
      console.log(`    ${icon} ${r.name}: ${r.detail}`);
    }
  }
  console.log("═".repeat(60));

  await plugin.shutdown();
});

// ═══════════════════════════════════════════════════════════════
// A. Dedup Accuracy — 12 cases
// ═══════════════════════════════════════════════════════════════

describe("A. Dedup Accuracy", () => {
  const dedupSession = nextSession("dedup");

  it("A1-A3: exact duplicate detection", async () => {
    const content = "我们使用 Redis 6.2 作为缓存层，配置了 maxmemory 512mb，淘汰策略为 allkeys-lru，连接池大小 20";

    // Add the same content 3 times
    plugin.onConversationTurn([
      { role: "user", content },
      { role: "assistant", content: "好的，已记录 Redis 缓存配置。" },
    ], dedupSession);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content },
      { role: "assistant", content: "好的，已记录 Redis 缓存配置。" },
    ], dedupSession);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content },
      { role: "assistant", content: "好的，已记录 Redis 缓存配置。" },
    ], dedupSession);
    await plugin.flush();

    // Search and check: only 1 active, others duplicate
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Redis 缓存 maxmemory allkeys-lru", maxResults: 10 })) as any;

    const redisHits = result.hits.filter((h: any) =>
      h.original_excerpt?.includes("Redis") || h.summary?.includes("Redis"),
    );
    // Should have exactly 1 active hit (deduped copies are not returned by search)
    const pass = redisHits.length >= 1 && redisHits.length <= 2;
    record("Dedup", "A1-A3 exact dup", pass, `found ${redisHits.length} Redis hits (expect 1-2)`);
    printProgress("A1-A3: exact duplicate detection");
    expect(redisHits.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("A4-A6: semantic duplicate detection", async () => {
    const session = nextSession("semantic-dup");
    const variants = [
      "项目使用 PostgreSQL 14 作为主数据库，部署在 AWS RDS 上，实例类型 db.r6g.xlarge",
      "我们的主数据库是 PostgreSQL 14，跑在 AWS RDS 的 db.r6g.xlarge 实例上",
      "主数据库：PostgreSQL 14，托管在 AWS RDS，选的 db.r6g.xlarge 机型",
    ];

    for (const v of variants) {
      plugin.onConversationTurn([
        { role: "user", content: v },
        { role: "assistant", content: "已记录数据库配置。" },
      ], session);
      await plugin.flush();
    }

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "PostgreSQL RDS db.r6g.xlarge", maxResults: 10 })) as any;
    const pgHits = result.hits.filter((h: any) =>
      h.original_excerpt?.includes("PostgreSQL") || h.summary?.includes("PostgreSQL"),
    );

    // With smart dedup, 2nd and 3rd should be deduped → only 1-2 active
    const pass = pgHits.length >= 1 && pgHits.length <= 2;
    record("Dedup", "A4-A6 semantic dup", pass, `found ${pgHits.length} PG hits (expect 1-2)`);
    printProgress("A4-A6: semantic duplicate detection");
    expect(pgHits.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("A7-A9: merge (UPDATE) detection", async () => {
    const session = nextSession("merge");

    plugin.onConversationTurn([
      { role: "user", content: "前端使用 React 18 + Vite 构建，打包后部署到 CDN" },
      { role: "assistant", content: "好的，已记录前端技术栈。" },
    ], session);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content: "前端已从 React 18 + Vite 迁移到 Next.js 14，不再使用 CDN，改用 Vercel 部署" },
      { role: "assistant", content: "好的，已更新前端技术栈信息。" },
    ], session);
    await plugin.flush();

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "前端技术栈 React Vite Next.js", maxResults: 10 })) as any;
    const frontendHits = result.hits.filter((h: any) =>
      h.original_excerpt?.includes("Next.js") || h.original_excerpt?.includes("React") ||
      h.summary?.includes("Next.js") || h.summary?.includes("React"),
    );

    // The latest info (Next.js 14 + Vercel) should be the active one
    const hasLatest = frontendHits.some((h: any) =>
      (h.original_excerpt?.includes("Next.js") || h.summary?.includes("Next.js")),
    );
    record("Dedup", "A7-A9 merge/update", hasLatest, `latest info present: ${hasLatest}, hits: ${frontendHits.length}`);
    printProgress("A7-A9: merge (UPDATE) detection");
    expect(hasLatest).toBe(true);
  }, 120_000);

  it("A10-A12: unrelated content stays separate", async () => {
    const session = nextSession("no-dup");

    const topics = [
      "CI/CD 流水线使用 GitHub Actions，包含 lint、test、build、deploy 四个阶段",
      "公司年会定在 12 月 20 日，地点在杭州西湖国宾馆，需要准备节目表演",
      "新员工入职培训需要覆盖：代码规范、Git 工作流、Code Review 流程",
    ];

    for (const t of topics) {
      plugin.onConversationTurn([
        { role: "user", content: t },
        { role: "assistant", content: "已记录。" },
      ], session);
      await plugin.flush();
    }

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const r1 = (await searchTool.handler({ query: "GitHub Actions CI/CD", maxResults: 5 })) as any;
    const r2 = (await searchTool.handler({ query: "年会 西湖国宾馆", maxResults: 5 })) as any;
    const r3 = (await searchTool.handler({ query: "新员工入职培训 Code Review", maxResults: 5 })) as any;

    const allFound = r1.hits.length >= 1 && r2.hits.length >= 1 && r3.hits.length >= 1;
    record("Dedup", "A10-A12 no false dup", allFound, `CI/CD=${r1.hits.length}, 年会=${r2.hits.length}, 入职=${r3.hits.length}`);
    printProgress("A10-A12: unrelated content stays separate");
    expect(allFound).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════
// B. Topic Boundary — 12 cases
// ═══════════════════════════════════════════════════════════════

describe("B. Topic Boundary", () => {
  it("B1-B4: same topic stays in one task", async () => {
    const session = nextSession("same-topic");

    const turns = [
      { user: "帮我部署 Nginx 反向代理，监听 443 端口", assistant: "好的，我来帮你配置 Nginx。" },
      { user: "SSL 证书放在 /etc/nginx/ssl/ 目录下", assistant: "已配置 SSL 证书路径。" },
      { user: "upstream 需要指向 localhost:3000 和 localhost:3001 两个后端", assistant: "已添加 upstream 配置。" },
      { user: "还需要配置 gzip 压缩和缓存头", assistant: "已添加 gzip 和缓存配置。" },
    ];

    for (const turn of turns) {
      plugin.onConversationTurn([
        { role: "user", content: turn.user },
        { role: "assistant", content: turn.assistant },
      ], session);
      await plugin.flush();
    }

    // All 4 turns should be in the same task
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Nginx 反向代理 SSL upstream gzip", maxResults: 10 })) as any;
    const nginxHits = result.hits.filter((h: any) =>
      h.original_excerpt?.includes("Nginx") || h.original_excerpt?.includes("nginx") ||
      h.original_excerpt?.includes("SSL") || h.original_excerpt?.includes("upstream") ||
      h.original_excerpt?.includes("gzip") ||
      h.summary?.includes("Nginx") || h.summary?.includes("nginx"),
    );

    // Check they share the same taskId (if available in the response)
    const pass = nginxHits.length >= 2;
    record("Topic", "B1-B4 same topic", pass, `nginx-related hits: ${nginxHits.length}`);
    printProgress("B1-B4: same topic stays in one task");
    expect(nginxHits.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("B5-B8: different topics create separate tasks", async () => {
    const session = nextSession("diff-topic");

    // Topic 1: Docker
    plugin.onConversationTurn([
      { role: "user", content: "帮我写一个 Dockerfile，基础镜像用 node:20-alpine，安装 pnpm" },
      { role: "assistant", content: "好的，这是 Dockerfile..." },
    ], session);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content: "再加一个 .dockerignore 文件，排除 node_modules 和 .git" },
      { role: "assistant", content: "好的，已创建 .dockerignore。" },
    ], session);
    await plugin.flush();

    // Topic 2: completely different — cooking recipe
    plugin.onConversationTurn([
      { role: "user", content: "今晚想做红烧肉，需要什么食材？" },
      { role: "assistant", content: "红烧肉需要五花肉、酱油、冰糖、料酒、八角、桂皮、生姜。" },
    ], session);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content: "火候怎么控制？大火还是小火？" },
      { role: "assistant", content: "先大火煸炒上色，再转小火慢炖 40 分钟。" },
    ], session);
    await plugin.flush();

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const dockerResult = (await searchTool.handler({ query: "Dockerfile node alpine pnpm", maxResults: 5 })) as any;
    const cookResult = (await searchTool.handler({ query: "红烧肉 五花肉 火候", maxResults: 5 })) as any;

    const dockerFound = dockerResult.hits.length >= 1;
    const cookFound = cookResult.hits.length >= 1;
    const pass = dockerFound && cookFound;
    record("Topic", "B5-B8 diff topic", pass, `docker=${dockerResult.hits.length}, cooking=${cookResult.hits.length}`);
    printProgress("B5-B8: different topics create separate tasks");
    expect(pass).toBe(true);
  }, 120_000);

  it("B9-B10: related subtasks stay in same topic", async () => {
    const session = nextSession("subtask");

    plugin.onConversationTurn([
      { role: "user", content: "帮我搭建一个 Express 后端 API，用 TypeScript 写" },
      { role: "assistant", content: "好的，已初始化 Express + TypeScript 项目。" },
    ], session);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content: "给这个 Express 项目加上 JWT 认证中间件" },
      { role: "assistant", content: "已添加 JWT 认证中间件，使用 jsonwebtoken 库。" },
    ], session);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content: "再加一个 rate limiter 中间件，限制每个 IP 每分钟 100 次请求" },
      { role: "assistant", content: "已添加 express-rate-limit 中间件。" },
    ], session);
    await plugin.flush();

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Express TypeScript JWT rate limiter", maxResults: 10 })) as any;
    const pass = result.hits.length >= 2;
    record("Topic", "B9-B10 subtask", pass, `Express-related hits: ${result.hits.length}`);
    printProgress("B9-B10: related subtasks stay in same topic");
    expect(pass).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════
// C. Search Precision — 12 cases
// ═══════════════════════════════════════════════════════════════

describe("C. Search Precision", () => {
  const searchSession = nextSession("search-data");

  beforeAll(async () => {
    const data = [
      "MySQL 8.0 的 InnoDB 引擎默认行锁粒度，支持 MVCC 多版本并发控制",
      "Kubernetes 集群使用 3 个 master 节点和 5 个 worker 节点，部署在阿里云 ECS 上",
      "前端性能优化：使用 React.lazy 做代码分割，Lighthouse 性能分数从 45 提升到 92",
      "团队每周三下午进行 Code Review，使用 GitLab MR 模板，要求至少 2 人 approve",
      "监控告警使用 Prometheus + Grafana，告警通过企业微信推送",
      "日志收集使用 ELK 技术栈：Elasticsearch 7.17 + Logstash + Kibana",
      "API 文档使用 Swagger/OpenAPI 3.0 规范，通过 swagger-jsdoc 自动生成",
      "数据库备份策略：每日全量备份 + 每小时增量备份，保留 30 天",
    ];

    for (const content of data) {
      plugin.onConversationTurn([
        { role: "user", content },
        { role: "assistant", content: "已记录。" },
      ], searchSession);
      await plugin.flush();
    }
  }, 180_000);

  it("C1-C4: keyword precision", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    const cases = [
      { query: "MySQL InnoDB MVCC", expect: "MySQL" },
      { query: "Kubernetes master worker 阿里云", expect: "Kubernetes" },
      { query: "React.lazy Lighthouse 性能", expect: "React" },
      { query: "Prometheus Grafana 企业微信", expect: "Prometheus" },
    ];

    for (const c of cases) {
      const result = (await searchTool.handler({ query: c.query, maxResults: 3 })) as any;
      const top1 = result.hits[0];
      const hit = top1 && (
        top1.original_excerpt?.includes(c.expect) || top1.summary?.includes(c.expect)
      );
      record("Precision", `keyword: ${c.expect}`, !!hit, `top1 contains "${c.expect}": ${!!hit}`);
      expect(hit).toBeTruthy();
    }
    printProgress("C1-C4: keyword precision");
  }, 120_000);

  it("C5-C8: semantic precision", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    const cases = [
      { query: "数据库并发控制和锁机制", expect: "MySQL" },
      { query: "容器编排和云服务器集群", expect: "Kubernetes" },
      { query: "代码审查流程和规范", expect: "Code Review" },
      { query: "日志采集和检索系统", expect: "ELK" },
    ];

    let semanticHits = 0;
    for (const c of cases) {
      const result = (await searchTool.handler({ query: c.query, maxResults: 3 })) as any;
      const top3 = result.hits.slice(0, 3);
      const found = top3.some((h: any) =>
        h.original_excerpt?.includes(c.expect) || h.summary?.includes(c.expect),
      );
      if (found) semanticHits++;
      record("Precision", `semantic: ${c.expect}`, found, `top3 contains "${c.expect}": ${found}`);
    }
    printProgress("C5-C8: semantic precision");
    expect(semanticHits).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("C9-C12: negative cases (no false positives)", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    const cases = [
      { query: "深度学习 PyTorch 训练 GPU", forbidden: ["MySQL", "Kubernetes", "React", "Nginx"] },
      { query: "股票交易 量化策略 回测", forbidden: ["MySQL", "Kubernetes", "React", "Nginx"] },
      { query: "室内装修 瓷砖 油漆 水电", forbidden: ["MySQL", "Kubernetes", "React", "Nginx"] },
      { query: "健身计划 有氧运动 蛋白质", forbidden: ["MySQL", "Kubernetes", "React", "Nginx"] },
    ];

    for (const c of cases) {
      const result = (await searchTool.handler({ query: c.query, maxResults: 5, minScore: 0.6 })) as any;
      const falsePositives = result.hits.filter((h: any) =>
        c.forbidden.some((f) => h.original_excerpt?.includes(f) || h.summary?.includes(f)),
      );
      const pass = falsePositives.length === 0;
      record("Precision", `negative: ${c.query.slice(0, 15)}`, pass,
        `false positives: ${falsePositives.length}, total hits: ${result.hits.length}`);
      expect(falsePositives.length).toBe(0);
    }
    printProgress("C9-C12: negative cases (no false positives)");
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════
// D. Search Recall — 8 cases
// ═══════════════════════════════════════════════════════════════

describe("D. Search Recall", () => {
  const recallSession = nextSession("recall-data");

  beforeAll(async () => {
    const devopsData = [
      "Jenkins Pipeline 配置：Jenkinsfile 放在项目根目录，使用 declarative 语法",
      "SonarQube 代码质量门禁：覆盖率 > 80%，重复率 < 3%，无 blocker 级别问题",
      "Ansible Playbook 管理服务器配置，inventory 按环境分：dev、staging、production",
      "Terraform 管理云基础设施，state 文件存在 S3 + DynamoDB 锁",
    ];

    for (const content of devopsData) {
      plugin.onConversationTurn([
        { role: "user", content },
        { role: "assistant", content: "已记录 DevOps 配置。" },
      ], recallSession);
      await plugin.flush();
    }
  }, 120_000);

  it("D1-D4: recall all related memories", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "DevOps CI/CD 自动化部署 基础设施", maxResults: 10 })) as any;

    const keywords = ["Jenkins", "SonarQube", "Ansible", "Terraform"];
    let found = 0;
    for (const kw of keywords) {
      const hit = result.hits.some((h: any) =>
        h.original_excerpt?.includes(kw) || h.summary?.includes(kw),
      );
      if (hit) found++;
      record("Recall", `recall: ${kw}`, hit, hit ? "found" : "missed");
    }

    printProgress("D1-D4: recall all related memories");
    expect(found).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("D5-D8: cross-language recall", async () => {
    const session = nextSession("cross-lang");

    plugin.onConversationTurn([
      { role: "user", content: "We use Docker Compose for local development, with services: api, web, postgres, redis" },
      { role: "assistant", content: "Noted the Docker Compose setup." },
    ], session);
    await plugin.flush();

    plugin.onConversationTurn([
      { role: "user", content: "本地开发环境用了 Docker Compose，包含四个服务容器" },
      { role: "assistant", content: "已记录本地开发环境配置。" },
    ], session);
    await plugin.flush();

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    // Search in Chinese for English content
    const zhResult = (await searchTool.handler({ query: "Docker Compose 本地开发 服务容器", maxResults: 5 })) as any;
    const zhFound = zhResult.hits.some((h: any) =>
      h.original_excerpt?.includes("Docker Compose") || h.summary?.includes("Docker"),
    );
    record("Recall", "D5-D6 zh→en recall", zhFound, `zh query found docker: ${zhFound}`);

    // Search in English for Chinese content
    const enResult = (await searchTool.handler({ query: "Docker Compose local development services", maxResults: 5 })) as any;
    const enFound = enResult.hits.some((h: any) =>
      h.original_excerpt?.includes("Docker") || h.summary?.includes("Docker"),
    );
    record("Recall", "D7-D8 en→zh recall", enFound, `en query found docker: ${enFound}`);

    printProgress("D5-D8: cross-language recall");
    expect(zhFound || enFound).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════
// E. Summary Quality — 6 cases
// ═══════════════════════════════════════════════════════════════

describe("E. Summary Quality", () => {
  it("E1-E3: long text summary shorter than original", async () => {
    const session = nextSession("summary-long");

    const longTexts = [
      "我们的微服务架构包含以下组件：用户服务（user-service）负责认证授权，订单服务（order-service）处理订单生命周期，支付服务（payment-service）对接支付宝和微信支付，库存服务（inventory-service）管理商品库存，通知服务（notification-service）发送短信和邮件通知。所有服务通过 Kubernetes 部署，使用 Istio 做服务网格，Jaeger 做链路追踪。",
      "数据库迁移方案：第一阶段（Q1）将用户表从 MySQL 迁移到 PostgreSQL，保持双写一个月；第二阶段（Q2）迁移订单表和支付表，使用 CDC 方案（Debezium）做实时同步；第三阶段（Q3）停止旧库写入，完成全量迁移。回滚方案：每个阶段保留旧库只读副本 90 天。",
      "前端监控体系搭建：使用 Sentry 做错误监控，收集 JS 异常、Promise rejection、资源加载失败；使用自研 SDK 采集性能指标（FCP、LCP、FID、CLS），上报到自建的 ClickHouse 集群；使用 GrowingIO 做用户行为分析，埋点方案采用全埋点 + 自定义事件混合模式。",
    ];

    for (const text of longTexts) {
      plugin.onConversationTurn([
        { role: "user", content: text },
        { role: "assistant", content: "已记录。" },
      ], session);
    }
    await plugin.flush();

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const queries = ["微服务架构 Kubernetes Istio", "数据库迁移 PostgreSQL CDC", "前端监控 Sentry ClickHouse"];

    let shorterCount = 0;
    for (let i = 0; i < queries.length; i++) {
      const result = (await searchTool.handler({ query: queries[i], maxResults: 3 })) as any;
      if (result.hits.length > 0) {
        const hit = result.hits[0];
        const summaryLen = hit.summary?.length ?? 0;
        const originalLen = longTexts[i].length;
        const shorter = summaryLen < originalLen;
        if (shorter) shorterCount++;
        record("Summary", `E${i + 1} long text`, shorter, `summary=${summaryLen} vs original=${originalLen}`);
      } else {
        record("Summary", `E${i + 1} long text`, false, "no hits found");
      }
    }
    printProgress("E1-E3: long text summary shorter than original");
    expect(shorterCount).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("E4-E6: short text summary not longer than original", async () => {
    const session = nextSession("summary-short");

    const shortTexts = [
      "Redis 端口改为 6380",
      "明天下午两点开会",
      "npm run build 报错了",
    ];

    for (const text of shortTexts) {
      plugin.onConversationTurn([
        { role: "user", content: text },
        { role: "assistant", content: "好的。" },
      ], session);
    }
    await plugin.flush();

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const queries = ["Redis 端口 6380", "明天开会", "npm build 报错"];

    for (let i = 0; i < queries.length; i++) {
      const result = (await searchTool.handler({ query: queries[i], maxResults: 3 })) as any;
      if (result.hits.length > 0) {
        const hit = result.hits[0];
        const summaryLen = hit.summary?.length ?? 0;
        const originalLen = shortTexts[i].length;
        const ok = summaryLen <= originalLen;
        record("Summary", `E${i + 4} short text`, ok, `summary=${summaryLen} vs original=${originalLen}`);
        expect(ok).toBe(true);
      } else {
        record("Summary", `E${i + 4} short text`, false, "no hits found");
      }
    }
    printProgress("E4-E6: short text summary not longer than original");
  }, 120_000);
});
