# 鳌太线徒步模拟器（AoTai Hike）Demo

> 一个基于 MemOS 多视角记忆系统的像素风互动叙事游戏 Demo

## 📖 项目概述

**鳌太线徒步模拟器（AoTai Hike）** 是一个展示 MemOS 多视角记忆能力的 Web 游戏 Demo。玩家可以创建多个角色，带领队伍穿越危险的鳌太线（连接鳌山和太白山的经典徒步路线），体验基于记忆的智能 NPC 对话和动态叙事。

### 核心亮点

- 🎮 **多角色扮演**：创建并切换多个角色，每个角色拥有独立的记忆空间
- 🧠 **多视角记忆**：完整集成 MemOS 多视角记忆系统，每个角色从自己的视角记住经历
- 💬 **智能 NPC 对话**：基于角色记忆、世界记忆和角色人设生成符合性格的对话
- 🗺️ **固定路线探索**：沿着真实的鳌太线路线，体验从塘口起点到拔仙台的完整旅程
- 🎨 **像素风格 UI**：使用 Phaser 3 渲染像素风地图和角色动画，搭配复古聊天界面
- 📸 **分享功能**：游戏结束后生成精美的分享图片，记录旅程关键记忆

## 🎯 核心特性

### 1. 多角色系统

玩家可以创建多个角色组成队伍，每个角色拥有：

- **基础属性**：体力（stamina）、情绪（mood）、经验（experience）、风险偏好（risk_tolerance）、物资（supplies）
- **角色人设**：性格描述文本，用于生成符合角色的对话和行为
- **独立记忆空间**：每个角色的记忆完全隔离，从该角色的第一人称视角提取

**默认角色**：
- **阿鳌**：持灯的领路者，谨慎稳重，经验丰富
- **太白**：表面是器材与数据的虔信者，实际暗藏私心
- **小山**：笑容背后的新人，隐藏着不为人知的目的

### 2. MemOS 多视角记忆集成

游戏完整集成了 MemOS 的多视角记忆系统：

#### 世界记忆（World Memory）
- **用途**：存储全局游戏事件，所有角色可访问
- **Cube ID**：`cube_{user_id}_world`
- **内容**：游戏事件、场景变化、队伍决策等

#### 角色记忆（Role Memory）
- **用途**：每个角色独立的记忆空间
- **Cube ID**：`cube_{role_id}_{role_id}`
- **特点**：
  - 从角色第一人称视角提取记忆
  - 只保留与该角色相关的信息
  - 支持角色个性化对话生成

#### 自动多视角模式检测
当消息包含 `role_id` 或 `role_name` 时，MemOS 自动：
1. 切换到 `multi_view` 模式
2. 从角色第一人称视角提取记忆
3. 过滤掉不相关的信息
4. 保持角色记忆隔离

### 3. 智能 NPC 对话生成

每个 NPC 的对话基于：

- **角色记忆**：该角色自己的经历和想法
- **世界记忆**：全局游戏事件作为上下文
- **角色人设**：角色的性格、动机、背景
- **当前状态**：位置、天气、时间、队伍状态

对话生成流程：
```
1. 检索世界记忆（提供全局上下文）
2. 检索角色记忆（该角色的个人经历）
3. 构建系统提示（包含角色人设、当前状态、记忆片段）
4. 调用 MemOS chat_complete API 生成回复
5. 将对话写回角色记忆（多视角提取）
```

### 4. 游戏玩法

#### 核心动作
- **前进（MOVE_FORWARD）**：沿着路线前进到下一个节点
- **休息（REST）**：原地休息，恢复体力但消耗时间
- **扎营（CAMP）**：扎营过夜，恢复体力但消耗物资
- **观察（OBSERVE）**：观察周围环境，可能发现线索
- **发言（SAY）**：当前角色发言，触发 NPC 回应

#### 游戏阶段
- **自由阶段（FREE）**：正常游戏流程
- **等待玩家发言（AWAIT_PLAYER_SAY）**：需要玩家输入对话
- **营地决策（CAMP_MEETING_DECIDE）**：队伍讨论下一步路线
- **夜间投票（NIGHT_VOTE）**：选择当晚的队长
- **岔路决策（JUNCTION_DECISION）**：在路线分叉处做选择

#### 路线系统
- **固定路线**：基于真实鳌太线路线设计
- **关键节点**：塘口起点 → 林间缓坡 → 2800营地 → 石海边缘 → 风口山脊 → 大爷海 → 拔仙台 → 终点
- **下撤点**：部分节点支持下撤，提供不同的游戏结局

### 5. 分享功能

游戏结束后可以生成精美的分享图片：

