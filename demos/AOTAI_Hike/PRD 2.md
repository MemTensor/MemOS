计划：先快速扫一眼你现在这个 MemOS 项目的后端形态（是否已有 FastAPI、路由规范、静态资源服务方式），再给你一份**可直接落地**的 demo PRD（功能/页面/流程/接口/数据结构/非功能）和对应的**工程方案**（目录结构、前后端通信、可插拔接口、最小实现路径）。我会尽量让它“轻量但可扩展”，把 LLM/背景图/记忆检索都留成 adapter。

[7 tools called]

Nice，repo 里已经有现成的 Python API 层（`src/memos/api/routers/*`）和服务入口（`src/memos/mem_os/main.py`）。接下来我会读一下现有的 server 启动方式、路由风格和依赖管理，然后把 demo 设计成“在现有 API 上加一个小游戏子模块”，前端用 Phaser 静态部署或由同一个服务托管都行。

[7 tools called]

我已经确认后端用的是 FastAPI，并且现有 `/product/*` 路由里有“add/search/chat/stream”等能力。接下来我会再定位一下 FastAPI app 的创建入口（哪里 include_router），这样工程方案里就能明确：小游戏路由放哪、怎么挂载静态前端、怎么复用现有 memos 组件。

[8 tools called]

### Demo PRD：《鳌太线·像素徒步模拟器（单人多角色）》
#### 背景与目标
- **背景**：基于 MemOS 的“记忆”能力做一个轻量 Web 可玩的像素风 demo。用户只有 1 个真实玩家，但可创建/切换多个角色；非当前角色的发言/动作由大模型生成（先留接口）。
- **目标（MVP）**：
  - 在网页上可玩：创建队伍（多角色）、配置属性、进入鳌太线固定路线、行进并触发事件。
  - 任意时刻可**切换当前扮演角色**；其他角色的对话/动作由“生成接口”给出（可用 mock）。
  - 每一步形成**可写入/可检索**的“游戏记忆”（对接 MemOS；先用最简存取即可）。
  - 每个路段/场景对应一个**背景图引用**（像素风，支持动图可能），背景内容由“背景生成接口”提供（先占位）。
- **非目标（先不做）**：
  - 真同屏/联机/房间系统
  - 复杂算法（真实 LLM 策略、真实图片生成、复杂数值平衡、复杂战斗）
  - 大型开放世界（路线固定）

#### 核心玩法循环（MVP）
1. 玩家创建 2–5 个角色，设置属性（体力/心情/经验等）。
2. 进入徒步界面（固定路线地图 + 当前场景背景 + 聊天 UI）。
3. 玩家用当前角色执行动作（前进/休息/扎营/观察/聊天等）。
4. 系统调用：
   - **记忆检索接口**：取与当前场景/近期事件相关的记忆片段
   - **同伴生成接口**：生成其他角色的发言/动作（文本 + 表情/动作标签）
   - **背景接口**：返回当前场景像素背景资源（url 或 sprite sheet）
5. UI 展示：地图位置更新、聊天滚动、事件日志记录；可随时切换当前角色继续循环。

#### 主要页面/模块
- **开始页**
  - 新建/继续（继续可选，MVP 可不做持久化，仅本地存档）
  - 队伍管理入口
- **队伍/角色管理页**
  - 角色列表（新增/编辑/删除）
  - 属性编辑（数值 + 文本标签）
  - 选择“默认扮演角色”
- **徒步主界面（核心）**
  - 左侧/上方：Phaser 像素地图（固定路线、当前位置、队伍头像标记）
  - 中间：场景背景层（像素背景图/动图）
  - 右侧/底部：HTML/CSS 像素聊天 UI（对话、动作、系统事件）
  - 角色切换条：一键切换当前角色
  - 动作按钮：前进/休息/扎营/观察/发言（MVP 3–5 个就够）
- **结束页**
  - 到达终点/中途退出总结（路程、关键事件、记忆摘要）

