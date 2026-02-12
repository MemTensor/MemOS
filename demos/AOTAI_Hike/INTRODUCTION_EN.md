# 鳌太线徒步模拟器（AoTai Hike）Demo

> A pixel-art interactive narrative game demo based on the MemOS multi-view memory system

## 📖 Project Overview

**鳌太线徒步模拟器（AoTai Hike）** is a Web game demo showcasing MemOS’s multi-view memory capabilities. Players can create multiple roles, lead a team across the dangerous AoTai route (a classic hiking trail connecting Ao Mountain and Taibai Mountain), and experience memory-based intelligent NPC dialogues and dynamic storytelling.

### Key Highlights

- 🎮 **Multi-role roleplay**: Create and switch between multiple roles, each with an independent memory space
- 🧠 **Multi-view memory**: Fully integrated MemOS multi-view memory system, where each role remembers experiences from their own perspective
- 💬 **Intelligent NPC dialogue**: Generate personality-consistent dialogue based on role memory, world memory, and role persona
- 🗺️ **Fixed route exploration**: Follow the real AoTai route and experience the full journey from Tangkou to Baxian Platform
- 🎨 **Pixel-art UI**: Use Phaser 3 to render pixel-art maps and role animations, paired with a retro chat interface
- 📸 **Sharing feature**: Generate a beautifully designed share image at the end of the game, recording key journey memories

## 🎯 Core Features

### 1. Multi-role System

Players can create multiple roles to form a team, and each role has:

- **Base attributes**: stamina, mood, experience, risk_tolerance, supplies
- **Role persona**: personality description text used to generate personality-consistent dialogue and behaviors
- **Independent memory space**: each role’s memory is fully isolated and extracted from that role’s first-person perspective

**Default roles**:
- **阿鳌**: A lantern-bearing pathfinder, cautious and steady, highly experienced
- **太白**: Outwardly a devotee of gear and data, secretly harboring selfish motives
- **小山**: A smiling newcomer with a hidden agenda

### 2. MemOS Multi-view Memory Integration

The game fully integrates MemOS’s multi-view memory system:

#### World Memory
- **Purpose**: Store global game events, accessible to all roles
- **Cube ID**: `cube_{user_id}_world`
- **Content**: game events, scene changes, team decisions, etc.

#### Role Memory
- **Purpose**: An independent memory space for each role
- **Cube ID**: `cube_{role_id}_{role_id}`
- **Characteristics**:
  - Extracted from the role’s first-person perspective
  - Only keeps information relevant to that role
  - Supports role-personalized dialogue generation

#### Automatic Multi-view Mode Detection
When a message contains `role_id` or `role_name`, MemOS automatically:
1. Switches to `multi_view` mode
2. Extracts memories from the role’s first-person perspective
3. Filters out irrelevant information
4. Keeps role memories isolated

### 3. Intelligent NPC Dialogue Generation

Each NPC’s dialogue is based on:

- **Role memory**: the role’s own experiences and thoughts
- **World memory**: global game events as context
- **Role persona**: the role’s personality, motives, background
- **Current state**: location, weather, time, team status

Dialogue generation flow:
```
1. Retrieve world memory (provides global context)
2. Retrieve role memory (the role's personal experiences)
3. Build system prompt (includes role persona, current state, memory snippets)
4. Call MemOS chat_complete API to generate a reply
5. Write the dialogue back to role memory (multi-view extraction)
```

### 4. Gameplay

#### Core Actions
- **Move Forward (MOVE_FORWARD)**: Move along the route to the next node
- **Rest (REST)**: Rest in place, recover stamina but consume time
- **Camp (CAMP)**: Camp overnight, recover stamina but consume supplies
- **Observe (OBSERVE)**: Observe the surroundings, possibly discovering clues
- **Say (SAY)**: Speak as the active role, triggering NPC responses

#### Game Phases
- **Free phase (FREE)**: Normal gameplay flow
- **Await player speech (AWAIT_PLAYER_SAY)**: Requires player input dialogue
- **Camp meeting decision (CAMP_MEETING_DECIDE)**: Team discusses the next route step
- **Night vote (NIGHT_VOTE)**: Choose the leader for the night
- **Junction decision (JUNCTION_DECISION)**: Make a choice at route forks

