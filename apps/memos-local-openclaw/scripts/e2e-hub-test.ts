/**
 * E2E Hub-Client 真实测试
 *
 * 在同一台机器上模拟 Hub（已通过 OpenClaw gateway 启动）+ Client 角色
 * 测试完整的 join → memory写入 → 共享搜索 → task共享 → skill发布 流程
 *
 * 用法：
 *   npx tsx scripts/e2e-hub-test.ts
 *
 * 前提：
 *   - OpenClaw gateway 已启动，Hub 在 18800 端口运行
 *   - openclaw.json 中 sharing.role = "hub", teamToken = "test-team-token-2026"
 */

import http from "http";

const HUB_URL = "http://127.0.0.1:18800";
const TEAM_TOKEN = "test-team-token-2026";

// ─── 配色输出 ───
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function ok(msg: string) { console.log(`${GREEN}  ✓ ${msg}${RESET}`); }
function fail(msg: string) { console.log(`${RED}  ✗ ${msg}${RESET}`); }
function section(msg: string) { console.log(`\n${BOLD}${CYAN}━━━ ${msg} ━━━${RESET}`); }
function info(msg: string) { console.log(`${YELLOW}  ℹ ${msg}${RESET}`); }
function detail(msg: string) { console.log(`${DIM}    ${msg}${RESET}`); }

// ─── HTTP 请求工具 ───
async function request(
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, HUB_URL);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    ok(msg);
    passed++;
  } else {
    fail(msg);
    failed++;
  }
}