- **游戏结果**：成功穿越、中途下撤、失败等
- **旅程统计**：总距离、天数、访问节点数
- **关键事件**：记录旅程中的重要事件
- **角色记忆亮点**：从角色记忆中提取的关键记忆片段

## 🏗️ 技术架构

### 后端架构

```
backend/
├── aotai_hike/
│   ├── router.py              # FastAPI 路由定义
│   ├── schemas.py             # Pydantic 数据模型
│   ├── services/
│   │   └── game_service.py    # 游戏核心逻辑
│   ├── adapters/
│   │   ├── memory.py          # MemOS 记忆适配器
│   │   ├── companion.py        # NPC 对话生成
│   │   └── background.py      # 背景资源提供
│   ├── world/
│   │   └── map_data.py        # 地图数据
│   ├── stores/
│   │   └── session_store.py   # 会话存储
│   └── utils/
│       └── share_image.py     # 分享图片生成
└── app.py                     # FastAPI 应用入口
```

#### 核心组件

**GameService**：游戏主服务
- 协调游戏逻辑与记忆系统
- 处理玩家动作
- 管理游戏状态

**MemoryAdapter**：记忆适配器
- 封装 MemOS API 调用
- 支持多视角记忆写入和检索
- 处理世界记忆和角色记忆

**CompanionBrain**：NPC 对话生成
- 基于角色记忆生成对话
- 使用 MemOS chat_complete API
- 支持角色切换和记忆回写

### 前端架构

```
frontend/
├── index.html                 # 主页面
├── main.js                    # 入口文件
├── src/
│   ├── state.js              # 状态管理
│   ├── phaser_view.js        # Phaser 3 场景渲染
│   ├── dom.js                # DOM UI 组件
│   ├── actions.js            # 动作处理
│   ├── render.js             # 渲染逻辑
│   ├── minimap.js            # 小地图
│   ├── phase_ui.js           # 阶段 UI
│   └── utils.js              # 工具函数
├── assets/                    # 资源文件
│   ├── scenes/               # 场景背景
│   ├── sprites/              # 角色精灵
│   └── avatars/              # 角色头像
└── vendor/                   # 第三方库
    └── phaser-3.90.0.min.js  # Phaser 3
```

#### 技术栈

- **Phaser 3**：像素风地图和角色动画渲染
- **原生 JavaScript**：轻量级，无需构建工具
- **CSS**：像素风格 UI 样式
- **Fetch API**：与后端通信

### 记忆流程

```
玩家执行动作
    ↓
GameService.act()
    ↓
├─ 1. 执行游戏逻辑（更新世界状态）
├─ 2. 写入世界事件记忆
│   └─ MemoryAdapter.add_event()
│       └─ MemOSMemoryClient.add_memory()
│           └─ POST /product/add (带 role_id/role_name)
│               └─ MemOS 自动启用 multi_view 模式
│
├─ 3. 检索世界记忆（作为 NPC 对话上下文）
│   └─ MemoryAdapter.search()
│       └─ MemOSMemoryClient.search_memory()
│           └─ POST /product/search
│
└─ 4. 生成 NPC 对话
    └─ CompanionBrain.generate()
        ├─ 检索角色记忆（每个 NPC 自己的记忆）
        ├─ 调用 chat_complete 生成回复
        └─ 将对话写回角色记忆（多视角提取）
```

## 🚀 快速开始

### 环境要求

- Python 3.8+
- MemOS 服务（本地或远程）

### 安装步骤

1. **克隆仓库**
```bash
cd demos/AOTAI_Hike
```

2. **安装后端依赖**
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

3. **配置 MemOS 服务地址**
```bash
# 设置环境变量（或修改代码中的默认值）
export MEMOS_API_BASE_URL=http://localhost:8002
```

4. **启动后端服务**
```bash
uvicorn app:app --host 0.0.0.0 --port 8010 --reload
```

5. **访问游戏**
打开浏览器访问：`http://localhost:8010/demo/ao-tai/`

### 开发模式

前端文件位于 `frontend/` 目录，可以直接编辑。后端支持热重载（`--reload` 参数）。

## 📡 API 文档

### 核心接口

#### 1. 获取地图信息
```http
GET /api/demo/ao-tai/map
```

返回固定路线的节点和边信息。

#### 2. 创建新会话
```http
POST /api/demo/ao-tai/session/new
Content-Type: application/json

{
  "user_id": "user_123"
}
```

#### 3. 创建/更新角色
```http
POST /api/demo/ao-tai/roles/upsert
Content-Type: application/json

{
  "session_id": "session_123",
  "role": {
    "role_id": "r_abc",
    "name": "测试角色",
    "avatar_key": "green",
    "persona": "一个测试角色",
    "attrs": {
      "stamina": 80,
      "mood": 70,
      "experience": 50,
      "risk_tolerance": 60,
      "supplies": 75
    }
  }
}
```

