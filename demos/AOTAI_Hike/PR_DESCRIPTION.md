# Integrate AoTai Hike Demo with MemOS Multi-View Memory System

## Summary

This PR integrates the AoTai Hike game demo with MemOS's multi-view memory capabilities, demonstrating how multiple game roles can maintain independent memory spaces and extract memories from their own first-person perspectives.

## Key Features

### 1. Multi-View Memory Integration
- **World Memory**: Stores global game events accessible to all roles (`cube_{user_id}_world`)
- **Role Memory**: Each role has an independent memory space (`cube_{role_id}_{role_id}`)
- **Automatic Mode Detection**: MemOS automatically enables `multi_view` mode when messages contain `role_id` or `role_name` fields

### 2. Memory Flow
```
GameService.act
  ├─ add_event (world memory write with role_id/role_name)
  ├─ search (world memory retrieval)
  └─ CompanionBrain.generate
        ├─ search_memory (role memory retrieval)
        ├─ chat_complete (LLM generation)
        └─ add_memory (role memory write-back with multi-view extraction)
```

### 3. Core Implementation

**MemoryAdapter** (`adapters/memory.py`):
- Wraps MemOS API calls (`/product/add`, `/product/search`, `/product/chat/complete`)
- Supports multi-view memory writing and retrieval
- Handles world memory and role memory isolation

**CompanionBrain** (`adapters/companion.py`):
- Generates NPC dialogue based on role memory
- Uses MemOS `chat_complete` API with role-specific context
- Writes dialogue back to role memory with multi-view extraction

**GameService** (`services/game_service.py`):
- Coordinates game logic with memory system
- Formats and writes game events to memory
- Retrieves world memory for NPC dialogue context

## Technical Details

### Multi-View Memory Detection
When messages contain `role_id` or `role_name`, MemOS automatically:
1. Switches to `multi_view` mode
2. Extracts memories from the role's first-person perspective
3. Filters irrelevant information
4. Maintains role memory isolation

### Memory Namespace
- Role memory: `cube_{role_id}_{role_id}`
- World memory: `cube_{user_id}_world`

## Files Changed

- `demos/AOTAI_Hike/backend/aotai_hike/adapters/memory.py` - MemOS memory adapter
- `demos/AOTAI_Hike/backend/aotai_hike/adapters/companion.py` - NPC dialogue generation
- `demos/AOTAI_Hike/backend/aotai_hike/services/game_service.py` - Game service with memory integration
- `demos/AOTAI_Hike/backend/aotai_hike/router.py` - API routes
- `demos/AOTAI_Hike/README.md` - Updated documentation
- `demos/AOTAI_Hike/INTRODUCTION_ZH.md` - Chinese documentation
- `demos/AOTAI_Hike/INTRODUCTION_EN.md` - English documentation

## Related Issue

Closes #[ISSUE_NUMBER]

## Documentation

- [Memory Integration Guide](./backend/MEMORY_INTEGRATION.md)
- [Complete Introduction (中文)](./INTRODUCTION_ZH.md)
- [Complete Introduction (English)](./INTRODUCTION_EN.md)
