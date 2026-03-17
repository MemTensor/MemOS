---
name: safe-file-deletion
description: Enforces explicit user permission before any file deletion. Activates when you're about to use rm, unlink, fs.rm, or any operation that removes files from disk. MUST be followed for all delete operations.
---

# Safe File Deletion

## Rule

Before deleting ANY file, you MUST:

1. Call `request_file_permission` with `operation: "delete"`
2. For multiple files, use `filePaths` array (not multiple calls)
3. Wait for response
4. Only proceed if "allowed"
5. If "denied", acknowledge and do NOT delete

## Applies To

- `rm` commands (single or multiple files)
- `rm -rf` (directories)
- `unlink`, `fs.rm`, `fs.rmdir`
- Any script or tool that deletes files

## Examples

Single file:
```json
{
  "operation": "delete",
  "filePath": "/path/to/file.txt"
}
```

Multiple files (batched into one prompt):
```json
{
  "operation": "delete",
  "filePaths": ["/path/to/file1.txt", "/path/to/file2.txt"]
}
```

## No Workarounds

Never bypass deletion warnings by:
- Emptying files instead of deleting
- Moving to hidden/temp locations
- Using obscure commands

The user will see a prominent warning. Wait for explicit approval.