#### 4. 快速创建默认角色
```http
POST /api/demo/ao-tai/roles/quickstart
Content-Type: application/json

{
  "session_id": "session_123",
  "overwrite": true
}
```

创建默认的 3 个角色（阿鳌、太白、小山）。

#### 5. 切换当前角色
```http
PUT /api/demo/ao-tai/session/active_role
Content-Type: application/json

{
  "session_id": "session_123",
  "active_role_id": "r_abc"
}
```

#### 6. 执行动作（核心接口）
```http
POST /api/demo/ao-tai/act
Content-Type: application/json

{
  "session_id": "session_123",
  "action": "MOVE_FORWARD",
  "payload": {}
}
```

**支持的动作类型**：
- `MOVE_FORWARD`：前进
- `REST`：休息
- `CAMP`：扎营
- `OBSERVE`：观察
- `SAY`：发言（需要 `payload.text`）
- `DECIDE`：决策（需要 `payload.kind` 和具体参数）

**响应示例**：
```json
{
  "world_state": {
    "session_id": "session_123",
    "current_node_id": "camp_2800",
    "day": 1,
    "time_of_day": "afternoon",
    "weather": "sunny",
    "roles": [...],
    "active_role_id": "r_abc"
  },
  "messages": [
    {
      "message_id": "m_123",
      "role_id": "r_abc",
      "role_name": "测试角色",
      "kind": "speech",
      "content": "我们继续前进吧！",
      "emote": "happy",
      "timestamp_ms": 1234567890
    }
  ],
  "background": {
    "scene_id": "camp",
    "asset_url": "/assets/scenes/camp.png"
  },
  "share_image": {
    "is_game_finished": false
  }
}
```

#### 7. 获取分享图片
```http
GET /api/demo/ao-tai/session/{session_id}/share_image
```

返回游戏结束后的分享图片（PNG 格式）。

#### 8. 获取当前分享图片
```http
GET /api/demo/ao-tai/session/{session_id}/share_image/current
```

返回当前游戏状态的分享图片（支持未完成的游戏）。

## 🎮 游戏玩法指南

### 开始游戏

1. **创建会话**：点击"新建游戏"创建新会话
2. **创建角色**：使用"快速开始"创建默认 3 个角色，或手动创建自定义角色
3. **选择角色**：点击角色头像切换当前扮演的角色
4. **开始徒步**：点击"前进"按钮开始旅程

### 游戏策略

- **体力管理**：注意角色的体力值，适时休息或扎营
- **天气变化**：恶劣天气会影响队伍状态
- **角色切换**：不同角色有不同的属性和记忆，切换角色可以体验不同的视角
- **决策时机**：在关键节点（如岔路、营地）需要做出决策
- **记忆积累**：每个角色的记忆会影响后续对话和行为

### 游戏结局

- **成功穿越**：完成整条路线，到达拔仙台
- **中途下撤**：在支持下撤的节点选择下撤
- **失败**：队伍状态过差导致失败

## 🔧 配置与扩展

### 环境变量

- `MEMOS_API_BASE_URL`：MemOS 服务地址（默认：`http://0.0.0.0:8002`）

### 可扩展接口

游戏设计为"轻量但可扩展"，所有智能相关功能都通过 adapter 隔离：

1. **MemoryAdapter** (`adapters/memory.py`)
   - 可以替换不同的记忆系统
   - 支持不同的记忆策略

2. **CompanionBrain** (`adapters/companion.py`)
   - 当前使用 MemOS chat_complete API
   - 可以替换为其他 LLM 服务

3. **BackgroundProvider** (`adapters/background.py`)
   - 当前使用静态背景资源
   - 可以替换为图像生成服务

### 自定义角色

可以通过 API 创建自定义角色，设置：
- 角色名称和头像
- 角色人设（persona）
- 属性值（体力、情绪、经验等）

## 📚 相关文档

- [多视角记忆集成文档](./PR_MULTI_VIEW_MEMORY_INTEGRATION.md) - 详细的技术实现说明
- [记忆系统交互说明](./backend/MEMORY_INTEGRATION.md) - 游戏与记忆系统的交互方式
- [PRD 文档](./PRD.md) - 项目需求文档

## 🎯 项目目标

本项目旨在展示：

1. **MemOS 多视角记忆能力**：如何为多个角色创建独立的记忆空间
2. **基于记忆的智能对话**：如何利用记忆生成符合角色性格的对话
3. **游戏与 AI 的融合**：如何将 AI 记忆系统集成到游戏体验中
4. **可扩展架构**：如何设计可插拔的 adapter 接口

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

本项目遵循 MemOS 项目的许可证。

---

**享受你的鳌太线之旅！** 🏔️