#### Route System
- **Fixed route**: Designed based on the real AoTai hiking route
- **Key nodes**: Tangkou start → Forest gentle slope → 2800 camp → Stone sea edge → Windy ridge → Daye Lake → Baxian Platform → Finish
- **Bailout points**: Some nodes support descending/retreating, providing different game endings

### 5. Sharing Feature

A beautiful share image can be generated after the game ends:

- **Game result**: successful crossing, mid-route retreat, failure, etc.
- **Journey stats**: total distance, number of days, visited node count
- **Key events**: record important events during the journey
- **Role memory highlights**: key memory snippets extracted from role memories

## 🏗️ Technical Architecture

### Backend Architecture

backend/
├── aotai_hike/
│   ├── router.py              # FastAPI route definitions
│   ├── schemas.py             # Pydantic data models
│   ├── services/
│   │   └── game_service.py    # Core game logic
│   ├── adapters/
│   │   ├── memory.py          # MemOS memory adapter
│   │   ├── companion.py        # NPC dialogue generation
│   │   └── background.py      # Background asset provider
│   ├── world/
│   │   └── map_data.py        # Map data
│   ├── stores/
│   │   └── session_store.py   # Session storage
│   └── utils/
│       └── share_image.py     # Share image generation
└── app.py                     # FastAPI app entry

#### Core Components

**GameService**: Main game service
- Coordinates game logic and the memory system
- Handles player actions
- Manages game state

**MemoryAdapter**: Memory adapter
- Wraps MemOS API calls
- Supports multi-view memory writing and retrieval
- Handles world memory and role memory

**CompanionBrain**: NPC dialogue generation
- Generates dialogue based on role memory
- Uses MemOS chat_complete API
- Supports role switching and memory write-back

### Frontend Architecture

frontend/
├── index.html                 # Main page
├── main.js                    # Entry file
├── src/
│   ├── state.js              # State management
│   ├── phaser_view.js        # Phaser 3 scene rendering
│   ├── dom.js                # DOM UI components
│   ├── actions.js            # Action handling
│   ├── render.js             # Rendering logic
│   ├── minimap.js            # Minimap
│   ├── phase_ui.js           # Phase UI
│   └── utils.js              # Utilities
├── assets/                    # Asset files
│   ├── scenes/               # Scene backgrounds
│   ├── sprites/              # Role sprites
│   └── avatars/              # Role avatars
└── vendor/                   # Third-party libraries
└── phaser-3.90.0.min.js  # Phaser 3

#### Tech Stack

- **Phaser 3**: Pixel-art map and role animation rendering
- **Vanilla JavaScript**: Lightweight, no build tools required
- **CSS**: Pixel-style UI styling
- **Fetch API**: Communication with backend

### Memory Flow

Player performs an action
↓
GameService.act()
↓
├─ 1. Execute game logic (update world state)
├─ 2. Write world event memory
│   └─ MemoryAdapter.add_event()
│       └─ MemOSMemoryClient.add_memory()
│           └─ POST /product/add (with role_id/role_name)
│               └─ MemOS automatically enables multi_view mode
│
├─ 3. Retrieve world memory (as NPC dialogue context)
│   └─ MemoryAdapter.search()
│       └─ MemOSMemoryClient.search_memory()
│           └─ POST /product/search
│
└─ 4. Generate NPC dialogue
└─ CompanionBrain.generate()
├─ Retrieve role memory (each NPC’s own memory)
├─ Call chat_complete to generate a reply
└─ Write the dialogue back to role memory (multi-view extraction)

## 🚀 Quick Start

### Requirements

- Python 3.8+
- MemOS service (local or remote)

### Installation Steps

1. **Clone repository**
```bash
cd demos/AOTAI_Hike
```

2. **Install backend dependencies**
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

3. **Configure MemOS service address**
```bash
# Set environment variable (or modify the default in code)
export MEMOS_API_BASE_URL=http://localhost:8002
```

4. **Start backend service**
```bash
uvicorn app:app --host 0.0.0.0 --port 8010 --reload
```

5. **Access the game**
Open your browser and visit: `http://localhost:8010/demo/ao-tai/`

### Development Mode

Frontend files are located in the `frontend/` directory and can be edited directly. The backend supports hot reload (`--reload` flag).

## 📡 API Documentation

### Core Endpoints

#### 1. Get map information
```http
GET /api/demo/ao-tai/map
```

Returns nodes and edges for the fixed route.

#### 2. Create a new session
```http
POST /api/demo/ao-tai/session/new
Content-Type: application/json

{
  "user_id": "user_123"
}
```

