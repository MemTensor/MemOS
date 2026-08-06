---
title: 用户管理
desc: "**MOS**提供全面的用户管理功能，以支持多用户、多会话记忆操作。本文档详细介绍了MOS的用户管理方法."
---

## 用户角色

MOS支持4种不同权限级别的用户角色:

| 角色 | 描述 | 权限 |
|------|-------------|-------------|
| `ROOT` | 系统管理员 | 访问所有的立方体和用户，且不可被删除 |
| `ADMIN` | 管理员用户 | 可以管理用户和立方体，访问所有立方体 |
| `USER` | 常规用户 | 可以创建和管理自己的立方体，访问共享的立方体 |
| `GUEST` | 受限用户 | 仅仅可以访问共享的立方体，不能创建立方体 |

## 用户管理方法

### 1. `create_user`

在MOS系统中创建一个新的用户

**参数:**
- `user_id` (str): 用户的唯一标识符
- `role` (UserRole, optional): 用户角色。默认是 `UserRole.USER`
- `user_name` (str, optional): 展示用户的用户名。如果不提供, 使用 `user_id`

**返回值:**
- `str`: 创建的用户ID

**示例:**
```python
import uuid
from memos.mem_user.user_manager import UserRole

# 创建一个标准用户
user_id = str(uuid.uuid4())
memory.create_user(user_id=user_id, role=UserRole.USER, user_name="John Doe")

# 创建一个管理员用户
admin_id = str(uuid.uuid4())
memory.create_user(user_id=admin_id, role=UserRole.ADMIN, user_name="Admin User")

# 创建一个访客用户
guest_id = str(uuid.uuid4())
memory.create_user(user_id=guest_id, role=UserRole.GUEST, user_name="Guest User")
```

**注意:**
- 如果具有相同`user_name`的用户已经存在，则该方法返回现有用户的ID
- 初始化过程中系统会自动创建一个root用户
- 用户ID在整个系统中必须是唯一的

### 2. `list_users`

检索系统中所有激活用户的信息

**参数:**
- 无

**返回值:**
- `list`: 包含用户信息的字典列表:
  - `user_id` (str): 唯一用户识别
  - `user_name` (str): 展示用户的名称
  - `role` (str): 用户角色 (根用户, 管理员, 普通用户, 访客)
  - `created_at` (str): 创建用户的ISO格式时间戳
  - `is_active` (bool): 用户帐号是否激活

**示例:**
```python
# 所有用户列表
users = memory.list_users()
for user in users:
    print(f"User: {user['user_name']} (ID: {user['user_id']})")
    print(f"Role: {user['role']}")
    print(f"Active: {user['is_active']}")
    print(f"Created: {user['created_at']}")
    print("---")
```

**输出示例:**
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

创建一个新的记忆立方，并将指定用户设为其所有者

**参数:**
- `cube_name` (str): 立方体名称
- `owner_id` (str): 立方体所有者的用户ID
- `cube_path` (str, optional): 立方体的本地文件路径或远程存储库URL
- `cube_id` (str, optional): 定制立方体标识符，如果没有提供，使用生成的UUID

**返回值:**
- `str`: 创建的立方体ID

**示例:**
```python
import uuid

# 第一次创建用户
user_id = str(uuid.uuid4())
memory.create_user(user_id=user_id, user_name="Alice")

# 为用户创建一个立方
cube_id = memory.create_cube_for_user(
    cube_name="Alice's Personal Memory",
    owner_id=user_id,
    cube_path="/path/to/alice/memory",
    cube_id="alice_personal_cube"
)

print(f"Created cube: {cube_id}")
```

**注意:**
- 所有者自动访问创建的所有立方体
- 立方体所有者可以和其他用户共享
- 如果提供了 `cube_path` , 它可以是本地目录路径或远程存储库URL
- 自定义`cube_id`必须在整个系统中唯一

### 4. `get_user_info`

检索有关当前用户及其可访问立方体的详细信息

**参数:**
- 无

