/**
 * E2E test: 验证 Summarizer 和 SkillValidator 在 openclaw provider 下的真实模型调用
 *
 * 测试场景：
 *   1. Summarizer.summarize() — openclaw provider → 通过 openclawAPI.complete() 调用宿主模型
 *   2. Summarizer.summarizeTask() — openclaw provider → 通过 openclawAPI.complete() 调用宿主模型
 *   3. Summarizer.judgeNewTopic() — openclaw provider → 通过 openclawAPI.complete() 调用宿主模型
 *   4. Summarizer.filterRelevant() — openclaw provider → 通过 openclawAPI.complete() 调用宿主模型
 *   5. Summarizer.judgeDedup() — openclaw provider → 通过 openclawAPI.complete() 调用宿主模型
 *   6. SkillValidator.assessQuality() — 检查 openclaw provider 是否能正常工作
 *
 * Usage: npx tsx tests/e2e-summarizer-skill.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Summarizer } from "../src/ingest/providers";
import { SkillValidator } from "../src/skill/validator";
import { OpenClawAPIClient, type HostModelsConfig } from "../src/openclaw-api";
import { buildContext } from "../src/config";

// ── Logger ──────────────────────────────────────────────────────────

const log = {
  debug: (...args: unknown[]) => console.log("  [debug]", ...args),
  info: (...args: unknown[]) => console.log("  [info]", ...args),
  warn: (...args: unknown[]) => console.warn("  [warn]", ...args),
  error: (...args: unknown[]) => console.error("  [error]", ...args),
};

// ── Helpers ─────────────────────────────────────────────────────────

function loadHostModels(): HostModelsConfig {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) throw new Error(`Config not found: ${cfgPath}`);
  const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return { providers: config?.models?.providers ?? {} };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

// ── Setup ───────────────────────────────────────────────────────────

function setup() {
  const hostModels = loadHostModels();
  const openclawAPI = new OpenClawAPIClient(log, hostModels);

  // 模拟 capabilities 开启后的 summarizer config
  const summarizerCfg = {
    provider: "openclaw" as const,
    capabilities: { hostCompletion: true, hostEmbedding: false },
  };

  const summarizer = new Summarizer(summarizerCfg as any, log, openclawAPI);

  return { hostModels, openclawAPI, summarizer, summarizerCfg };
}

// ── Test 1: Summarizer.summarize() ──────────────────────────────────

async function test1_summarize(summarizer: Summarizer) {
  console.log("\n═══ Test 1: Summarizer.summarize() via openclaw ═══");

  try {
    const result = await summarizer.summarize(
      "用户问如何在 Docker 中部署 Nginx 反向代理，配置 upstream 到 Node.js 3000 端口。助手提供了完整的 nginx.conf 配置文件和 docker-compose.yml。"
    );

    assert(typeof result === "string", `返回类型: string`);
    assert(result.length > 0, `摘要非空: "${result}"`);
    assert(result.length <= 200, `摘要长度合理: ${result.length} chars`);
    console.log(`  📝 摘要: "${result}"`);
  } catch (err: any) {
    console.error(`  ❌ summarize 失败: ${err.message}`);
    failed++;
  }
}

// ── Test 2: Summarizer.summarizeTask() ──────────────────────────────

async function test2_summarizeTask(summarizer: Summarizer) {
  console.log("\n═══ Test 2: Summarizer.summarizeTask() via openclaw ═══");

  try {
    const conversation = `User: 帮我写一个 Python 脚本，读取 CSV 文件并生成柱状图
Assistant: 好的，我来帮你写。首先安装依赖：pip install pandas matplotlib
然后创建脚本：
\`\`\`python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv('data.csv')
df.plot(kind='bar', x='category', y='value')
plt.savefig('chart.png')
\`\`\`
User: 能加上标题和颜色吗？
Assistant: 当然，加上 plt.title('Sales Report') 和 color='steelblue' 参数即可。`;

    const result = await summarizer.summarizeTask(conversation);

    assert(typeof result === "string", `返回类型: string`);
    assert(result.length > 50, `任务摘要有足够内容: ${result.length} chars`);
    assert(result.includes("📌") || result.includes("Python") || result.includes("CSV"), `摘要包含关键信息`);
    console.log(`  📝 任务摘要 (前200字): "${result.slice(0, 200)}..."`);
  } catch (err: any) {
    console.error(`  ❌ summarizeTask 失败: ${err.message}`);
    failed++;
  }
}

// ── Test 3: Summarizer.judgeNewTopic() ──────────────────────────────

async function test3_judgeNewTopic(summarizer: Summarizer) {
  console.log("\n═══ Test 3: Summarizer.judgeNewTopic() via openclaw ═══");

  try {
    // 同一话题
    const same = await summarizer.judgeNewTopic(
      "用户在讨论 Docker 部署 Nginx 反向代理的配置",
      "那 upstream 的 weight 参数怎么配？"
    );
    assert(same === false, `同一话题判断: ${same} (期望 false)`);

    // 新话题
    const different = await summarizer.judgeNewTopic(
      "用户在讨论 Docker 部署 Nginx 反向代理的配置",
      "帮我写一个 React 登录页面"
    );
    assert(different === true, `新话题判断: ${different} (期望 true)`);
  } catch (err: any) {
    console.error(`  ❌ judgeNewTopic 失败: ${err.message}`);
    failed++;
  }
}

// ── Test 4: Summarizer.filterRelevant() ─────────────────────────────

async function test4_filterRelevant(summarizer: Summarizer) {
  console.log("\n═══ Test 4: Summarizer.filterRelevant() via openclaw ═══");

  try {
    const result = await summarizer.filterRelevant(
      "如何配置 Nginx 反向代理",
      [
        { index: 0, summary: "Docker 部署 Nginx upstream 到 Node.js 3000 端口", role: "assistant" },
        { index: 1, summary: "Python pandas 读取 CSV 生成柱状图", role: "assistant" },
        { index: 2, summary: "Nginx location 配置 proxy_pass 和 headers", role: "assistant" },
      ]
    );

    assert(result !== null, `filterRelevant 返回非 null`);
    if (result) {
      assert(Array.isArray(result.relevant), `relevant 是数组`);
      assert(result.relevant.includes(0), `选中了 Nginx upstream (index 0)`);
      assert(result.relevant.includes(2), `选中了 Nginx proxy_pass (index 2)`);
      assert(!result.relevant.includes(1), `排除了 Python CSV (index 1)`);
      console.log(`  📝 relevant: [${result.relevant}], sufficient: ${result.sufficient}`);
    }
  } catch (err: any) {
    console.error(`  ❌ filterRelevant 失败: ${err.message}`);
    failed++;
  }
}

// ── Test 5: Summarizer.judgeDedup() ─────────────────────────────────

async function test5_judgeDedup(summarizer: Summarizer) {
  console.log("\n═══ Test 5: Summarizer.judgeDedup() via openclaw ═══");

  try {
    // 重复记忆
    const dupResult = await summarizer.judgeDedup(
      "Docker 部署 Nginx 反向代理到 Node.js 3000 端口",
      [
        { index: 0, summary: "Docker 中配置 Nginx upstream 代理到 Node.js 3000 端口", chunkId: "chunk-1" },
        { index: 1, summary: "Python Flask 部署到 Gunicorn", chunkId: "chunk-2" },
      ]
    );

    assert(dupResult !== null, `judgeDedup 返回非 null`);
    if (dupResult) {
      assert(dupResult.action === "DUPLICATE" || dupResult.action === "UPDATE", `判断为 ${dupResult.action} (期望 DUPLICATE 或 UPDATE)`);
      console.log(`  📝 dedup: action=${dupResult.action}, reason=${dupResult.reason}`);
    }

    // 全新记忆
    const newResult = await summarizer.judgeDedup(
      "React 18 useEffect cleanup 函数的最佳实践",
      [
        { index: 0, summary: "Docker 中配置 Nginx upstream 代理到 Node.js 3000 端口", chunkId: "chunk-1" },
      ]
    );

    assert(newResult !== null, `judgeDedup (new) 返回非 null`);
    if (newResult) {
      assert(newResult.action === "NEW", `判断为 ${newResult.action} (期望 NEW)`);
      console.log(`  📝 dedup (new): action=${newResult.action}`);
    }
  } catch (err: any) {
    console.error(`  ❌ judgeDedup 失败: ${err.message}`);
    failed++;
  }
}

// ── Test 6: SkillValidator.assessQuality() ──────────────────────────

async function test6_skillValidator(hostModels: HostModelsConfig) {
  console.log("\n═══ Test 6: SkillValidator.assessQuality() via openclaw ═══");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-e2e-skill-"));

  try {
    // 创建测试 SKILL.md
    const skillDir = path.join(dir, "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: docker-nginx-proxy
description: Deploy Nginx reverse proxy with Docker
version: 1
---

# Docker Nginx Reverse Proxy

## Steps
1. Create nginx.conf with upstream block
2. Configure proxy_pass to backend service
3. Build Docker image with custom nginx.conf
4. Run with docker-compose

## Key Configuration
\`\`\`nginx
upstream backend {
    server app:3000;
}
server {
    listen 80;
    location / {
        proxy_pass http://backend;
    }
}
\`\`\`

## Pitfalls
- Remember to set proxy_set_header Host
- Use docker network for container communication
`, "utf8");

    // buildContext with openclaw capabilities
    const ctx = buildContext(dir, process.cwd(), {
      sharing: {
        capabilities: { hostCompletion: true, hostEmbedding: false },
      },
    }, log, hostModels);

    assert(ctx.config.summarizer?.provider === "openclaw", `summarizer.provider = "${ctx.config.summarizer?.provider}"`);

    const validator = new SkillValidator(ctx);

    // SkillValidator 直接用 cfg.endpoint + cfg.apiKey，不走 openclawAPI
    // 当 provider=openclaw 时，endpoint/apiKey 都是 undefined
    // 这应该会失败或跳过
    const result = await validator.validate(skillDir);

    assert(result.valid === true, `格式验证通过: valid=${result.valid}`);
    console.log(`  📝 qualityScore: ${result.qualityScore}`);
    console.log(`  📝 errors: ${JSON.stringify(result.errors)}`);
    console.log(`  📝 warnings: ${JSON.stringify(result.warnings)}`);

    if (result.qualityScore === null) {
      console.log("  ⚠️  qualityScore 为 null — SkillValidator 没有走 openclawAPI，");
      console.log("     当 provider=openclaw 时 assessQuality 用 cfg.endpoint/apiKey 直接调 HTTP，");
      console.log("     但 openclaw provider 没有这些字段，所以质量评估被跳过了。");
      console.log("     → 这是一个 BUG：SkillValidator 应该像 Summarizer 一样走 openclawAPI.complete()");
      failed++;
    } else {
      assert(result.qualityScore >= 0 && result.qualityScore <= 10, `质量分数合理: ${result.qualityScore}/10`);
    }
  } catch (err: any) {
    console.error(`  ❌ SkillValidator 测试失败: ${err.message}`);
    failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  E2E: Summarizer & Skill 在 openclaw provider 下的模型调用  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const { hostModels, summarizer } = setup();

  await test1_summarize(summarizer);
  await test2_summarizeTask(summarizer);
  await test3_judgeNewTopic(summarizer);
  await test4_filterRelevant(summarizer);
  await test5_judgeDedup(summarizer);
  await test6_skillValidator(hostModels);

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