#### 3. Create/Update a role
```http
POST /api/demo/ao-tai/roles/upsert
Content-Type: application/json

{
  "session_id": "session_123",
  "role": {
    "role_id": "r_abc",
    "name": "Test Role",
    "avatar_key": "green",
    "persona": "A test role",
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

#### 4. Quick-create default roles
```http
POST /api/demo/ao-tai/roles/quickstart
Content-Type: application/json

{
  "session_id": "session_123",
  "overwrite": true
}
```

Creates the default 3 roles (阿鳌, 太白, 小山).

#### 5. Switch active role
```http
PUT /api/demo/ao-tai/session/active_role
Content-Type: application/json

{
  "session_id": "session_123",
  "active_role_id": "r_abc"
}
```

#### 6. Perform an action (core endpoint)
```http
POST /api/demo/ao-tai/act
Content-Type: application/json

{
  "session_id": "session_123",
  "action": "MOVE_FORWARD",
  "payload": {}
}
```

**Supported action types**:
- `MOVE_FORWARD`: Move forward
- `REST`: Rest
- `CAMP`: Camp
- `OBSERVE`: Observe
- `SAY`: Say (requires `payload.text`)
- `DECIDE`: Decide (requires `payload.kind` and specific parameters)

**Response example**:
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
      "role_name": "Test Role",
      "kind": "speech",
      "content": "Let's keep moving!",
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

#### 7. Get share image
```http
GET /api/demo/ao-tai/session/{session_id}/share_image
```

Returns the share image after the game ends (PNG format).

#### 8. Get current share image
```http
GET /api/demo/ao-tai/session/{session_id}/share_image/current
```

Returns the share image for the current game state (supports unfinished games).

## 🎮 Gameplay Guide

### Starting the Game

1. **Create a session**: Click "New Game" to create a new session
2. **Create roles**: Use "Quick Start" to create the default 3 roles, or manually create custom roles
3. **Select a role**: Click a role avatar to switch the active role you are playing
4. **Start hiking**: Click the "Move Forward" button to begin the journey

### Strategy Tips

- **Stamina management**: Watch stamina values and rest or camp at the right times
- **Weather changes**: Bad weather affects team status
- **Role switching**: Different roles have different attributes and memories; switching roles lets you experience different perspectives
- **Decision timing**: Make decisions at key nodes (e.g., junctions, camps)
- **Memory accumulation**: Each role's memories will influence future dialogue and behavior

### Game Endings

- **Successful crossing**: Complete the full route and reach Baxian Platform
- **Mid-route retreat**: Choose to retreat at nodes that support retreat
- **Failure**: The team fails due to poor overall condition

## 🔧 Configuration & Extension

### Environment Variables

- `MEMOS_API_BASE_URL`: MemOS service address (default: `http://0.0.0.0:8002`)

### Extensible Interfaces

The game is designed to be "lightweight but extensible"; all intelligence-related features are isolated via adapters:

1. **MemoryAdapter** (`adapters/memory.py`)
   - Can swap in different memory systems
   - Supports different memory strategies

2. **CompanionBrain** (`adapters/companion.py`)
   - Currently uses MemOS chat_complete API
   - Can be replaced with other LLM services

3. **BackgroundProvider** (`adapters/background.py`)
   - Currently uses static background assets
   - Can be replaced with image generation services

### Custom Roles

You can create custom roles via the API and set:
- Role name and avatar
- Role persona
- Attribute values (stamina, mood, experience, etc.)

## 📚 Related Documents

- [Multi-view memory integration doc](./PR_MULTI_VIEW_MEMORY_INTEGRATION.md) - Detailed technical implementation notes
- [Memory system interaction guide](./backend/MEMORY_INTEGRATION.md) - How the game interacts with the memory system
- [PRD](./PRD.md) - Product requirements document

## 🎯 Project Goals

This project aims to demonstrate:

1. **MemOS multi-view memory capability**: How to create independent memory spaces for multiple roles
2. **Memory-based intelligent dialogue**: How to use memory to generate personality-consistent dialogue
3. **Fusion of games and AI**: How to integrate an AI memory system into gameplay
4. **Extensible architecture**: How to design pluggable adapter interfaces

## 🤝 Contributing

Issues and Pull Requests are welcome!

## 📄 License

This project follows the license of the MemOS project.

---

**Enjoy your AoTai hike!** 🏔️