#### 角色与数据（建议的最小模型）
- **Role**
  - `role_id`, `name`, `avatar_key`
  - `attrs`: `stamina`, `mood`, `experience`, `risk_tolerance`（先 4 个）
  - `persona`: 一段性格描述（用于生成）
- **Session / WorldState**
  - `session_id`
  - `party`: roles[]
  - `active_role_id`
  - `map_progress`: 当前节点 index、时间（第几天/时段）
  - `inventory`（可选，MVP 可空）
  - `recent_events`（用于 UI 和记忆写入）

#### 事件与动作（MVP）
- **动作**：`MOVE_FORWARD`、`REST`、`CAMP`、`OBSERVE`、`SAY`
- **事件**（系统生成或脚本化）：天气变化、路况、队友情绪、补给消耗（先用脚本/随机即可，重点是“接口可扩展”）
- **生成输出（同伴）**：每步返回若干条：
  - `speech`: 文本
  - `emote`: `happy|tired|panic|calm...`
  - `action_tag`: `walk|sit|lookaround|setcamp...`（供 Phaser 播动画/切帧）

#### 记忆（MemOS）需求（MVP）
- 每一步将以下内容写入记忆（可按 role 分桶）：
  - 当前场景摘要（节点、天气、事件）
  - 所有角色对话/动作
  - 玩家选择（动作）
- 生成同伴对话前做一次检索：
  - query = “当前节点 + 近3步事件 + 当前角色 persona”
  - top_k 可配置（默认 5）

#### 验收标准（MVP）
- 能创建 ≥3 个角色，配置属性并切换 active role
- 能开始徒步，至少走过 ≥5 个节点
- 每一步能看到“其他角色自动发言/动作”（先 mock 也可）
- 能看到背景图切换（先占位图也可，接口通）
- 记忆写入/检索接口贯通（最简：写入成功 + 检索能返回内容）

---

### 对应工程方案（方案三落地）：Phaser + DOM UI + Python（FastAPI/MemOS）
#### 总体架构
- **前端**：Phaser 负责像素地图/角色精灵/镜头；HTML/CSS 覆盖层负责聊天/角色面板/按钮。
- **后端**：FastAPI 提供“游戏编排 API”（session/act/roles/background），并通过 adapter 调用 MemOS 的记忆 add/search（以及未来的 LLM/背景生成）。
- **可插拔点（必须接口化）**：
  - `MemoryAdapter`：写入/检索（先对接 MemOS 现有能力）
  - `CompanionBrain`：生成同伴发言/动作（先 mock）
  - `BackgroundProvider`：返回背景资源（先返回固定资源/占位图）

#### 推荐的后端接入方式（结合你现有 repo）
你的仓库里已有两个 FastAPI 应用：
- `memos.api.product_api:app`（挂 `/product/*`，偏产品化）
- `memos.api.server_api:app`（挂 `/product/*`，偏服务化）

**建议做法（最少侵入）**：
- 新增一个小游戏路由：`/demo/ao-tai/*`
- 把它 include 到 `memos/api/server_api.py`（或 `product_api.py`，二选一即可）
- 该路由内部通过 adapter 复用 MemOS 组件（优先走“已有 product/server handler 体系”，但 MVP 可以直接调用 `MOSProduct`/`MOS` 暴露的 add/search）

#### 后端 API 设计（MVP，接口先稳定）
- **GET `/demo/ao-tai/map`**
  - 返回固定路线节点（id/name/海拔/危险提示/背景 scene_id）
- **POST `/demo/ao-tai/session/new`**
  - req：`{ user_id?, seed? }`
  - resp：`{ session_id, world_state }`
- **POST `/demo/ao-tai/roles/upsert`**
  - req：`{ session_id, role }`
  - resp：`{ roles, active_role_id }`
- **PUT `/demo/ao-tai/session/active_role`**
  - req：`{ session_id, active_role_id }`
  - resp：`{ world_state }`
