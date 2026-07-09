---
title: User Management
desc: The **MOS** provides comprehensive user management capabilities to support multi-user, multi-session memory operations. This document details the user management methods available in the MOS.
---

## User Roles

MOS supports four user roles with different permission levels:

| Role | Description | Permissions |
|------|-------------|-------------|
| `ROOT` | System administrator | Full access to all cubes and users, cannot be deleted |
| `ADMIN` | Administrative user | Can manage users and cubes, access to all cubes |
| `USER` | Standard user | Can create and manage own cubes, access shared cubes |
| `GUEST` | Limited user | Read-only access to shared cubes, cannot create cubes |

## User Management Methods

### 1. `create_user`

Creates a new user in the MOS system.

**Parameters:**
- `user_id` (str): Unique identifier for the user
- `role` (UserRole, optional): User role. Defaults to `UserRole.USER`
- `user_name` (str, optional): Display name for the user. If not provided, uses `user_id`

**Returns:**
- `str`: The created user ID

**Example:**
```python
import uuid
from memos.mem_user.user_manager import UserRole

# Create a standard user
user_id = str(uuid.uuid4())
memory.create_user(user_id=user_id, role=UserRole.USER, user_name="John Doe")

# Create an admin user
admin_id = str(uuid.uuid4())
memory.create_user(user_id=admin_id, role=UserRole.ADMIN, user_name="Admin User")

# Create a guest user
guest_id = str(uuid.uuid4())
memory.create_user(user_id=guest_id, role=UserRole.GUEST, user_name="Guest User")
```

**Notes:**
- If a user with the same `user_name` already exists, the method returns the existing user's ID
- The system automatically creates a root user during initialization
- User IDs must be unique across the system

### 2. `list_users`

Retrieves information about all active users in the system.

**Parameters:**
- None

**Returns:**
- `list`: List of dictionaries containing user information:
  - `user_id` (str): Unique user identifier
  - `user_name` (str): Display name of the user
  - `role` (str): User role (root, admin, user, guest)
  - `created_at` (str): ISO format timestamp of user creation
  - `is_active` (bool): Whether the user account is active

**Example:**
```python
# List all users
users = memory.list_users()
for user in users:
    print(f"User: {user['user_name']} (ID: {user['user_id']})")
    print(f"Role: {user['role']}")
    print(f"Active: {user['is_active']}")
    print(f"Created: {user['created_at']}")
    print("---")
```

**Output Example:**
```
User: root (ID: root)
Role: root
Active: True
Created: 2024-01-15T10:30:00
---
User: John Doe (ID: 550e8400-e29b-41d4-a716-446655440000)
Role: user
Active: True
Created: 2024-01-15T11:00:00
---
```

### 3. `create_cube_for_user`

Creates a new memory cube for a specific user as the owner.

**Parameters:**
- `cube_name` (str): Name of the cube
- `owner_id` (str): User ID of the cube owner
- `cube_path` (str, optional): Local file path or remote repository URL for the cube
- `cube_id` (str, optional): Custom cube identifier. If not provided, a UUID is generated

**Returns:**
- `str`: The created cube ID

**Example:**
```python
import uuid

# Create a user first
user_id = str(uuid.uuid4())
memory.create_user(user_id=user_id, user_name="Alice")

# Create a cube for the user
cube_id = memory.create_cube_for_user(
    cube_name="Alice's Personal Memory",
    owner_id=user_id,
    cube_path="/path/to/alice/memory",
    cube_id="alice_personal_cube"
)

print(f"Created cube: {cube_id}")
```

**Notes:**
- The owner automatically gets full access to the created cube
- The cube owner can share the cube with other users
- If `cube_path` is provided, it can be a local directory path or a remote repository URL
- Custom `cube_id` must be unique across the system

### 4. `get_user_info`

Retrieves detailed information about the current user and their accessible cubes.

**Parameters:**
- None

**Returns:**
- `dict`: Dictionary containing user information and accessible cubes:
  - `user_id` (str): Current user's ID
  - `user_name` (str): Current user's display name
  - `role` (str): Current user's role
  - `created_at` (str): ISO format timestamp of user creation
  - `accessible_cubes` (list): List of dictionaries for each accessible cube:
    - `cube_id` (str): Cube identifier
    - `cube_name` (str): Cube display name
    - `cube_path` (str): Cube file path or repository URL
    - `owner_id` (str): ID of the cube owner
    - `is_loaded` (bool): Whether the cube is currently loaded in memory

