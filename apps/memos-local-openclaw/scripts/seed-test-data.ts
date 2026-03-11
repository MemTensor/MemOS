/**
 * Seed script: inserts test data for Task-related features into the live database.
 *
 * Usage:  npx tsx scripts/seed-test-data.ts
 *
 * After running, open Memory Viewer (http://127.0.0.1:18799/) and check:
 *   - Tasks page: 4 tasks (3 completed, 1 active)
 *   - Memories page: chunks associated with each task
 *   - Analytics: totals reflect new data
 */

import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import * as path from "path";
import * as os from "os";

const DB_PATH = path.join(os.homedir(), ".openclaw", "memos-local", "memos.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const now = Date.now();
const HOUR = 3600_000;
const MIN = 60_000;

// ─── Task 1: TypeScript 防抖节流（3小时前完成） ───
const task1Id = uuid();
const session1 = "test-session-debounce";
const task1Start = now - 3 * HOUR;

const task1Chunks = [
  { role: "user",      content: "用 TypeScript 写一个防抖函数 debounce，支持 leading 和 trailing 选项。", summary: "用户请求：用 TS 写防抖函数 debounce，支持 leading/trailing", offset: 0 },
  { role: "assistant", content: `好的，下面是一个支持 leading 和 trailing 选项的 TypeScript 防抖函数：

\`\`\`typescript
type DebounceOptions = {
  leading?: boolean;
  trailing?: boolean;
};

function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number,
  options: DebounceOptions = { leading: false, trailing: true }
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  return function (this: any, ...args: Parameters<T>) {
    const isFirstCall = timer === null;
    lastArgs = args;

    if (options.leading && isFirstCall) {
      fn.apply(this, args);
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (options.trailing && lastArgs) {
        fn.apply(this, lastArgs);
      }
      timer = null;
      lastArgs = null;
    }, delay);
  };
}
\`\`\`

这个实现支持 \`leading\`（首次立即执行）和 \`trailing\`（延迟后执行）两种模式。默认只开启 trailing。`, summary: "AI 提供了完整的 TypeScript debounce 实现，支持 leading/trailing", offset: 1 },
  { role: "user",      content: "再写一个节流 throttle，和 debounce 一起导出。", summary: "用户请求：写 throttle 函数，和 debounce 一起导出", offset: 3 },
  { role: "assistant", content: `好的，下面是 throttle 实现，和 debounce 一起导出：

\`\`\`typescript
function throttle<T extends (...args: any[]) => any>(
  fn: T,
  interval: number
): (...args: Parameters<T>) => void {
  let lastTime = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now();
    const remaining = interval - (now - lastTime);

    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      lastTime = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastTime = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

export { debounce, throttle };
\`\`\``, summary: "AI 提供了 throttle 实现，并将 debounce/throttle 一起导出", offset: 4 },
  { role: "user",      content: "给这两个函数各写一个单元测试。", summary: "用户请求：为 debounce 和 throttle 写单元测试", offset: 6 },
  { role: "assistant", content: `以下是使用 vitest 的测试：

\`\`\`typescript
import { describe, it, expect, vi } from 'vitest';
import { debounce, throttle } from './utils';

describe('debounce', () => {
  it('should delay execution', async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced(); debounced(); debounced();
    expect(fn).not.toHaveBeenCalled();
    await new Promise(r => setTimeout(r, 150));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('throttle', () => {
  it('should limit call frequency', async () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled(); throttled(); throttled();
    expect(fn).toHaveBeenCalledTimes(1);
    await new Promise(r => setTimeout(r, 150));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
\`\`\``, summary: "AI 提供了 debounce 和 throttle 的 vitest 单元测试", offset: 7 },
];

// ─── Task 2: 红烧肉菜谱（2小时前完成，同一 session，换话题） ───
const task2Id = uuid();
const task2Start = now - 2 * HOUR;

const task2Chunks = [
  { role: "user",      content: "我想学做红烧肉，需要准备哪些食材和步骤？", summary: "用户请求：红烧肉的食材和做法步骤", offset: 0 },
  { role: "assistant", content: `红烧肉的做法如下：

**食材**
- 五花肉 500g（选三层肉最佳）
- 冰糖 30g
- 生抽 2勺、老抽 1勺
- 料酒 2勺
- 葱段、姜片、八角 2个、桂皮 1小段

**步骤**
1. 五花肉切 3cm 方块，冷水下锅焯水，撇去浮沫，捞出洗净。
2. 锅中放少量油，小火放入冰糖，炒至枣红色糖色。
3. 放入五花肉翻炒上色，加入葱姜、八角、桂皮。
4. 加入料酒、生抽、老抽翻炒均匀。
5. 加入没过肉的热水，大火烧开后转小火炖 60 分钟。
6. 最后大火收汁至浓稠即可。

小贴士：全程不要加盐，生抽和老抽的咸度已经足够。`, summary: "AI 提供了红烧肉完整做法：食材清单 + 6 步骤 + 小贴士", offset: 0 },
  { role: "user",      content: "做的时候火候要注意什么？炖多久最好？", summary: "用户追问：红烧肉的火候和炖煮时长", offset: 2 },
  { role: "assistant", content: `火候是红烧肉好吃的关键：

1. **炒糖色**：全程小火，冰糖变枣红色冒小泡时立刻下肉，大火会焦苦。
2. **炖煮**：大火烧开后务必转**小火**（微沸、表面冒小泡），炖 **60～90 分钟**。小火慢炖才能让肉软烂入味又不柴。
3. **收汁**：最后 5 分钟转大火收浓，一边翻动防止粘底。

时长参考：普通锅 60～90 分钟；压力锅 25～30 分钟。肉能用筷子轻松戳透就是炖好了。`, summary: "AI 讲解红烧肉火候要点：炒糖色小火、炖煮小火60-90分钟、最后大火收汁", offset: 3 },
];

// ─── Task 3: React 性能优化（1小时前完成，新 session） ───
const task3Id = uuid();
const session2 = "test-session-react-perf";
const task3Start = now - 1 * HOUR;

const task3Chunks = [
  { role: "user",      content: "我的 React 应用渲染很慢，列表有几千条数据，怎么优化？", summary: "用户请求：React 列表几千条数据渲染慢，求优化方案", offset: 0 },
  { role: "assistant", content: `几千条数据的列表优化，按优先级推荐：

**1. 虚拟滚动（最有效）**
使用 \`react-window\` 或 \`react-virtuoso\`，只渲染可视区域内的 DOM 节点。

\`\`\`tsx
import { FixedSizeList } from 'react-window';

<FixedSizeList height={600} itemCount={items.length} itemSize={50} width="100%">
  {({ index, style }) => <div style={style}>{items[index].name}</div>}
</FixedSizeList>
\`\`\`

**2. React.memo + useMemo**
避免父组件重渲导致所有列表项重新渲染。

**3. key 优化**
确保 key 是稳定唯一值（如 id），不要用 index。

**4. 分页 / 无限滚动**
如果数据来自 API，不要一次拉全量，用分页或 cursor-based pagination。

**5. 状态下沉**
把频繁变化的状态（如 hover/selected）放到子组件，不要提升到列表层。`, summary: "AI 提供 React 列表性能优化方案：虚拟滚动、React.memo、key 优化、分页、状态下沉", offset: 0 },
  { role: "user",      content: "react-window 和 react-virtuoso 哪个更好用？有什么区别？", summary: "用户追问：react-window vs react-virtuoso 的区别和选择", offset: 2 },
  { role: "assistant", content: `两者对比：

| | react-window | react-virtuoso |
|---|---|---|
| 包大小 | ~6KB | ~30KB |
| 动态行高 | 需用 VariableSizeList + 手动测量 | 内建支持，自动测量 |
| 分组/表头 | 不支持 | 支持 GroupedVirtuoso |
| 无限滚动 | 需额外组合 react-window-infinite-loader | 内建 endReached |
| TypeScript | 需装 @types | 原生 TS |
| API 简洁度 | 较底层 | 较高层 |

**选择建议**：
- 如果行高固定且追求极致性能 → **react-window**
- 如果行高不固定、需要分组、或想快速集成 → **react-virtuoso**

大多数业务场景推荐 **react-virtuoso**，开箱即用更省心。`, summary: "AI 对比 react-window 和 react-virtuoso：大小、动态行高、分组、无限滚动等，推荐大多数场景用 react-virtuoso", offset: 3 },
];

// ─── Task 4: 正在进行的任务 — Git 工作流（10分钟前开始，active） ───
const task4Id = uuid();
const session3 = "test-session-git-workflow";
const task4Start = now - 10 * MIN;

const task4Chunks = [
  { role: "user",      content: "帮我梳理一下 Git 常用工作流，特别是 feature branch 和 trunk-based 的区别。", summary: "用户请求：梳理 Git 工作流，feature branch vs trunk-based", offset: 0 },
  { role: "assistant", content: `两种主流 Git 工作流对比：

## Feature Branch 工作流
- 每个功能/修复从 main 拉出独立分支
- 开发完成后通过 PR/MR 合并回 main
- **优点**：隔离性强、Code Review 自然、适合大团队
- **缺点**：长期分支容易 merge conflict、集成延迟

\`\`\`
main ──────●──────●──────●──────
            \\      \\      /
feature-A   ●──●──●──────○
              \\       /
feature-B      ●──●──○
\`\`\`

## Trunk-Based 工作流
- 所有人直接向 main（trunk）提交，或用极短生命周期分支（<1天）
- 依赖 Feature Flag 控制未完成功能的可见性
- **优点**：持续集成、冲突少、部署频率高
- **缺点**：需要完善的 CI/CD 和 Feature Flag 基础设施

\`\`\`
main ──●──●──●──●──●──●──●──
\`\`\`

**选择建议**：
- 小团队（<5人）、持续部署 → Trunk-Based
- 大团队、发布周期长、需要严格审查 → Feature Branch`, summary: "AI 对比了 Feature Branch 和 Trunk-Based 两种 Git 工作流，含优缺点和选择建议", offset: 0 },
];

// ─── Insert ───

const insertTask = db.prepare(`
  INSERT OR REPLACE INTO tasks (id, session_key, title, summary, status, started_at, ended_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertChunk = db.prepare(`
  INSERT OR REPLACE INTO chunks (id, session_key, turn_id, seq, role, content, kind, summary, task_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function seedTask(
  taskId: string,
  sessionKey: string,
  title: string,
  summary: string,
  status: "active" | "completed",
  startedAt: number,
  endedAt: number | null,
  chunks: Array<{ role: string; content: string; summary: string; offset: number }>,
) {
  insertTask.run(taskId, sessionKey, title, summary, status, startedAt, endedAt, now);

  for (const c of chunks) {
    const chunkId = uuid();
    const turnId = `turn-${c.offset}-${Math.random().toString(36).slice(2, 6)}`;
    const chunkTs = startedAt + c.offset * MIN;
    insertChunk.run(
      chunkId,
      sessionKey,
      turnId,
      c.offset,
      c.role,
      c.content,
      c.content.includes("```") ? "code_block" : "paragraph",
      c.summary,
      taskId,
      chunkTs,
      chunkTs,
    );
  }
}

const insertAll = db.transaction(() => {
  seedTask(
    task1Id, session1,
    "TypeScript 防抖 debounce 与节流 throttle 实现",
    `🎯 Goal
用 TypeScript 实现防抖 debounce 和节流 throttle 函数，并编写单元测试。

📋 Key Steps
- 实现 debounce 函数：支持 leading（首次立即执行）和 trailing（延迟后执行）两种模式，通过 DebounceOptions 配置
- 实现 throttle 函数：通过时间戳间隔限制调用频率，支持尾调用
- 两个函数通过 export { debounce, throttle } 一起导出
- 使用 vitest 编写单元测试：测试 debounce 的延迟执行、测试 throttle 的频率限制

✅ Result
两个函数均已实现并通过测试，支持泛型类型推断，可直接导入使用。`,
    "completed", task1Start, task1Start + 30 * MIN,
    task1Chunks,
  );

  seedTask(
    task2Id, session1,
    "红烧肉做法与火候技巧",
    `🎯 Goal
学做红烧肉，了解食材、步骤和火候要点。

📋 Key Steps
- 食材准备：五花肉 500g、冰糖 30g、生抽 2 勺、老抽 1 勺、料酒 2 勺、葱姜八角桂皮
- 制作流程：冷水焯水 → 小火炒冰糖至枣红色 → 五花肉翻炒上色 → 加调料和热水 → 小火炖 60-90 分钟 → 大火收汁
- 火候要点：炒糖色全程小火（大火会焦苦）；炖煮保持小火微沸；最后 5 分钟大火收汁翻动防粘底

✅ Result
掌握了完整红烧肉做法。全程不加盐（生抽老抽已够）。压力锅可缩短至 25-30 分钟。`,
    "completed", task2Start, task2Start + 15 * MIN,
    task2Chunks,
  );

  seedTask(
    task3Id, session2,
    "React 长列表性能优化方案",
    `🎯 Goal
优化 React 应用中几千条数据的列表渲染性能。

📋 Key Steps
- 方案 1（最有效）：虚拟滚动，使用 react-window 或 react-virtuoso，只渲染可视区域 DOM
- 方案 2：React.memo + useMemo 避免父组件重渲导致列表项全部重新渲染
- 方案 3：key 使用稳定唯一值（如 id），不用 index
- 方案 4：分页或 cursor-based pagination，不一次拉全量数据
- 方案 5：状态下沉，把 hover/selected 等频繁变化的状态放到子组件
- 对比 react-window（6KB、底层、适合固定行高）vs react-virtuoso（30KB、高层、支持动态行高和分组）

✅ Result
推荐大多数业务场景使用 react-virtuoso（开箱即用），追求极致性能且行高固定时用 react-window。`,
    "completed", task3Start, task3Start + 20 * MIN,
    task3Chunks,
  );

  seedTask(
    task4Id, session3,
    "Git 工作流：Feature Branch vs Trunk-Based",
    "",
    "active", task4Start, null,
    task4Chunks,
  );
});

insertAll();

const taskCount = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE id IN (?,?,?,?)").get(task1Id, task2Id, task3Id, task4Id) as { c: number }).c;
const chunkCount = (db.prepare("SELECT COUNT(*) as c FROM chunks WHERE task_id IN (?,?,?,?)").get(task1Id, task2Id, task3Id, task4Id) as { c: number }).c;

console.log(`✅ 插入完成！`);
console.log(`   Tasks:  ${taskCount} 个（3 completed + 1 active）`);
console.log(`   Chunks: ${chunkCount} 条记忆`);
console.log(``);
console.log(`📋 测试数据概览：`);
console.log(`   Task 1: "TypeScript 防抖 debounce 与节流 throttle 实现" — completed, session=${session1}`);
console.log(`   Task 2: "红烧肉做法与火候技巧" — completed, session=${session1}（同 session 换话题）`);
console.log(`   Task 3: "React 长列表性能优化方案" — completed, session=${session2}（新 session）`);
console.log(`   Task 4: "Git 工作流：Feature Branch vs Trunk-Based" — active, session=${session3}（进行中）`);
console.log(``);
console.log(`🌐 打开 Memory Viewer 查看: http://127.0.0.1:18799/`);

db.close();