- **POST `/demo/ao-tai/act`**（核心编排）
  - req：
    - `session_id`
    - `action`: `MOVE_FORWARD|REST|CAMP|OBSERVE|SAY`
    - `payload`：如 `{ text?: string }`
  - resp：
    - `world_state_delta`（位置/时间/事件）
    - `messages[]`（系统/当前角色/同伴角色）
    - `background`：`{ scene_id, asset_url? }`
- **POST `/demo/ao-tai/background`**（可选；也可以融合到 `/act`）
  - req：`{ scene_id, style: "pixel", animate?: boolean }`
  - resp：`{ asset_url, type: "png|gif|spritesheet", meta? }`

> 说明：你现有 MemOS 的 `/product/add`、`/product/search` 已经能用。小游戏后端只需要把“游戏事件”转换成写入内容，并在生成同伴前做一次 search。

#### 后端模块划分（建议目录）
- `src/memos/demo/ao_tai/`
  - `router.py`：FastAPI `APIRouter(prefix="/demo/ao-tai")`
  - `schemas.py`：Pydantic 请求/响应模型
  - `services/game_service.py`：核心编排（应用层）
  - `world/map_data.py`：固定路线与节点数据（JSON/py 常量皆可）
  - `adapters/memory.py`：`MemoryAdapter`（对接 MemOS add/search）
  - `adapters/companion.py`：`CompanionBrain`（mock → 未来 LLM）
  - `adapters/background.py`：`BackgroundProvider`（mock → 未来图像生成）
  - `stores/session_store.py`：Session 存储（MVP 用内存 dict；可选落盘 sqlite/json）

#### 前端工程（Phaser + DOM 覆盖层）
- **推荐用 Vite 打包**（轻量、生态成熟），单独一个前端目录：
  - `apps/ao-tai-web/`（或 `web/ao-tai/`）
- **Phaser 场景**（最小 2 个）
  - `BootScene`：加载地图/精灵/字体
  - `HikeScene`：渲染路线、角色标记、背景层、相机
- **DOM UI 层（像素聊天 UI）**
  - 一个固定 `#ui-root` 覆盖在 canvas 上
  - 组件：`ChatPanel`、`RoleSwitcher`、`ActionBar`、`EventLog`
  - 字体/风格：像素字体（如 Press Start 2P）+ 像素边框 + 低分辨率缩放
- **状态管理**
  - 一个全局 store（轻量就行）：`worldState / roles / activeRole / chatMessages / pending`
  - Phaser 与 DOM 之间通过事件总线或共享 store 交互（避免双向耦合）

#### 通信与部署
- **开发期**：
  - 前端 `vite dev` 走代理到 Python（`/demo/ao-tai/*`）
- **部署期（推荐）**两种都支持：
  - **同域部署**：Vite build 产物由 FastAPI 用 `StaticFiles` 挂载（最省事）
  - **分离部署**：前端静态站 + 后端 API（注意 CORS）

#### “轻量但可扩展”的关键约定
- 所有“智能相关”都只在后端实现，并通过 3 个 adapter 隔离：
  - **MemoryAdapter**：换 MemOS/换 cube/换策略不影响游戏逻辑
  - **CompanionBrain**：从 mock 升级到 LLM 只改这一层
  - **BackgroundProvider**：从占位资源升级到生成服务只改这一层
- `/act` 作为唯一编排入口：前端只做渲染与输入，避免把“故事/记忆/生成策略”散落在前端。

---

### 最小里程碑（建议 2～3 天可跑通）
- **Day 1**：固定路线 + Session/Role/Act API（mock 同伴、占位背景）+ 前端 Phaser 地图与 DOM 聊天 UI 跑通
- **Day 2**：接入 MemOS（写入/检索）+ 同伴生成 prompt 结构（先仍可用假 LLM）+ 角色切换影响输出
- **Day 3（可选）**：背景资源服务化（scene_id→asset_url）+ 存档（session 落盘）+ UI polish

如果你希望我把它进一步“落到可直接开工的任务拆分”，我可以按你预计 demo 时长（半天/两天/一周）给出更细的任务列表与接口字段（含 JSON 示例、错误码、以及写入 MemOS 的 memory 格式约定）。