**返回值:**
- `dict`: 包含用户信息和可访问立方体的字典:
  - `user_id` (str): 当前用户ID
  - `user_name` (str): 当前用户名称
  - `role` (str): 当前用户角色
  - `created_at` (str): 创建用户的ISO格式时间戳
  - `accessible_cubes` (list): 每个可访问立方体的字典列表:
    - `cube_id` (str): 立方体标识符
    - `cube_name` (str): 立方体名称
    - `cube_path` (str): 立方体文件路径或仓库URL
    - `owner_id` (str): 立方体所有者ID
    - `is_loaded` (bool): 立方体当前是否加载在记忆中

**示例:**
```python
# 获取当前用户信息
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

**输出示例:**
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

和其他用户共享一个记忆立方，授予他们访问立方体内容的权限

**参数:**
- `cube_id` (str): 共享立方体ID
- `target_user_id` (str): 共享立方体的用户ID

**返回值:**
- `bool`: 如果共享，返回`True`, 否则，返回`False`

**示例:**
```python
# 和其他用户共享一个立方
success = memory.share_cube_with_user(
    cube_id="alice_personal_cube",
    target_user_id="bob_user_id"
)

if success:
    print("Cube shared successfully")
else:
    print("Failed to share cube")
```

**注意:**
- 当前用户必须有权访问正在共享的立方体
- 目标用户必须存在且激活
- 共享一个立方体授予目标用户对该立方体的读写访问权限
- 立方体所有者总是共享他的立方体
- 具有立方体访问权限的用户可以与其他用户共享立方体（如果他们具有适当的权限）

## 完整的用户管理工作流

下面是演示用户管理操作的完整示例:

```python
import uuid
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS
from memos.mem_user.user_manager import UserRole

# 初始化MOS
mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")
memory = MOS(mos_config)

# 1. 创建用户
alice_id = str(uuid.uuid4())
bob_id = str(uuid.uuid4())

memory.create_user(user_id=alice_id, user_name="Alice", role=UserRole.USER)
memory.create_user(user_id=bob_id, user_name="Bob", role=UserRole.USER)

# 2. 所有用户列表
print("All users:")
users = memory.list_users()
for user in users:
    print(f"- {user['user_name']} ({user['role']})")

# 3. 为用户创建一个立方
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

# 4. 和其他用户共享立方
memory.share_cube_with_user(alice_cube_id, bob_id)
memory.share_cube_with_user(bob_cube_id, alice_id)

# 5. 获取用户信息
alice_info = memory.get_user_info()
print(f"\nAlice's accessible cubes: {len(alice_info['accessible_cubes'])}")

# 6. 添加记忆到立方
memory.add(
    messages=[
        {"role": "user", "content": "I like playing football."},
        {"role": "assistant", "content": "That's great! Football is a wonderful sport."}
    ],
    user_id=alice_id,
    mem_cube_id=alice_cube_id
)

# 7. 搜索记忆
retrieved = memory.search(
    query="What does Alice like?",
    user_id=alice_id
)
print(f"Retrieved memories: {retrieved['text_mem']}")
```

## 错误处理

用户管理方法包括全面的错误处理:

- **用户验证**: 方法在操作之前验证用户是否存在并处于激活状态
- **立方体访问验证**: 确保用户在操作前对立方体具有适当的访问权限
- **防止重复**: 优雅地处理重复的用户名和立方体ID
- **权限检查**: 验证敏感操作的用户角色和权限

## 数据库持久性

用户管理数据持久化在SQLite数据库中:
- **位置**: 默认 `~/.memos/memos_users.db`
- **表**: `users`, `cubes`, `user_cube_association`
- **关系**: 用户和立方体之间是多对多关系
- **软删除**: 用户和立方体被软删除（标记为非激活），而不是永久删除

## 安全注意事项

- **基于角色的访问控制**: 不同的用户角色具有不同的权限
- **立方体所有权**: 立方体所有者可以完全控制他们的立方体
- **访问验证**: 所有操作在执行前都要验证用户访问权限
- **根用户保护**: 根用户不可删除，具有系统完全访问权限
