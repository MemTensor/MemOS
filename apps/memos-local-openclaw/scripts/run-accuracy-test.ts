#!/usr/bin/env npx tsx
/**
 * MemOS Accuracy Test — sends data through OpenClaw Gateway (real pipeline).
 *
 * Ingest uses `openclaw agent` CLI so data flows through the full gateway,
 * is processed by the memos plugin, and is visible in the Viewer UI.
 * Search verification uses direct DB access via initPlugin.
 *
 * Usage:
 *   npx tsx scripts/run-accuracy-test.ts               # quick mode (5 ingest, verify only)
 *   npx tsx scripts/run-accuracy-test.ts --full         # full 50+ test cases
 *   npx tsx scripts/run-accuracy-test.ts --workers 3    # concurrent sessions (full mode)
 *   npx tsx scripts/run-accuracy-test.ts --skip-ingest  # only run search checks (assumes data exists)
 *
 * Add to package.json:
 *   "test:accuracy": "tsx scripts/run-accuracy-test.ts"
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initPlugin, type MemosLocalPlugin } from "../src/index";

// ─── CLI args ───

const args = process.argv.slice(2);
const FULL_MODE = args.includes("--full");
const SKIP_INGEST = args.includes("--skip-ingest");
const WORKERS = Number(args.find((_, i, a) => a[i - 1] === "--workers") ?? 2);
const INGEST_DELAY_MS = 3000;

// ─── Config ───

function loadConfig() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`OpenClaw config not found: ${cfgPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  return raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ?? {};
}

// ─── Test framework ───

interface TestResult {
  category: string;
  name: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];
const RUN_ID = Date.now();
const SESSION_PREFIX = `acc-${RUN_ID}`;
let sessionSeq = 0;

function mkSession(label: string) {
  return `${SESSION_PREFIX}-${label}-${++sessionSeq}`;
}

function log(msg: string) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ─── Progress tracker ───

class ProgressTracker {
  private total: number;
  private done = 0;
  private startMs = Date.now();
  private phaseName: string;

  constructor(phaseName: string, total: number) {
    this.phaseName = phaseName;
    this.total = total;
  }

  tick(label: string) {
    this.done++;
    const elapsed = Date.now() - this.startMs;
    const pct = Math.round((this.done / this.total) * 100);
    const remaining = this.total - this.done;
    const avgMs = elapsed / this.done;
    const eta = Math.round(remaining * avgMs);

    const barLen = 30;
    const filled = Math.round(barLen * this.done / this.total);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

    log(
      `  [${bar}] ${this.done}/${this.total} (${pct}%)` +
      `  elapsed: ${fmtDur(elapsed)}  ETA: ${remaining > 0 ? fmtDur(eta) : "done"}` +
      `  — ${label}`,
    );
  }

  summary(): string {
    const elapsed = Date.now() - this.startMs;
    return `${this.phaseName}: ${this.done}/${this.total} in ${fmtDur(elapsed)}`;
  }
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m${sec}s`;
}

function hitContains(hits: any[], keyword: string): boolean {
  return hits.some(
    (h: any) =>
      h.original_excerpt?.toLowerCase().includes(keyword.toLowerCase()) ||
      h.summary?.toLowerCase().includes(keyword.toLowerCase()),
  );
}

// ─── Send message through OpenClaw Gateway ───

function sendViaGateway(sessionId: string, message: string): boolean {
  const tmpFile = path.join(os.tmpdir(), `memos-test-msg-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpFile, message, "utf-8");
    execSync(
      `openclaw agent --session-id "${sessionId}" --message "$(cat '${tmpFile}')" --json`,
      { timeout: 120_000, stdio: "pipe" },
    );
    return true;
  } catch (e: any) {
    log(`  [WARN] gateway send failed: ${e.message?.slice(0, 200)}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── Test data: realistic, multi-turn, long-form conversations ───

interface ConversationCase {
  id: string;
  label: string;
  sessionId: string;
  messages: string[];
  group: "dedup" | "topic" | "search" | "summary" | "cross-lang";
}

function buildTestCases(): ConversationCase[] {
  const cases: ConversationCase[] = [];

  // ═══════════════════════════════════════════
  // Group 1: Dedup — exact / semantic / merge
  // ═══════════════════════════════════════════

  const dedupSession1 = mkSession("dedup-exact");
  cases.push({
    id: "dedup-exact-1",
    label: "Dedup: exact duplicate (msg 1/3)",
    sessionId: dedupSession1,
    group: "dedup",
    messages: [
      `我们的线上 Redis 集群配置如下：Redis 版本 6.2.14，部署在 3 台 AWS ElastiCache r6g.xlarge 节点上，组成 3 主 3 从的 Cluster 模式。maxmemory 设置为 12GB，淘汰策略用 allkeys-lru，连接池大小 50，超时时间 3 秒。所有缓存 key 统一加 "prod:" 前缀，TTL 默认 1 小时，热点数据（如用户 session、商品详情）TTL 设为 24 小时。`,
    ],
  });
  cases.push({
    id: "dedup-exact-2",
    label: "Dedup: exact duplicate (msg 2/3, same content)",
    sessionId: dedupSession1,
    group: "dedup",
    messages: [
      `我们的线上 Redis 集群配置如下：Redis 版本 6.2.14，部署在 3 台 AWS ElastiCache r6g.xlarge 节点上，组成 3 主 3 从的 Cluster 模式。maxmemory 设置为 12GB，淘汰策略用 allkeys-lru，连接池大小 50，超时时间 3 秒。所有缓存 key 统一加 "prod:" 前缀，TTL 默认 1 小时，热点数据（如用户 session、商品详情）TTL 设为 24 小时。`,
    ],
  });
  cases.push({
    id: "dedup-exact-3",
    label: "Dedup: exact duplicate (msg 3/3, same content again)",
    sessionId: dedupSession1,
    group: "dedup",
    messages: [
      `我们的线上 Redis 集群配置如下：Redis 版本 6.2.14，部署在 3 台 AWS ElastiCache r6g.xlarge 节点上，组成 3 主 3 从的 Cluster 模式。maxmemory 设置为 12GB，淘汰策略用 allkeys-lru，连接池大小 50，超时时间 3 秒。所有缓存 key 统一加 "prod:" 前缀，TTL 默认 1 小时，热点数据（如用户 session、商品详情）TTL 设为 24 小时。`,
    ],
  });

  const dedupSession2 = mkSession("dedup-semantic");
  cases.push({
    id: "dedup-sem-1",
    label: "Dedup: semantic dup (PostgreSQL v1)",
    sessionId: dedupSession2,
    group: "dedup",
    messages: [
      `主数据库使用 PostgreSQL 16，部署在 AWS RDS 的 db.r6g.2xlarge 实例上。已开启读写分离，1 个 writer 实例 + 2 个 reader 副本做负载均衡。连接池用 PgBouncer，transaction pooling 模式，max_client_conn 设为 200，default_pool_size 设为 25。WAL 日志异步复制，backup 策略是每日自动快照 + 开启 Point-in-Time Recovery（PITR），保留 7 天。`,
    ],
  });
  cases.push({
    id: "dedup-sem-2",
    label: "Dedup: semantic dup (PostgreSQL v2 — reworded)",
    sessionId: dedupSession2,
    group: "dedup",
    messages: [
      `生产环境的核心关系型数据库是 PG 16，跑在 Amazon RDS 上面，机型选的是 db.r6g.2xlarge。数据库做了读写分离——一个主库负责写入，两个只读副本分担查询流量。中间层用 PgBouncer 做连接池管理，采用事务级池化，最大客户端连接数 200，默认池大小 25。日志走 WAL 异步复制，每天自动创建快照备份，还启用了时间点恢复（PITR），保留窗口 7 天。`,
    ],
  });

  const dedupSession3 = mkSession("dedup-merge");
  cases.push({
    id: "dedup-merge-1",
    label: "Dedup: merge — old state (React 18 + Vite)",
    sessionId: dedupSession3,
    group: "dedup",
    messages: [
      `前端项目用 React 18.2 搭配 Vite 5.0 构建，TypeScript 5.3 严格模式。状态管理用 Zustand + React Query v5，UI 组件库用 Ant Design 5.x。打包产物部署到 CloudFront CDN，Gzip + Brotli 双压缩，首屏 LCP 控制在 1.8 秒以内。`,
    ],
  });
  cases.push({
    id: "dedup-merge-2",
    label: "Dedup: merge — new state (migrated to Next.js 14)",
    sessionId: dedupSession3,
    group: "dedup",
    messages: [
      `前端已经从 React 18 + Vite 迁移到了 Next.js 14 App Router，改用 Vercel 部署。状态管理保持 Zustand + React Query 不变，但 UI 组件库换成了 Shadcn/ui + Tailwind CSS。SSR + ISR 混合渲染，Core Web Vitals 全绿，LCP 降到 1.2 秒。`,
    ],
  });

  // ═══════════════════════════════════════════
  // Group 2: Topic boundary detection
  // ═══════════════════════════════════════════

  const topicSameSession = mkSession("topic-same");
  cases.push({
    id: "topic-same-1",
    label: "Topic: same topic (Nginx config, part 1)",
    sessionId: topicSameSession,
    group: "topic",
    messages: [
      `帮我配置生产环境的 Nginx 反向代理。需求：监听 443 端口，SSL/TLS 证书放在 /etc/nginx/ssl/ 目录下，upstream 后端是 localhost:3000 的 Node.js 应用。需要配置 worker_processes auto，worker_connections 4096，以及 proxy_set_header 把真实 IP 传到后端。`,
    ],
  });
  cases.push({
    id: "topic-same-2",
    label: "Topic: same topic (Nginx config, part 2 — add gzip + cache)",
    sessionId: topicSameSession,
    group: "topic",
    messages: [
      `Nginx 配置再加几个优化：开启 gzip 压缩（gzip on; gzip_types text/plain text/css application/json application/javascript; gzip_min_length 1024;），静态资源加浏览器缓存头（location ~* \\.(js|css|png|jpg|svg|woff2)$ { expires 30d; add_header Cache-Control "public, immutable"; }），还要加上 HTTP/2 和 HSTS（add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";）。`,
    ],
  });

  const topicSwitchSession = mkSession("topic-switch");
  cases.push({
    id: "topic-switch-1",
    label: "Topic: switch — Docker (tech)",
    sessionId: topicSwitchSession,
    group: "topic",
    messages: [
      `帮我写一个多阶段 Dockerfile，用于构建 Node.js 20 的生产镜像。第一阶段用 node:20-alpine 作为 builder，安装 pnpm，复制 package.json 和 pnpm-lock.yaml，然后 pnpm install --frozen-lockfile --prod=false，再 pnpm run build。第二阶段用干净的 node:20-alpine，只复制 dist/ 和 node_modules/，暴露 3000 端口，CMD ["node", "dist/server.js"]。同时生成一个 .dockerignore 排除 node_modules、.git、.env、coverage、*.md。`,
    ],
  });
  cases.push({
    id: "topic-switch-2",
    label: "Topic: switch — cooking (completely different domain)",
    sessionId: topicSwitchSession,
    group: "topic",
    messages: [
      `今天想试试做正宗的红烧肉。食材清单：五花肉 500g（切 3cm 方块）、冰糖 30g、生抽 3 勺、老抽 1 勺、料酒 2 勺、八角 2 颗、桂皮 1 小段、香叶 2 片、干辣椒 2 个、生姜 4 片、葱白 3 段。步骤：五花肉冷水下锅焯水 5 分钟，捞出洗净。锅里放少量油，中小火炒冰糖至焦糖色，下五花肉翻炒上色。加料酒、生抽、老抽，放八角桂皮香叶，加没过肉的热水，大火煮开后转小火炖 50 分钟。最后大火收汁，撒葱花出锅。`,
    ],
  });

  // ═══════════════════════════════════════════
  // Group 3: Search precision + recall data
  // ═══════════════════════════════════════════

  const searchSession = mkSession("search-data");
  cases.push({
    id: "search-mysql",
    label: "Search: MySQL InnoDB MVCC",
    sessionId: searchSession,
    group: "search",
    messages: [
      `线上 MySQL 8.0 数据库要点总结：存储引擎统一用 InnoDB，默认行级锁，支持 MVCC 多版本并发控制。事务隔离级别设为 REPEATABLE READ（MySQL 默认），innodb_buffer_pool_size 设为物理内存的 70%（当前 28GB / 40GB），innodb_flush_log_at_trx_commit=1 保证事务持久性。慢查询日志开启，long_query_time=2 秒，定期用 pt-query-digest 分析 Top 20 慢查询。索引策略：核心业务表必须有聚簇索引，联合索引遵循最左前缀原则，覆盖索引优先避免回表。`,
    ],
  });
  cases.push({
    id: "search-k8s",
    label: "Search: Kubernetes cluster",
    sessionId: searchSession,
    group: "search",
    messages: [
      `Kubernetes 生产集群规模和配置：3 个 master 节点（etcd 高可用集群）+ 8 个 worker 节点，全部部署在阿里云 ECS ecs.c7.2xlarge（8c16g）上。容器运行时用 containerd 1.7，网络插件 Calico VXLAN 模式。部署方式：核心服务 Deployment + HPA（CPU 60% 触发扩容，最小 2 副本最大 10 副本），有状态服务（MySQL、Redis）用 StatefulSet + PVC。日志用 Fluent Bit DaemonSet 采集到 ES，监控用 Prometheus Operator + kube-state-metrics。`,
    ],
  });
  cases.push({
    id: "search-review",
    label: "Search: Code Review process",
    sessionId: searchSession,
    group: "search",
    messages: [
      `团队 Code Review 流程规范：每周三下午 2-4 点集中做 Code Review Session，其他时间异步 review。GitLab MR 模板包含：变更描述、影响范围、测试情况、截图/录屏。Review 规则：至少 2 人 approve 才能合并，其中 1 人必须是 Tech Lead 或 Senior。自动化检查：CI 跑 lint（ESLint + Prettier）、单元测试（覆盖率门禁 80%）、类型检查、依赖安全扫描（Snyk）。Code Review 重点关注：逻辑正确性 > 性能 > 可读性 > 编码风格。`,
    ],
  });
  cases.push({
    id: "search-elk",
    label: "Search: ELK logging stack",
    sessionId: searchSession,
    group: "search",
    messages: [
      `日志系统架构：ELK 栈。Elasticsearch 7.17 集群（3 节点，每节点 64GB 内存 + 2TB SSD），Logstash 作为日志处理管道（grok 解析 + 字段映射 + 时间戳标准化），Kibana 做可视化和告警。日志分级：应用日志走 Fluent Bit → Kafka（缓冲） → Logstash → ES，系统日志直接 Filebeat → ES。索引策略：按天滚动创建索引（logs-app-YYYY.MM.DD），ILM 策略 hot/warm/cold 三层，hot 7 天 SSD，warm 30 天 HDD，cold 90 天归档到 S3 Glacier。`,
    ],
  });
  cases.push({
    id: "search-monitoring",
    label: "Search: Prometheus Grafana monitoring",
    sessionId: searchSession,
    group: "search",
    messages: [
      `监控告警体系：Prometheus 2.45 + Grafana 10.x + AlertManager。Prometheus 抓取间隔 15 秒，数据保留 30 天。主要 exporter：node_exporter（主机指标）、cadvisor（容器指标）、mysqld_exporter、redis_exporter、blackbox_exporter（HTTP 探测）。Grafana 仪表盘：系统概览、应用 QPS/延迟/错误率、数据库连接池、Redis 命中率。告警规则：CPU > 80% 持续 5 分钟 → 企业微信通知，5xx 错误率 > 1% → 电话告警（PagerDuty），磁盘使用率 > 85% → 邮件通知。`,
    ],
  });

  // Recall data — DevOps tools
  const recallSession = mkSession("recall-devops");
  cases.push({
    id: "search-jenkins",
    label: "Search: Jenkins CI pipeline",
    sessionId: recallSession,
    group: "search",
    messages: [
      `CI/CD Pipeline 用 Jenkins 2.x，Jenkinsfile 放在项目根目录，采用 declarative pipeline 语法。流水线分 5 个 stage：Checkout → Lint & Type Check → Unit Test（Jest，覆盖率报告上传 SonarQube）→ Build（Docker 多阶段构建）→ Deploy（kubectl apply 到对应环境）。分支策略：feature/* 只跑 lint + test，develop 跑全量 + 部署 staging，main 跑全量 + 部署 production（需要人工审批）。Jenkins 节点用 Kubernetes Pod 作为 agent，按需弹性伸缩。`,
    ],
  });
  cases.push({
    id: "search-terraform",
    label: "Search: Terraform IaC",
    sessionId: recallSession,
    group: "search",
    messages: [
      `基础设施即代码用 Terraform 1.6，state 存在 S3 bucket + DynamoDB 做状态锁，防止并发修改。模块化组织：modules/networking（VPC、子网、安全组）、modules/compute（ECS 实例、Auto Scaling Group）、modules/database（RDS、ElastiCache）、modules/monitoring（CloudWatch、SNS）。环境用 workspace 隔离：dev / staging / production。变量通过 terraform.tfvars 和 CI 环境变量注入。每次变更走 PR，CI 自动执行 terraform plan，输出 diff 到 PR 评论，merge 后自动 terraform apply。`,
    ],
  });

  // ═══════════════════════════════════════════
  // Group 4: Summary quality — long text
  // ═══════════════════════════════════════════

  const summarySession = mkSession("summary");
  cases.push({
    id: "summary-microservices",
    label: "Summary: complex microservices architecture",
    sessionId: summarySession,
    group: "summary",
    messages: [
      `微服务架构详细设计方案如下。服务拆分：user-service 负责用户注册登录、OAuth2.0 第三方授权、RBAC 权限管理、用户画像标签；order-service 处理订单创建/取消/退款全生命周期，支持分库分表（按 user_id 取模 16 库 64 表）；payment-service 对接支付宝当面付、微信 JSAPI 支付、银联快捷支付，所有支付回调统一走消息队列异步处理；inventory-service 管理商品库存，用 Redis 预扣 + MySQL 最终一致性方案防超卖；notification-service 负责短信（阿里云 SMS）、邮件（SES）、App Push（极光推送）、站内信。所有服务 Kubernetes 部署，Istio 服务网格做流量管理和灰度发布，Jaeger 全链路追踪，SkyWalking 做 APM 性能监控。服务间通信：同步走 gRPC（protobuf 序列化），异步走 RocketMQ 5.0。API Gateway 用 Kong，统一鉴权、限流、日志。`,
    ],
  });
  cases.push({
    id: "summary-migration",
    label: "Summary: DB migration plan",
    sessionId: summarySession,
    group: "summary",
    messages: [
      `数据库迁移三阶段实施方案。Q1（1-3 月）：用户表从 MySQL 迁移到 PostgreSQL。第一步搭建 PG 目标库，用 pgloader 做初始全量同步；第二步开启 Maxwell → Kafka → PG 的实时 CDC 增量同步；第三步应用层改为双写模式（先写 MySQL 再写 PG），持续一个月做数据一致性校验（每天凌晨全表 count + 随机抽样 1000 条 hash 比对）；第四步灰度切读到 PG（先 10% → 50% → 100%），确认无误后停止双写。Q2（4-6 月）：订单表和支付表迁移，用 Debezium CDC 替代 Maxwell（支持 exactly-once delivery），同样双写 + 校验 + 灰度流程。Q3（7-9 月）：剩余表迁移完成，停掉旧 MySQL 集群。每个阶段迁移完成后保留旧库只读权限 90 天，作为回滚保险。`,
    ],
  });

  // ═══════════════════════════════════════════
  // Group 5: Cross-language
  // ═══════════════════════════════════════════

  const crossLangSession = mkSession("cross-lang");
  cases.push({
    id: "cross-lang-en",
    label: "Cross-lang: Docker Compose (English)",
    sessionId: crossLangSession,
    group: "cross-lang",
    messages: [
      `Our local development setup uses Docker Compose with four services: "api" runs the Node.js backend on port 3000 with hot-reload via nodemon, "web" runs the Next.js frontend on port 3001 with Fast Refresh, "postgres" uses the official PostgreSQL 16 image with a named volume for data persistence, and "redis" uses Redis 7 Alpine for caching. We also have a "mailhog" service for testing email delivery locally. All services share a custom bridge network called "dev-net". Environment variables are injected via a .env file referenced in docker-compose.yml.`,
    ],
  });
  cases.push({
    id: "cross-lang-zh",
    label: "Cross-lang: Docker Compose (Chinese, same meaning)",
    sessionId: crossLangSession,
    group: "cross-lang",
    messages: [
      `本地开发环境用 Docker Compose 编排四个核心服务：api 容器跑 Node.js 后端（端口 3000，nodemon 热更新），web 容器跑 Next.js 前端（端口 3001，Fast Refresh），postgres 容器用官方 PostgreSQL 16 镜像（命名卷持久化数据），redis 容器用 Redis 7 Alpine 做缓存。另外还有一个 mailhog 容器用来本地测试邮件发送。所有容器通过自定义桥接网络 dev-net 互通。环境变量通过 .env 文件注入。`,
    ],
  });

  // ═══════════════════════════════════════════
  // Full mode: additional cases for scale
  // ═══════════════════════════════════════════

  if (FULL_MODE) {
    const fullSession = mkSession("full-extra");

    cases.push({
      id: "full-api-doc",
      label: "Full: API documentation (Swagger/OpenAPI)",
      sessionId: fullSession,
      group: "search",
      messages: [
        `API 文档自动化方案：使用 Swagger/OpenAPI 3.0 规范，结合 swagger-jsdoc 从代码注释自动生成 API 文档。每个接口必须标注：summary、description、parameters（含类型和校验规则）、requestBody schema、responses（200/400/401/403/404/500 各场景）。CI 流水线中自动生成 openapi.json，部署到 Swagger UI（内网 /api-docs 路径）。SDK 生成：用 openapi-generator 给前端自动生成 TypeScript axios client，给移动端生成 Swift/Kotlin client。文档变更必须随代码 PR 一起提交，CI 校验 schema 兼容性（不允许破坏性变更，用 oasdiff 检测）。`,
      ],
    });
    cases.push({
      id: "full-backup",
      label: "Full: Database backup strategy",
      sessionId: fullSession,
      group: "search",
      messages: [
        `数据库备份策略。MySQL：每日凌晨 2 点 mysqldump 全量备份（--single-transaction --routines --triggers），每小时 binlog 增量备份，所有备份加密后上传到 S3 Standard-IA，保留 30 天。PostgreSQL：每日 pg_basebackup 全量 + 持续 WAL 归档（archive_command 到 S3），支持 PITR。恢复演练：每月第一个周六做一次恢复演练，从 S3 拉取备份恢复到演练环境，验证数据完整性（行数对比 + 业务关键数据校验）。恢复 RTO 目标 < 1 小时，RPO 目标 < 1 小时。监控：备份任务状态接入 Prometheus，失败立即 PagerDuty 告警。`,
      ],
    });
    cases.push({
      id: "full-perf",
      label: "Full: React performance optimization",
      sessionId: fullSession,
      group: "search",
      messages: [
        `React 前端性能优化记录。代码层面：用 React.lazy + Suspense 做路由级代码分割，首屏 JS 从 1.2MB 降到 380KB；React.memo + useMemo 避免不必要的重渲染，列表组件用 react-window 虚拟化（1 万条数据渲染从 3.2 秒降到 60ms）；图片全部用 next/image 自动 WebP 转换 + 懒加载。构建层面：Vite 5 tree-shaking + dynamic import，第三方库用 CDN 外置（React/ReactDOM/Lodash）。Lighthouse 指标：Performance 从 45 提升到 92，FCP 1.1s，LCP 1.8s，CLS 0.02。监控：接入 web-vitals 库实时上报 Core Web Vitals 到 ClickHouse，Grafana 展示 P75/P90/P99 趋势。`,
      ],
    });

    const fullSession2 = mkSession("full-devops");
    cases.push({
      id: "full-sonarqube",
      label: "Full: SonarQube quality gate",
      sessionId: fullSession2,
      group: "search",
      messages: [
        `代码质量门禁用 SonarQube 9.x。Quality Gate 规则：新代码覆盖率 > 80%，整体覆盖率 > 65%，代码重复率 < 3%，无新增 Blocker/Critical 级别的 Bug 和漏洞，Maintainability Rating 必须 A 级。CI 集成：Jenkins pipeline 中在 test stage 之后执行 sonar-scanner，扫描结果推送到 SonarQube Server，Quality Gate 不通过则 pipeline 失败。自定义规则：在默认 Sonar way profile 基础上，新增了 SQL 注入检测、硬编码密钥检测、日志敏感信息检测等自定义规则。每周一生成代码质量周报，邮件发送给团队 Tech Lead。`,
      ],
    });
    cases.push({
      id: "full-ansible",
      label: "Full: Ansible server management",
      sessionId: fullSession2,
      group: "search",
      messages: [
        `服务器配置管理用 Ansible 2.15。Inventory 文件按环境分组：[dev]、[staging]、[production]，每个环境有独立的 group_vars。核心 Playbook：server-init.yml（系统初始化：时区/NTP/防火墙/用户/SSH 加固），deploy-app.yml（应用部署：拉取镜像/更新 compose 文件/滚动重启），monitor-setup.yml（安装 node_exporter + fluent-bit）。Ansible Vault 加密所有密钥和密码。执行策略：变更先在 staging 跑一遍（--check 模式预演），确认无误后在 production 执行（每次最多 2 台，serial: 2）。所有 playbook 执行日志记录到 ELK。`,
      ],
    });

    const fullSession3 = mkSession("full-unrelated");
    cases.push({
      id: "full-company-event",
      label: "Full: unrelated (company annual party)",
      sessionId: fullSession3,
      group: "dedup",
      messages: [
        `公司年会安排确定了。时间：12 月 20 日（周六）下午 2 点到晚上 9 点。地点：杭州西湖国宾馆 3 号楼宴会厅，可容纳 300 人。议程：2:00-3:00 CEO 年度总结和明年规划，3:00-4:30 各部门优秀项目展示（每组 10 分钟），4:30-5:00 茶歇，5:00-6:30 年度颁奖（最佳团队、最佳个人、最佳新人、创新奖），6:30-9:00 晚宴 + 文艺表演 + 抽奖。每个部门需要准备至少一个节目，节目清单 12 月 10 日前提交给 HR 小王。预算：人均 500 元。`,
      ],
    });
    cases.push({
      id: "full-training",
      label: "Full: unrelated (new employee training)",
      sessionId: fullSession3,
      group: "dedup",
      messages: [
        `新员工入职培训计划（为期两周）。第一周：Day 1 公司文化和价值观介绍、HR 制度讲解、IT 账号开通；Day 2-3 技术栈总览（架构图、代码仓库结构、本地开发环境搭建）；Day 4 编码规范培训（TypeScript 规范、ESLint 规则、命名约定、文件组织）；Day 5 Git 工作流培训（Git Flow、分支命名、Commit Message 规范、MR 流程）。第二周：Day 6-7 跟随导师做一个入门任务（小 feature 开发）；Day 8-9 Code Review 流程实践（参加 Review Session、自己提交 MR 被 review）；Day 10 入职考核（代码 quiz + 流程问答 + 导师评价）。`,
      ],
    });
  }

  return cases;
}

// ─── Search cases ───

interface SearchCase {
  query: string;
  expectKeyword: string;
  category: "keyword" | "semantic" | "negative" | "recall";
  topK: number;
  minScore?: number;
  shouldFind: boolean;
}

function buildSearchCases(): SearchCase[] {
  const cases: SearchCase[] = [
    { query: "MySQL InnoDB MVCC 行锁 innodb_buffer_pool_size", expectKeyword: "InnoDB", category: "keyword", topK: 5, shouldFind: true },
    { query: "Kubernetes ECS 阿里云 容器集群 Calico", expectKeyword: "Kubernetes", category: "keyword", topK: 5, shouldFind: true },
    { query: "Prometheus Grafana AlertManager 监控告警", expectKeyword: "Prometheus", category: "keyword", topK: 5, shouldFind: true },
    { query: "ELK Elasticsearch Logstash Kibana 日志", expectKeyword: "Elasticsearch", category: "keyword", topK: 5, shouldFind: true },

    { query: "数据库事务隔离级别和并发控制机制", expectKeyword: "MVCC", category: "semantic", topK: 5, shouldFind: true },
    { query: "容器编排平台和自动扩容策略", expectKeyword: "Kubernetes", category: "semantic", topK: 5, shouldFind: true },
    { query: "代码质量审查团队协作流程", expectKeyword: "Review", category: "semantic", topK: 5, shouldFind: true },
    { query: "应用日志集中采集存储和检索", expectKeyword: "ELK", category: "semantic", topK: 5, shouldFind: true },

    { query: "深度学习 PyTorch GPU 训练模型 CUDA 显存", expectKeyword: "MySQL", category: "negative", topK: 5, minScore: 0.65, shouldFind: false },
    { query: "量化交易策略回测 Alpha 因子挖掘", expectKeyword: "Kubernetes", category: "negative", topK: 5, minScore: 0.65, shouldFind: false },

    { query: "CI/CD 流水线 自动化部署 发布流程", expectKeyword: "Jenkins", category: "recall", topK: 10, shouldFind: true },
    { query: "基础设施即代码 IaC 云资源管理", expectKeyword: "Terraform", category: "recall", topK: 10, shouldFind: true },
    { query: "Docker Compose 本地开发环境 容器编排", expectKeyword: "Docker", category: "recall", topK: 5, shouldFind: true },
  ];

  if (FULL_MODE) {
    cases.push(
      { query: "API 接口文档自动生成 Swagger OpenAPI", expectKeyword: "Swagger", category: "keyword", topK: 5, shouldFind: true },
      { query: "数据库定时备份恢复策略 mysqldump", expectKeyword: "备份", category: "keyword", topK: 5, shouldFind: true },
      { query: "React 性能优化 Lighthouse 代码分割", expectKeyword: "React", category: "keyword", topK: 5, shouldFind: true },
      { query: "代码质量门禁覆盖率重复率检测", expectKeyword: "SonarQube", category: "recall", topK: 10, shouldFind: true },
      { query: "服务器批量配置管理自动化运维 Playbook", expectKeyword: "Ansible", category: "recall", topK: 10, shouldFind: true },
    );
  }

  return cases;
}

// ─── Register sessions into OpenClaw sessions.json so they appear in UI dropdown ───

function registerSessionsInStore(cases: ConversationCase[]) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const storePath = path.join(home, ".openclaw", "agents", "main", "sessions", "sessions.json");
  if (!fs.existsSync(storePath)) {
    log("[WARN] sessions.json not found, skipping UI registration");
    return;
  }

  const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
  const sessionsDir = path.dirname(storePath);
  const seen = new Set<string>();
  let added = 0;

  for (const c of cases) {
    if (seen.has(c.sessionId)) continue;
    seen.add(c.sessionId);

    const storeKey = `agent:main:${c.sessionId}`;
    if (store[storeKey]) continue;

    const sessionFile = path.join(sessionsDir, `${c.sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) continue;

    // acc-1773286763918-dedup-exact-1 -> dedup-exact
    const shortName = c.sessionId
      .replace(/^acc-\d+-/, "")
      .replace(/-\d+$/, "");

    store[storeKey] = {
      sessionId: c.sessionId,
      updatedAt: Date.now(),
      systemSent: true,
      abortedLastRun: false,
      chatType: "direct",
      label: `[test] ${shortName}`,
      displayName: `Test: ${shortName}`,
      origin: {
        provider: "cli",
        surface: "cli",
        chatType: "direct",
        label: `accuracy-test:${shortName}`,
      },
      sessionFile,
    };
    added++;
  }

  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
  log(`Registered ${added} test sessions in sessions.json (UI dropdown)`);
}

// ─── Ingest via Gateway ───

async function ingestPhase(cases: ConversationCase[]) {
  const totalMsgs = cases.reduce((a, c) => a + c.messages.length, 0);
  log(`Sending ${cases.length} conversations (${totalMsgs} messages) through OpenClaw Gateway...`);
  log(`(Each message goes through full gateway → plugin pipeline, visible in Viewer)\n`);

  const tracker = new ProgressTracker("Ingest", totalMsgs);
  const buckets: ConversationCase[][] = Array.from({ length: WORKERS }, () => []);
  cases.forEach((c, i) => buckets[i % WORKERS].push(c));

  let successCount = 0;
  let failCount = 0;

  const workerFn = async (workerId: number, bucket: ConversationCase[]) => {
    for (const c of bucket) {
      for (const msg of c.messages) {
        const ok = sendViaGateway(c.sessionId, msg);
        if (ok) {
          successCount++;
        } else {
          failCount++;
        }
        tracker.tick(`${ok ? "OK" : "FAIL"} ${c.label}`);
        await new Promise((r) => setTimeout(r, INGEST_DELAY_MS));
      }
    }
  };

  const t0 = performance.now();
  await Promise.all(
    buckets.map((b, i) => (b.length > 0 ? workerFn(i + 1, b) : Promise.resolve())),
  );
  const dur = Math.round(performance.now() - t0);

  log(`\nIngest complete: ${successCount} sent, ${failCount} failed (${(dur / 1000).toFixed(1)}s)\n`);

  log("Waiting 10s for ingest pipeline to process all messages...");
  await new Promise((r) => setTimeout(r, 10_000));

  registerSessionsInStore(cases);

  return { successCount, failCount };
}

// ─── Verify phase ───

async function runSearchTests(plugin: MemosLocalPlugin, cases: SearchCase[], tracker: ProgressTracker) {
  const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

  for (const c of cases) {
    const t0 = performance.now();
    const result = (await searchTool.handler({
      query: c.query,
      maxResults: c.topK,
      minScore: c.minScore,
    })) as any;
    const dur = Math.round(performance.now() - t0);
    const hits = result.hits ?? [];
    const found = hitContains(hits, c.expectKeyword);

    if (c.category === "negative") {
      const pass = !found;
      results.push({
        category: "Precision",
        name: `negative: "${c.query.slice(0, 25)}..."`,
        pass,
        detail: `should NOT contain "${c.expectKeyword}": ${pass ? "OK" : "FAIL"} (${hits.length} hits)`,
        durationMs: dur,
      });
    } else if (c.category === "keyword") {
      results.push({
        category: "Precision",
        name: `keyword: ${c.expectKeyword}`,
        pass: found,
        detail: `top${c.topK} contains "${c.expectKeyword}": ${found}`,
        durationMs: dur,
      });
    } else if (c.category === "semantic") {
      results.push({
        category: "Precision",
        name: `semantic: ${c.expectKeyword}`,
        pass: found,
        detail: `top${c.topK} contains "${c.expectKeyword}": ${found}`,
        durationMs: dur,
      });
    } else if (c.category === "recall") {
      results.push({
        category: "Recall",
        name: `recall: ${c.expectKeyword}`,
        pass: found,
        detail: found ? "found" : "missed",
        durationMs: dur,
      });
    }
    tracker.tick(`${c.category}: ${c.expectKeyword}`);
  }
}

async function runDedupChecks(plugin: MemosLocalPlugin, tracker: ProgressTracker) {
  const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

  const t0 = performance.now();
  const r1 = (await searchTool.handler({ query: "Redis ElastiCache 集群 maxmemory allkeys-lru 连接池", maxResults: 10 })) as any;
  const redisHits = (r1.hits ?? []).filter((h: any) => hitContains([h], "Redis") || hitContains([h], "ElastiCache"));
  const exactPass = redisHits.length >= 1 && redisHits.length <= 2;
  results.push({ category: "Dedup", name: "exact dup (Redis x3 → 1-2)", pass: exactPass, detail: `${redisHits.length} active hits (expect 1-2)`, durationMs: Math.round(performance.now() - t0) });
  tracker.tick("dedup: exact dup (Redis)");

  const t1 = performance.now();
  const r2 = (await searchTool.handler({ query: "PostgreSQL RDS PgBouncer 读写分离 WAL", maxResults: 10 })) as any;
  const pgHits = (r2.hits ?? []).filter((h: any) => hitContains([h], "PostgreSQL") || hitContains([h], "PG ") || hitContains([h], "PgBouncer"));
  const semPass = pgHits.length >= 1 && pgHits.length <= 2;
  results.push({ category: "Dedup", name: "semantic dup (PG x2 → 1-2)", pass: semPass, detail: `${pgHits.length} active hits (expect 1-2)`, durationMs: Math.round(performance.now() - t1) });
  tracker.tick("dedup: semantic dup (PG)");

  const t2 = performance.now();
  const r3 = (await searchTool.handler({ query: "前端技术栈 Next.js Shadcn Tailwind Vercel", maxResults: 10 })) as any;
  const hasLatest = hitContains(r3.hits ?? [], "Next.js") || hitContains(r3.hits ?? [], "Shadcn");
  results.push({ category: "Dedup", name: "merge (React/Vite → Next.js/Vercel)", pass: hasLatest, detail: `latest state present: ${hasLatest}`, durationMs: Math.round(performance.now() - t2) });
  tracker.tick("dedup: merge (Next.js)");
}

async function runSummaryChecks(plugin: MemosLocalPlugin, tracker: ProgressTracker) {
  const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

  const queries = [
    { query: "微服务架构 user-service payment-service Istio gRPC", label: "microservices arch" },
    { query: "数据库迁移 MySQL PostgreSQL Debezium CDC 双写", label: "DB migration plan" },
  ];

  for (const q of queries) {
    const t0 = performance.now();
    const r = (await searchTool.handler({ query: q.query, maxResults: 3 })) as any;
    const dur = Math.round(performance.now() - t0);
    if (r.hits?.length > 0) {
      const h = r.hits[0];
      const sl = h.summary?.length ?? 0;
      const cl = h.original_excerpt?.length ?? 999;
      const pass = sl > 0 && sl < cl;
      results.push({ category: "Summary", name: q.label, pass, detail: `summary=${sl}chars, content=${cl}chars, shorter=${sl < cl}`, durationMs: dur });
    } else {
      results.push({ category: "Summary", name: q.label, pass: false, detail: "no hits found", durationMs: dur });
    }
    tracker.tick(`summary: ${q.label}`);
  }
}

async function runTopicChecks(plugin: MemosLocalPlugin, tracker: ProgressTracker) {
  const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

  const t0 = performance.now();
  const nginxR = (await searchTool.handler({ query: "Nginx 反向代理 SSL gzip HTTP/2 HSTS", maxResults: 10 })) as any;
  const nginxHits = (nginxR.hits ?? []).filter((h: any) => hitContains([h], "Nginx") || hitContains([h], "gzip") || hitContains([h], "SSL"));
  results.push({
    category: "Topic",
    name: "same topic merge (Nginx parts → 1 chunk)",
    pass: nginxHits.length >= 1 && nginxHits.length <= 2,
    detail: `${nginxHits.length} chunks (expect 1-2 merged)`,
    durationMs: Math.round(performance.now() - t0),
  });
  tracker.tick("topic: same (Nginx)");

  const t1 = performance.now();
  const dockerR = (await searchTool.handler({ query: "Dockerfile 多阶段构建 pnpm node:20-alpine", maxResults: 5 })) as any;
  const cookR = (await searchTool.handler({ query: "红烧肉 五花肉 冰糖 八角 桂皮", maxResults: 5 })) as any;
  const dockerFound = hitContains(dockerR.hits ?? [], "Dockerfile") || hitContains(dockerR.hits ?? [], "node");
  const cookFound = hitContains(cookR.hits ?? [], "五花肉") || hitContains(cookR.hits ?? [], "红烧肉");
  const switchPass = dockerFound && cookFound;
  results.push({
    category: "Topic",
    name: "topic switch (Docker → cooking)",
    pass: switchPass,
    detail: `Docker found=${dockerFound}, cooking found=${cookFound}`,
    durationMs: Math.round(performance.now() - t1),
  });
  tracker.tick("topic: switch (Docker→cooking)");
}

// ─── Report ───

function printReport(totalMs: number, ingestStats?: { successCount: number; failCount: number }) {
  console.log("\n");
  console.log("=".repeat(70));
  console.log(`  MemOS Accuracy Test Report`);
  console.log(`  Mode: ${FULL_MODE ? "FULL" : "QUICK"}  |  Workers: ${WORKERS}  |  Duration: ${(totalMs / 1000).toFixed(1)}s`);
  if (ingestStats) {
    console.log(`  Ingest: ${ingestStats.successCount} sent via Gateway, ${ingestStats.failCount} failed`);
  }
  console.log("=".repeat(70));

  const categories = [...new Set(results.map((r) => r.category))];
  let totalPass = 0;
  let totalCount = 0;

  for (const cat of categories) {
    const cr = results.filter((r) => r.category === cat);
    const passed = cr.filter((r) => r.pass).length;
    totalPass += passed;
    totalCount += cr.length;
    const pct = ((passed / cr.length) * 100).toFixed(1);
    console.log(`\n  ${cat.padEnd(20)} ${passed}/${cr.length} (${pct}%)`);
    for (const r of cr) {
      const icon = r.pass ? "PASS" : "FAIL";
      console.log(`    [${icon}] ${r.name}: ${r.detail} (${r.durationMs}ms)`);
    }
  }

  console.log("\n" + "-".repeat(70));
  const overallPct = totalCount > 0 ? ((totalPass / totalCount) * 100).toFixed(1) : "0";
  console.log(`  OVERALL: ${totalPass}/${totalCount} (${overallPct}%)`);
  console.log("=".repeat(70));

  return totalPass === totalCount ? 0 : 1;
}

// ─── Main ───

async function main() {
  const t0 = performance.now();
  log("MemOS Accuracy Test starting...");
  log(`Mode: ${FULL_MODE ? "FULL (50+ cases)" : "QUICK (15 cases — pass --full for all)"}`);

  log("Loading OpenClaw config...");
  const config = loadConfig();
  const stateDir = path.join(process.env.HOME ?? "/tmp", ".openclaw");

  let ingestStats: { successCount: number; failCount: number } | undefined;

  if (!SKIP_INGEST) {
    const testCases = buildTestCases();
    const totalMsgs = testCases.reduce((a, c) => a + c.messages.length, 0);
    log(`Prepared ${testCases.length} conversations (${totalMsgs} messages total)`);
    ingestStats = await ingestPhase(testCases);
  } else {
    log("Skipping ingest (--skip-ingest), running search checks only...");
  }

  log("Initializing plugin for search verification (direct DB access)...");
  const plugin = initPlugin({ stateDir, config });

  const searchCases = buildSearchCases();
  const verifyTotal = 3 + 2 + searchCases.length + 2; // dedup(3) + topic(2) + search + summary(2)
  const verifyTracker = new ProgressTracker("Verify", verifyTotal);

  log("Running dedup checks...");
  await runDedupChecks(plugin, verifyTracker);

  log("Running topic boundary checks...");
  await runTopicChecks(plugin, verifyTracker);

  log("Running search precision & recall tests...");
  await runSearchTests(plugin, searchCases, verifyTracker);

  log("Running summary quality checks...");
  await runSummaryChecks(plugin, verifyTracker);

  const totalMs = Math.round(performance.now() - t0);
  const exitCode = printReport(totalMs, ingestStats);

  await plugin.shutdown();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
