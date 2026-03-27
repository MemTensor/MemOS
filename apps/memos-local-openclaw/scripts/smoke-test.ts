/**
 * Smoke Test — 用真实 API 跑通完整链路
 *
 * 用法：
 *   npx tsx scripts/smoke-test.ts
 *
 * 需要先在 .env 中配置好 EMBEDDING / SUMMARIZER 的 key 和 endpoint
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initPlugin } from "../src/index";

// ─── 加载 .env ───
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
}

// ─── 配色输出 ───
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function ok(msg: string) { console.log(`${GREEN}  ✓ ${msg}${RESET}`); }
function fail(msg: string) { console.log(`${RED}  ✗ ${msg}${RESET}`); }
function section(msg: string) { console.log(`\n${BOLD}${CYAN}━━━ ${msg} ━━━${RESET}`); }
function info(msg: string) { console.log(`${YELLOW}  ℹ ${msg}${RESET}`); }

async function main() {
  console.log(`\n${BOLD}🧪 MemOS Local for OpenClaw — Smoke Test${RESET}`);
  console.log(`   Embedding: ${process.env.EMBEDDING_ENDPOINT ?? "local"}`);
  console.log(`   Summarizer: ${process.env.SUMMARIZER_ENDPOINT ?? "rule-based fallback"}`);

  // ─── 1. 初始化插件 ───
  section("1. 初始化插件");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-smoke-"));
  info(`临时数据库目录: ${tmpDir}`);

  const plugin = initPlugin({
    stateDir: tmpDir,
    config: {
      embedding: {
        provider: "openai_compatible",
        endpoint: process.env.EMBEDDING_ENDPOINT,
        apiKey: process.env.EMBEDDING_API_KEY,
        model: process.env.EMBEDDING_MODEL ?? "bge-m3",
      },
      summarizer: {
        provider: "openai_compatible",
        endpoint: process.env.SUMMARIZER_ENDPOINT,
        apiKey: process.env.SUMMARIZER_API_KEY,
        model: process.env.SUMMARIZER_MODEL ?? "gpt-4o-mini",
        temperature: 0,
      },
    },
  });
  ok("插件初始化成功");

  // ─── 2. 写入测试对话 ───
  section("2. 写入测试对话");

  plugin.onConversationTurn([
    {
      role: "user",
      content:
        "我正在把 API 服务部署到 port 8443，用的命令是 `docker compose -f docker-compose.prod.yml up -d`。" +
        "Postgres 密码配在 POSTGRES_PASSWORD 环境变量里。另外 Nginx 反代配置在 /etc/nginx/conf.d/api.conf。",
    },
    {
      role: "assistant",
      content:
        "好的，我帮你确认部署。确保防火墙放行 8443 端口，POSTGRES_PASSWORD 要在 .env 里设置。" +
        "docker-compose.prod.yml 里建议配置 health check，Nginx 反代记得设 proxy_set_header。",
    },
  ], "session-deploy");
  info("第 1 轮: 部署相关对话已入队");

  plugin.onConversationTurn([
    {
      role: "user",
      content:
        "现在来讨论前端。我们用的 Next.js 14 + App Router，入口页是 app/page.tsx，" +
        "数据从 /api/dashboard 接口拉取。样式用的 Tailwind CSS v3.4。",
    },
    {
      role: "assistant",
      content:
        "Next.js 14 App Router 默认用 Server Components，app/page.tsx 可以直接 async fetch。" +
        "/api/dashboard 对应 app/api/dashboard/route.ts。Tailwind 3.4 记得在 tailwind.config.ts 里配 content 路径。",
    },
  ], "session-frontend");
  info("第 2 轮: 前端相关对话已入队");

  plugin.onConversationTurn([
    {
      role: "user",
      content: `构建出错了：
Error: Module not found: Can't resolve '@/components/Chart'
    at ModuleNotFoundError (webpack/lib/ModuleNotFoundError.js:28:12)
    at factorize (webpack/lib/Compilation.js:2045:24)
    at resolve (webpack/lib/NormalModuleFactory.js:439:20)

应该是 tsconfig.json 的 path alias 配错了。`,
    },
    {
      role: "assistant",
      content:
        '这是 @/components/Chart 的 path alias 找不到。检查 tsconfig.json 的 paths 配置：' +
        '"@/*": ["./src/*"]，同时确认 next.config.js 没有覆盖 webpack resolve。',
    },
  ], "session-frontend");
  info("第 3 轮: 报错相关对话已入队");

  // 写入一条带 [STORED_MEMORY] wrapper 的消息，验证防回写
  plugin.onConversationTurn([
    {
      role: "assistant",
      content: "根据记忆 [STORED_MEMORY]旧数据: port 3000[/STORED_MEMORY] 实际端口是 8443。",
    },
  ], "session-deploy");
  info("第 4 轮: 带防回写标记的消息已入队");

  // ─── 等待异步 ingest 完成 ───
  info("等待所有异步写入完成...");
  await plugin.flush();
  ok("所有对话已完成写入（chunking → summary → embedding → 持久化）");

  // ─── 3. 测试 memory_search ───
  section("3. memory_search — 检索部署细节");
  const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

  const r1 = (await searchTool.handler({ query: "docker 部署 端口 8443" })) as any;
  console.log(`   命中 ${r1.hits.length} 条 (minScore=${r1.meta.usedMinScore}, maxResults=${r1.meta.usedMaxResults})`);
  if (r1.hits.length > 0) {
    ok(`Top hit score=${r1.hits[0].score}`);
    info(`Summary: ${r1.hits[0].summary.slice(0, 120)}...`);
    info(`Excerpt: ${r1.hits[0].original_excerpt.slice(0, 120)}...`);
    info(`Ref: session=${r1.hits[0].ref.sessionKey}, chunk=${r1.hits[0].ref.chunkId.slice(0, 8)}...`);
  } else {
    fail("未命中任何结果！检查 embedding API 是否正常");
  }

  section("3b. memory_search — 检索前端细节");
  const r2 = (await searchTool.handler({ query: "Next.js App Router page.tsx" })) as any;
  console.log(`   命中 ${r2.hits.length} 条`);
  if (r2.hits.length > 0) {
    ok(`Top hit score=${r2.hits[0].score}`);
    info(`Excerpt: ${r2.hits[0].original_excerpt.slice(0, 120)}...`);
  } else {
    fail("未命中前端相关结果");
  }

  section("3c. memory_search — 检索报错信息");
  const r3 = (await searchTool.handler({ query: "Module not found Chart component 报错" })) as any;
  console.log(`   命中 ${r3.hits.length} 条`);
  if (r3.hits.length > 0) {
    ok(`Top hit score=${r3.hits[0].score}`);
    info(`Excerpt: ${r3.hits[0].original_excerpt.slice(0, 120)}...`);
  } else {
    fail("未命中报错相关结果");
  }

  section("3d. memory_search — 重复查询检测");
  const r4 = (await searchTool.handler({ query: "docker 部署 端口 8443" })) as any;
  if (r4.meta.note && r4.meta.note.includes("already")) {
    ok(`重复查询检测生效: "${r4.meta.note.slice(0, 80)}..."`);
  } else {
    info("重复查询检测未触发（可能参数不完全相同）");
  }

  // ─── 4. 测试 memory_timeline ───
  section("4. memory_timeline — 拉邻近上下文");
  if (r1.hits.length > 0) {
    const timelineTool = plugin.tools.find((t) => t.name === "memory_timeline")!;
    const tl = (await timelineTool.handler({ ref: r1.hits[0].ref, window: 2 })) as any;
    console.log(`   拉到 ${tl.entries.length} 条相邻上下文`);
    for (const entry of tl.entries) {
      const tag = entry.relation === "current" ? "→" : " ";
      info(`${tag} [${entry.relation}] ${entry.role}: ${entry.excerpt.slice(0, 80)}...`);
    }
    ok("Timeline 返回正常");
  } else {
    info("跳过（无 search hit 可用）");
  }

  // ─── 5. 测试 memory_get ───
  section("5. memory_get — 获取完整原文");
  if (r1.hits.length > 0) {
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;
    const g = (await getTool.handler({ ref: r1.hits[0].ref, maxChars: 500 })) as any;
    ok(`获取到 ${g.content.length} 字符原文`);
    info(`原文: ${g.content.slice(0, 150)}...`);
    info(`Source: ts=${new Date(g.source.ts).toISOString()}, role=${g.source.role}`);
  } else {
    info("跳过（无 search hit 可用）");
  }

  // ─── 6. 验证防回写 ───
  section("6. 防回写验证");
  const r5 = (await searchTool.handler({ query: "旧数据 port 3000" })) as any;
  let antiWritebackOk = true;
  for (const hit of r5.hits) {
    if (hit.original_excerpt.includes("[STORED_MEMORY]") || hit.original_excerpt.includes("旧数据: port 3000")) {
      fail(`检测到回写内容泄漏: ${hit.original_excerpt.slice(0, 80)}`);
      antiWritebackOk = false;
    }
  }
  if (antiWritebackOk) {
    ok("防回写验证通过 — [STORED_MEMORY] 包裹的内容未入库");
  }

  // ─── 清理 ───
  section("🏁 测试结束");
  plugin.shutdown();

  const passed = [r1.hits.length > 0, r2.hits.length > 0, r3.hits.length > 0, antiWritebackOk];
  const total = passed.length;
  const passCount = passed.filter(Boolean).length;
  console.log(`\n${BOLD}   结果: ${passCount}/${total} 核心场景通过${RESET}`);

  if (passCount === total) {
    console.log(`${GREEN}${BOLD}   🎉 全部通过！插件可以正式接入 OpenClaw 使用了。${RESET}\n`);
  } else {
    console.log(`${YELLOW}${BOLD}   ⚠ 部分场景未通过，请检查上方输出。${RESET}\n`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(passCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}Fatal error: ${err}${RESET}`);
  process.exit(1);
});