**Example:**
```python
# Get current user information
user_info = memory.get_user_info()

print(f"Current User: {user_info['user_name']} ({user_info['user_id']})")
print(f"Role: {user_info['role']}")
print(f"Created: {user_info['created_at']}")
print("\nAccessible Cubes:")
for cube in user_info['accessible_cubes']:
    print(f"- {cube['cube_name']} (ID: {cube['cube_id']})")
    print(f"  Owner: {cube['owner_id']}")
    print(f"  Loaded: {cube['is_loaded']}")
    print(f"  Path: {cube['cube_path']}")
```

**Output Example:**
```
Current User: Alice (550e8400-e29b-41d4-a716-446655440000)
Role: user
Created: 2024-01-15T11:00:00

Accessible Cubes:
- Alice's Personal Memory (ID: alice_personal_cube)
  Owner: 550e8400-e29b-41d4-a716-446655440000
  Loaded: True
  Path: /path/to/alice/memory
- Shared Project Memory (ID: project_cube)
  Owner: bob_user_id
  Loaded: False
  Path: /path/to/project/memory
```

### 5. `share_cube_with_user`

Shares a memory cube with another user, granting them access to the cube's contents.

**Parameters:**
- `cube_id` (str): ID of the cube to share
- `target_user_id` (str): ID of the user to share the cube with

**Returns:**
- `bool`: `True` if sharing was successful, `False` otherwise

**Example:**
```python
# Share a cube with another user
success = memory.share_cube_with_user(
    cube_id="alice_personal_cube",
    target_user_id="bob_user_id"
)

if success:
    print("Cube shared successfully")
else:
    print("Failed to share cube")
```

**Notes:**
- The current user must have access to the cube being shared
- The target user must exist and be active
- Sharing a cube grants the target user read and write access to the cube
- Cube owners can always share their cubes
- Users with access to a cube can share it with other users (if they have appropriate permissions)

## Complete User Management Workflow

Here's a complete example demonstrating user management operations:

```python
import uuid
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS
from memos.mem_user.user_manager import UserRole

# Initialize MOS
mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")
memory = MOS(mos_config)

# 1. Create users
alice_id = str(uuid.uuid4())
bob_id = str(uuid.uuid4())

memory.create_user(user_id=alice_id, user_name="Alice", role=UserRole.USER)
memory.create_user(user_id=bob_id, user_name="Bob", role=UserRole.USER)

# 2. List all users
print("All users:")
users = memory.list_users()
for user in users:
    print(f"- {user['user_name']} ({user['role']})")

# 3. Create cubes for users
alice_cube_id = memory.create_cube_for_user(
    cube_name="Alice's Personal Memory",
    owner_id=alice_id,
    cube_path="/path/to/alice/memory"
)

bob_cube_id = memory.create_cube_for_user(
    cube_name="Bob's Work Memory",
    owner_id=bob_id,
    cube_path="/path/to/bob/work"
)

# 4. Share cubes between users
memory.share_cube_with_user(alice_cube_id, bob_id)
memory.share_cube_with_user(bob_cube_id, alice_id)

# 5. Get user information
alice_info = memory.get_user_info()
print(f"\nAlice's accessible cubes: {len(alice_info['accessible_cubes'])}")

# 6. Add memory to cubes
memory.add(
    messages=[
        {"role": "user", "content": "I like playing football."},
        {"role": "assistant", "content": "That's great! Football is a wonderful sport."}
    ],
    user_id=alice_id,
    mem_cube_id=alice_cube_id
)

# 7. Search memories
retrieved = memory.search(
    query="What does Alice like?",
    user_id=alice_id
)
print(f"Retrieved memories: {retrieved['text_mem']}")
```

## Error Handling

The user management methods include comprehensive error handling:

- **User Validation**: Methods validate that users exist and are active before operations
- **Cube Access Validation**: Ensures users have appropriate access to cubes before operations
- **Duplicate Prevention**: Handles duplicate user names and cube IDs gracefully
- **Permission Checks**: Validates user roles and permissions for sensitive operations

## Database Persistence

User management data is persisted in a SQLite database:
- **Location**: Defaults to `~/.memos/memos_users.db`
- **Tables**: `users`, `cubes`, `user_cube_association`
- **Relationships**: Many-to-many relationship between users and cubes
- **Soft Deletes**: Users and cubes are soft-deleted (marked as inactive) rather than permanently removed

## Security Considerations

- **Role-based Access Control**: Different user roles have different permissions
- **Cube Ownership**: Cube owners have full control over their cubes
- **Access Validation**: All operations validate user access before execution
- **Root User Protection**: Root user cannot be deleted and has full system access