async function main() {
  console.log(`\n${BOLD}🧪 MemOS Local OpenClaw — E2E Hub-Client 真实测试${RESET}`);
  console.log(`   Hub: ${HUB_URL}`);
  console.log(`   Team Token: ${TEAM_TOKEN.slice(0, 8)}...`);

  // ═══════════════════════════════════════════
  // 1. Hub 健康检查
  // ═══════════════════════════════════════════
  section("1. Hub 健康检查");
  const hubInfo = await request("GET", "/api/v1/hub/info");
  assert(hubInfo.status === 200, `Hub 返回 200`);
  assert(hubInfo.data.teamName === "MemOS-Test-Team", `团队名: ${hubInfo.data.teamName}`);
  assert(hubInfo.data.apiVersion === "v1", `API 版本: ${hubInfo.data.apiVersion}`);
  detail(JSON.stringify(hubInfo.data));

  // ═══════════════════════════════════════════
  // 2. Client A 加入团队（模拟第一台机器）
  // ═══════════════════════════════════════════
  section("2. Client A 加入团队");
  const runId = Date.now().toString(36);
  const joinA = await request("POST", "/api/v1/hub/join", {
    teamToken: TEAM_TOKEN,
    username: `alice-${runId}`,
    deviceName: "Alice-MacBook-Pro",
  });
  assert(joinA.status === 200, `Client A join 成功`);
  assert(joinA.data.status === "active", `Client A 状态: ${joinA.data.status}`);
  assert(!!joinA.data.userToken, `Client A 获得 userToken`);
  const tokenA = joinA.data.userToken;
  const userIdA = joinA.data.userId;
  detail(`userId: ${userIdA}`);
  detail(`token: ${tokenA ? tokenA.slice(0, 30) + "..." : "N/A"}`);

  // ═══════════════════════════════════════════
  // 3. Client B 加入团队（模拟第二台机器）
  // ═══════════════════════════════════════════
  section("3. Client B 加入团队");
  const joinB = await request("POST", "/api/v1/hub/join", {
    teamToken: TEAM_TOKEN,
    username: `bob-${runId}`,
    deviceName: "Bob-Linux-Desktop",
  });
  assert(joinB.status === 200, `Client B join 成功`);
  assert(joinB.data.status === "active", `Client B 状态: ${joinB.data.status}`);
  const tokenB = joinB.data.userToken;
  const userIdB = joinB.data.userId;
  detail(`userId: ${userIdB}`);

  // ═══════════════════════════════════════════
  // 4. 错误的 team token 应该被拒绝
  // ═══════════════════════════════════════════
  section("4. 无效 team token 测试");
  const joinBad = await request("POST", "/api/v1/hub/join", {
    teamToken: "wrong-token",
    username: "hacker",
  });
  assert(joinBad.status === 403, `无效 token 被拒绝 (${joinBad.status})`);
  assert(joinBad.data.error === "invalid_team_token", `错误信息: ${joinBad.data.error}`);

  // ═══════════════════════════════════════════
  // 5. 获取用户信息 (/me)
  // ═══════════════════════════════════════════
  section("5. 获取用户信息");
  const meA = await request("GET", "/api/v1/hub/me", undefined, tokenA);
  assert(meA.status === 200, `Client A /me 成功`);
  assert(meA.data.username === `alice-${runId}`, `用户名: ${meA.data.username}`);
  assert(meA.data.role === "member", `角色: ${meA.data.role}`);
  assert(meA.data.status === "active", `状态: ${meA.data.status}`);
  detail(JSON.stringify(meA.data, null, 2));

  // 无 token 应该 401
  const meNoAuth = await request("GET", "/api/v1/hub/me");
  assert(meNoAuth.status === 401, `无 token 访问 /me 返回 401`);

  // ═══════════════════════════════════════════
  // 6. Client A 共享一个 Task + Chunks
  // ═══════════════════════════════════════════
  section("6. Client A 共享 Task");
  const taskId = `task-${Date.now()}`;
  const chunk1Id = `chunk-1-${Date.now()}`;
  const chunk2Id = `chunk-2-${Date.now()}`;

  const now = Date.now();
  const shareResult = await request(
    "POST",
    "/api/v1/hub/tasks/share",
    {
      task: {
        id: taskId,
        sourceTaskId: taskId,
        title: "部署 API 服务到生产环境",
        summary: "使用 Docker Compose 部署 Node.js API 到 port 8443",
        groupId: null,
        visibility: "public",
        createdAt: now,
        updatedAt: now,
      },
      chunks: [
        {
          id: chunk1Id,
          hubTaskId: taskId,
          sourceTaskId: taskId,
          sourceChunkId: chunk1Id,
          content:
            "我正在把 API 服务部署到 port 8443，用的命令是 docker compose -f docker-compose.prod.yml up -d。" +
            "Postgres 密码配在 POSTGRES_PASSWORD 环境变量里。Nginx 反代配置在 /etc/nginx/conf.d/api.conf。",
          summary: "Docker Compose 部署 API 到 8443 端口，Postgres + Nginx 反代",
          role: "user",
          kind: "conversation",
          createdAt: now,
        },
        {
          id: chunk2Id,
          hubTaskId: taskId,
          sourceTaskId: taskId,
          sourceChunkId: chunk2Id,
          content:
            "确保防火墙放行 8443 端口，POSTGRES_PASSWORD 要在 .env 里设置。" +
            "docker-compose.prod.yml 里建议配置 health check，Nginx 反代记得设 proxy_set_header。",
          summary: "部署注意事项：防火墙、环境变量、health check、Nginx header",
          role: "assistant",
          kind: "conversation",
          createdAt: now,
        },
      ],
    },
    tokenA,
  );
  assert(shareResult.status === 200, `Task 共享成功`);
  assert(shareResult.data.chunks === 2, `共享了 ${shareResult.data.chunks} 个 chunks`);

  // ═══════════════════════════════════════════
  // 7. Client B 搜索 Hub 上的共享内容
  // ═══════════════════════════════════════════
  section("7. Client B 搜索共享内容");
  const searchResult = await request(
    "POST",
    "/api/v1/hub/search",
    { query: "docker 部署 API 端口", maxResults: 5 },
    tokenB,
  );
  assert(searchResult.status === 200, `搜索请求成功`);
  assert(searchResult.data.hits.length > 0, `搜索到 ${searchResult.data.hits.length} 条结果`);

  if (searchResult.data.hits.length > 0) {
    const topHit = searchResult.data.hits[0];
    detail(`Top hit: ${topHit.summary}`);
    detail(`Owner: ${topHit.ownerName}, Task: ${topHit.taskTitle}`);
    detail(`Excerpt: ${topHit.excerpt.slice(0, 100)}...`);
    detail(`remoteHitId: ${topHit.remoteHitId}`);

    // ═══════════════════════════════════════════
    // 8. Client B 获取共享内容详情
    // ═══════════════════════════════════════════
    section("8. Client B 获取内容详情");
    const detailResult = await request(
      "POST",
      "/api/v1/hub/memory-detail",
      { remoteHitId: topHit.remoteHitId },
      tokenB,
    );
    assert(detailResult.status === 200, `获取详情成功`);
    assert(!!detailResult.data.content, `内容不为空`);
    assert(!!detailResult.data.summary, `摘要不为空`);
    detail(`Content: ${detailResult.data.content.slice(0, 120)}...`);
    detail(`Summary: ${detailResult.data.summary}`);

    // 用 Client A 的 token 去获取 Client B 的 remoteHitId 应该被拒绝
    const crossDetail = await request(
      "POST",
      "/api/v1/hub/memory-detail",
      { remoteHitId: topHit.remoteHitId },
      tokenA,
    );
    assert(crossDetail.status === 403, `跨用户获取详情被拒绝 (${crossDetail.status})`);
  }

  // ═══════════════════════════════════════════
  // 9. Client A 发布 Skill
  // ═══════════════════════════════════════════
  section("9. Client A 发布 Skill");
  const skillPublish = await request(
    "POST",
    "/api/v1/hub/skills/publish",
    {
      metadata: {
        id: "deploy-helper-skill",
        name: "Deploy Helper",
        description: "帮助团队成员快速部署 Docker 服务",
        version: 1,
        qualityScore: 85,
      },
      visibility: "public",
      bundle: {
        instructions: "当用户需要部署服务时，使用 docker compose 命令...",
        examples: ["docker compose up -d", "docker compose logs -f"],
      },
    },
    tokenA,
  );
  assert(skillPublish.status === 200, `Skill 发布成功`);
  assert(!!skillPublish.data.skillId, `获得 skillId: ${skillPublish.data.skillId}`);
  assert(skillPublish.data.visibility === "public", `可见性: ${skillPublish.data.visibility}`);
  const publishedSkillId = skillPublish.data.skillId;

  // ═══════════════════════════════════════════
  // 10. Client B 搜索 Hub Skills
  // ═══════════════════════════════════════════
  section("10. Client B 搜索 Skills");
  const skillSearch = await request(
    "GET",
    "/api/v1/hub/skills?query=deploy&maxResults=5",
    undefined,
    tokenB,
  );
  assert(skillSearch.status === 200, `Skill 搜索成功`);
  assert(skillSearch.data.hits.length > 0, `搜索到 ${skillSearch.data.hits.length} 个 skills`);

  if (skillSearch.data.hits.length > 0) {
    const topSkill = skillSearch.data.hits[0];
    detail(`Skill: ${topSkill.name} — ${topSkill.description}`);
    detail(`Owner: ${topSkill.ownerName}, Quality: ${topSkill.qualityScore}`);

    // ═══════════════════════════════════════════
    // 11. Client B 拉取 Skill Bundle
    // ═══════════════════════════════════════════
    section("11. Client B 拉取 Skill Bundle");
    const skillBundle = await request(
      "GET",
      `/api/v1/hub/skills/${publishedSkillId}/bundle`,
      undefined,
      tokenB,
    );
    assert(skillBundle.status === 200, `Skill bundle 获取成功`);
    assert(skillBundle.data.metadata?.name === "Deploy Helper", `Skill 名称正确`);
    assert(!!skillBundle.data.bundle?.instructions, `Bundle 包含 instructions`);
    detail(`Bundle: ${JSON.stringify(skillBundle.data.bundle).slice(0, 120)}...`);
  }

  // ═══════════════════════════════════════════
  // 12. Group 管理测试（需要 admin token）
  // ═══════════════════════════════════════════
  section("12. Group 管理（使用 Hub admin）");

  // 先获取 admin token — 从 hub-auth.json 读取
  let adminToken: string | undefined;
  try {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    // OpenClaw 的 stateDir 通常在 ~/.openclaw/state/memos-local-openclaw-plugin/
    const possiblePaths = [
      path.join(os.homedir(), ".openclaw", "hub-auth.json"),
      path.join(os.homedir(), ".openclaw", "state", "memos-local-openclaw-plugin", "hub-auth.json"),
      path.join(os.homedir(), ".openclaw", "data", "memos-local-openclaw-plugin", "hub-auth.json"),
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const authState = JSON.parse(fs.readFileSync(p, "utf8"));
        adminToken = authState.bootstrapAdminToken;
        info(`找到 admin token from ${p}`);
        break;
      }
    }
  } catch {}

  if (adminToken) {
    // 创建 group
    const createGroup = await request(
      "POST",
      "/api/v1/hub/groups",
      { name: "backend-team", description: "后端开发组" },
      adminToken,
    );
    assert(createGroup.status === 201, `创建 group 成功`);
    const groupId = createGroup.data.id;
    detail(`Group ID: ${groupId}`);

    // 添加 Client A 到 group
    const addMember = await request(
      "POST",
      `/api/v1/hub/groups/${groupId}/members`,
      { userId: userIdA },
      adminToken,
    );
    assert(addMember.status === 200, `添加 Client A 到 group`);

    // 查看 group 详情
    const groupDetail = await request(
      "GET",
      `/api/v1/hub/groups/${groupId}`,
      undefined,
      tokenA,
    );
    assert(groupDetail.status === 200, `查看 group 详情`);
    detail(`Group: ${groupDetail.data.name}, Members: ${groupDetail.data.members?.length}`);

    // 列出所有 groups
    const listGroups = await request("GET", "/api/v1/hub/groups", undefined, tokenA);
    assert(listGroups.status === 200, `列出 groups: ${listGroups.data.groups?.length} 个`);

    // Admin 列出所有用户
    const listUsers = await request("GET", "/api/v1/hub/admin/users", undefined, adminToken);
    assert(listUsers.status === 200, `Admin 列出用户: ${listUsers.data.users?.length} 个`);
    for (const u of listUsers.data.users || []) {
      detail(`  User: ${u.username} (${u.role}, ${u.status})`);
    }

    // Admin 列出共享 tasks
    const listTasks = await request("GET", "/api/v1/hub/admin/shared-tasks", undefined, adminToken);
    assert(listTasks.status === 200, `Admin 列出共享 tasks: ${listTasks.data.tasks?.length} 个`);

    // Admin 列出共享 skills
    const listSkills = await request("GET", "/api/v1/hub/admin/shared-skills", undefined, adminToken);
    assert(listSkills.status === 200, `Admin 列出共享 skills: ${listSkills.data.skills?.length} 个`);

    // 非 admin 不能创建 group
    const nonAdminGroup = await request(
      "POST",
      "/api/v1/hub/groups",
      { name: "hacker-group" },
      tokenB,
    );
    assert(nonAdminGroup.status === 403, `非 admin 创建 group 被拒绝`);
  } else {
    info("未找到 admin token，跳过 group 管理测试");
    info("可能的路径: ~/.openclaw/state/memos-local-openclaw-plugin/hub-auth.json");
  }

  // ═══════════════════════════════════════════
  // 13. Task 取消共享
  // ═══════════════════════════════════════════
  section("13. Task 取消共享");
  const unshare = await request(
    "POST",
    "/api/v1/hub/tasks/unshare",
    { sourceTaskId: taskId },
    tokenA,
  );
  assert(unshare.status === 200, `Task 取消共享成功`);

  // 取消后搜索应该找不到了
  const searchAfterUnshare = await request(
    "POST",
    "/api/v1/hub/search",
    { query: "docker 部署 API 端口", maxResults: 5 },
    tokenB,
  );
  const stillFound = searchAfterUnshare.data.hits?.some(
    (h: any) => h.taskTitle === "部署 API 服务到生产环境",
  );
  assert(!stillFound, `取消共享后搜索不到该 task`);

  // ═══════════════════════════════════════════
  // 14. Skill 取消发布
  // ═══════════════════════════════════════════
  section("14. Skill 取消发布");
  const unpublish = await request(
    "POST",
    "/api/v1/hub/skills/unpublish",
    { sourceSkillId: "deploy-helper-skill" },
    tokenA,
  );
  assert(unpublish.status === 200, `Skill 取消发布成功`);

  // 取消后搜索应该找不到了
  const skillSearchAfter = await request(
    "GET",
    "/api/v1/hub/skills?query=deploy&maxResults=5",
    undefined,
    tokenB,
  );
  assert(
    skillSearchAfter.data.hits?.length === 0,
    `取消发布后搜索不到该 skill`,
  );

  // ═══════════════════════════════════════════
  // 15. Rate Limiting 测试
  // ═══════════════════════════════════════════
  section("15. Rate Limiting 测试");
  info("连续发送 35 次搜索请求（限制 30/分钟）...");
  let rateLimited = false;
  for (let i = 0; i < 35; i++) {
    const r = await request(
      "POST",
      "/api/v1/hub/search",
      { query: `test query ${i}`, maxResults: 1 },
      tokenA,
    );
    if (r.status === 429) {
      rateLimited = true;
      info(`第 ${i + 1} 次请求被限流`);
      break;
    }
  }
  assert(rateLimited, `Rate limiting 生效`);

  // ═══════════════════════════════════════════
  // 结果汇总
  // ═══════════════════════════════════════════
  section("🏁 测试结果");
  const total = passed + failed;
  console.log(`\n${BOLD}   通过: ${GREEN}${passed}${RESET}${BOLD} / ${total}${RESET}`);
  if (failed > 0) {
    console.log(`${BOLD}   失败: ${RED}${failed}${RESET}${BOLD} / ${total}${RESET}`);
  }

  if (failed === 0) {
    console.log(`\n${GREEN}${BOLD}   🎉 全部通过！Hub-Client 端到端测试完成。${RESET}\n`);
  } else {
    console.log(`\n${YELLOW}${BOLD}   ⚠ 有 ${failed} 个测试未通过，请检查上方输出。${RESET}\n`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}Fatal error: ${err}${RESET}`);
  process.exit(1);
});
