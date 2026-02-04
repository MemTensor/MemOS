## AOTAI_Hike Demo（Phaser 像素场景 + DOM 像素聊天 UI + Python 内核）

### 目录
- **frontend/**: 纯静态前端（Phaser 走 CDN，不需要打包）
- **backend/**: FastAPI 后端（session/角色/act/map 等接口），并预留记忆/生成接口扩展点

### 一键启动（开发）
在本目录下执行：

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8010 --reload
```

打开：`http://localhost:8010/demo/ao-tai/`

### API
- `GET /api/demo/ao-tai/map`
- `POST /api/demo/ao-tai/session/new`
- `POST /api/demo/ao-tai/roles/upsert`
- `PUT /api/demo/ao-tai/session/active_role`
- `POST /api/demo/ao-tai/act`

### 扩展点（先占位，方便后续接 MemOS/LLM/背景生成）
- `aotai_hike/adapters/memory.py`：MemoryAdapter（当前为 InMemory）
- `aotai_hike/adapters/companion.py`：CompanionBrain（当前为 mock）
- `aotai_hike/adapters/background.py`：BackgroundProvider（当前为静态 SVG）
