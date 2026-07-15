# Safe File Deletion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an OpenCode skill that enforces user permission before file deletions, with enhanced UI warnings.

**Architecture:** Create SKILL.md file for agent instructions, extend file-permission MCP server to support `filePaths` array for batch operations, enhance Execution.tsx UI with prominent red warning treatment for delete operations.

**Tech Stack:** OpenCode skills (SKILL.md), TypeScript, React, Tailwind CSS

---

### Task 1: Create the Safe File Deletion Skill

**Files:**
- Create: `apps/desktop/skills/safe-file-deletion/SKILL.md`

**Step 1: Create the skill directory and file**

```bash
mkdir -p apps/desktop/skills/safe-file-deletion
```

**Step 2: Write the SKILL.md file**

Create `apps/desktop/skills/safe-file-deletion/SKILL.md`:

```markdown
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
```

**Step 3: Commit**

```bash
git add apps/desktop/skills/safe-file-deletion/
git commit -m "feat: add safe-file-deletion skill"
```

---

### Task 2: Add filePaths to Shared Types

**Files:**
- Modify: `packages/shared/src/types/permission.ts:8-33`

**Step 1: Update PermissionRequest interface**

Add `filePaths` field after `filePath` (line 25):

```typescript
  /** File path being operated on if type is 'file' */
  filePath?: string;
  /** Multiple file paths for batch operations (e.g., deleting multiple files) */
  filePaths?: string[];
```

**Step 2: Run typecheck to verify**

```bash
pnpm typecheck
```

Expected: PASS (no consumers use this field yet)

**Step 3: Commit**

```bash
git add packages/shared/src/types/permission.ts
git commit -m "feat(types): add filePaths to PermissionRequest for batch operations"
```

---

### Task 3: Update MCP Server to Accept filePaths

**Files:**
- Modify: `apps/desktop/skills/file-permission/src/index.ts:21-26, 48-61, 77, 92-97`

**Step 1: Update FilePermissionInput interface (line 21-26)**

Replace:
```typescript
interface FilePermissionInput {
  operation: 'create' | 'delete' | 'rename' | 'move' | 'modify' | 'overwrite';
  filePath: string;
  targetPath?: string;
  contentPreview?: string;
}
```

With:
```typescript
interface FilePermissionInput {
  operation: 'create' | 'delete' | 'rename' | 'move' | 'modify' | 'overwrite';
  filePath?: string;
  filePaths?: string[];
  targetPath?: string;
  contentPreview?: string;
}
```

**Step 2: Update inputSchema to add filePaths property (after line 51)**

Add after the `filePath` property:

```typescript
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of absolute paths for batch operations (e.g., deleting multiple files)',
          },
```

**Step 3: Update required field (line 61)**

Change:
```typescript
        required: ['operation', 'filePath'],
```

To:
```typescript
        required: ['operation'],
```

**Step 4: Update destructuring (line 77)**

Change:
```typescript
  const { operation, filePath, targetPath, contentPreview } = args;
```

To:
```typescript
  const { operation, filePath, filePaths, targetPath, contentPreview } = args;
```

**Step 5: Update validation (line 80-85)**

Change:
```typescript
  // Validate required fields
  if (!operation || !filePath) {
    return {
      content: [{ type: 'text', text: 'Error: operation and filePath are required' }],
      isError: true,
    };
  }
```

To:
```typescript
  // Validate required fields
  if (!operation || (!filePath && (!filePaths || filePaths.length === 0))) {
    return {
      content: [{ type: 'text', text: 'Error: operation and either filePath or filePaths are required' }],
      isError: true,
    };
  }
```

**Step 6: Update HTTP request body (line 92-97)**

Change:
```typescript
      body: JSON.stringify({
        operation,
        filePath,
        targetPath,
        contentPreview: contentPreview?.substring(0, 500), // Truncate preview
      }),
```

To:
```typescript
      body: JSON.stringify({
        operation,
        filePath,
        filePaths,
        targetPath,
        contentPreview: contentPreview?.substring(0, 500), // Truncate preview
      }),
```

**Step 7: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 8: Commit**

```bash
git add apps/desktop/skills/file-permission/src/index.ts
git commit -m "feat(file-permission): add filePaths array for batch operations"
```

---

### Task 4: Update Permission API to Handle filePaths

**Files:**
- Modify: `apps/desktop/src/main/permission-api.ts:91-96, 138-147`

**Step 1: Update request body type (line 91-96)**

Change:
```typescript
    let data: {
      operation?: string;
      filePath?: string;
      targetPath?: string;
      contentPreview?: string;
    };
```

To:
```typescript
    let data: {
      operation?: string;
      filePath?: string;
      filePaths?: string[];
      targetPath?: string;
      contentPreview?: string;
    };
```

**Step 2: Update validation (line 107-111)**

Change:
```typescript
    // Validate required fields
    if (!data.operation || !data.filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'operation and filePath are required' }));
      return;
    }
```

To:
```typescript
    // Validate required fields
    if (!data.operation || (!data.filePath && (!data.filePaths || data.filePaths.length === 0))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'operation and either filePath or filePaths are required' }));
      return;
    }
```

**Step 3: Update permissionRequest object (line 138-147)**

Change:
```typescript
    const permissionRequest: PermissionRequest = {
      id: requestId,
      taskId,
      type: 'file',
      fileOperation: data.operation as FileOperation,
      filePath: data.filePath,
      targetPath: data.targetPath,
      contentPreview: data.contentPreview?.substring(0, 500),
      createdAt: new Date().toISOString(),
    };
```

To:
```typescript
    const permissionRequest: PermissionRequest = {
      id: requestId,
      taskId,
      type: 'file',
      fileOperation: data.operation as FileOperation,
      filePath: data.filePath,
      filePaths: data.filePaths,
      targetPath: data.targetPath,
      contentPreview: data.contentPreview?.substring(0, 500),
      createdAt: new Date().toISOString(),
    };
```

**Step 4: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src/main/permission-api.ts
git commit -m "feat(permission-api): support filePaths in permission requests"
```

---

### Task 5: Add Delete Warning Helper Function

**Files:**
- Modify: `apps/desktop/src/renderer/pages/Execution.tsx:13, 63-74`

**Step 1: Add AlertTriangle import (line 13)**

Change:
```typescript
import { XCircle, CornerDownLeft, ArrowLeft, CheckCircle2, AlertCircle, Terminal, Wrench, FileText, Search, Code, Brain, Clock, Square, Play, Download, File, Bug, ChevronUp, ChevronDown, Trash2, Check } from 'lucide-react';
```

To:
```typescript
import { XCircle, CornerDownLeft, ArrowLeft, CheckCircle2, AlertCircle, AlertTriangle, Terminal, Wrench, FileText, Search, Code, Brain, Clock, Square, Play, Download, File, Bug, ChevronUp, ChevronDown, Trash2, Check } from 'lucide-react';
```

**Step 2: Add isDeleteOperation helper after getOperationBadgeClasses (after line 74)**

Add:
```typescript

// Helper to check if this is a delete operation
function isDeleteOperation(request: { type: string; fileOperation?: string }): boolean {
  return request.type === 'file' && request.fileOperation === 'delete';
}

// Get file paths to display (handles both single and multiple)
function getDisplayFilePaths(request: { filePath?: string; filePaths?: string[] }): string[] {
  if (request.filePaths && request.filePaths.length > 0) {
    return request.filePaths;
  }
  if (request.filePath) {
    return [request.filePath];
  }
  return [];
}
```

**Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 4: Commit**

```bash
git add apps/desktop/src/renderer/pages/Execution.tsx
git commit -m "feat(ui): add delete operation helper functions"
```

---

### Task 6: Update File Permission UI for Delete Operations

**Files:**
- Modify: `apps/desktop/src/renderer/pages/Execution.tsx:600-648`

**Step 1: Update the icon section (line 600-609)**

Change:
```typescript
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full shrink-0",
                    permissionRequest.type === 'file' ? "bg-amber-500/10" : "bg-warning/10"
                  )}>
                    {permissionRequest.type === 'file' ? (
                      <File className="h-5 w-5 text-amber-600" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-warning" />
                    )}
                  </div>
```

To:
```typescript
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full shrink-0",
                    isDeleteOperation(permissionRequest) ? "bg-red-500/10" :
                    permissionRequest.type === 'file' ? "bg-amber-500/10" : "bg-warning/10"
                  )}>
                    {isDeleteOperation(permissionRequest) ? (
                      <AlertTriangle className="h-5 w-5 text-red-600" />
                    ) : permissionRequest.type === 'file' ? (
                      <File className="h-5 w-5 text-amber-600" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-warning" />
                    )}
                  </div>
```

**Step 2: Update the title (line 611-613)**

Change:
```typescript
                    <h3 className="text-lg font-semibold text-foreground mb-2">
                      {permissionRequest.type === 'file' ? 'File Permission Required' : 'Permission Required'}
                    </h3>
```

To:
```typescript
                    <h3 className={cn(
                      "text-lg font-semibold mb-2",
                      isDeleteOperation(permissionRequest) ? "text-red-600" : "text-foreground"
                    )}>
                      {isDeleteOperation(permissionRequest)
                        ? 'File Deletion Warning'
                        : permissionRequest.type === 'file'
                          ? 'File Permission Required'
                          : 'Permission Required'}
                    </h3>
```

**Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 4: Commit**

```bash
git add apps/desktop/src/renderer/pages/Execution.tsx
git commit -m "feat(ui): update icon and title for delete operations"
```

---

### Task 7: Add Delete Warning Banner and File List

**Files:**
- Modify: `apps/desktop/src/renderer/pages/Execution.tsx:616-648`

**Step 1: Replace the file permission UI section (line 616-648)**

Replace:
```typescript
                    {/* File permission specific UI */}
                    {permissionRequest.type === 'file' && (
                      <>
                        <div className="mb-3">
                          <span className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
                            getOperationBadgeClasses(permissionRequest.fileOperation)
                          )}>
                            {permissionRequest.fileOperation?.toUpperCase()}
                          </span>
                        </div>

                        <div className="mb-4 p-3 rounded-lg bg-muted">
                          <p className="text-sm font-mono text-foreground break-all">
                            {permissionRequest.filePath}
                          </p>
                          {permissionRequest.targetPath && (
                            <p className="text-sm font-mono text-muted-foreground mt-1">
                              → {permissionRequest.targetPath}
                            </p>
                          )}
                        </div>

                        {permissionRequest.contentPreview && (
                          <details className="mb-4">
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                              Preview content
                            </summary>
                            <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-x-auto max-h-32 overflow-y-auto">
                              {permissionRequest.contentPreview}
                            </pre>
                          </details>
                        )}
                      </>
                    )}
```

With:
```typescript
                    {/* File permission specific UI */}
                    {permissionRequest.type === 'file' && (
                      <>
                        {/* Delete operation warning banner */}
                        {isDeleteOperation(permissionRequest) && (
                          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                            <p className="text-sm text-red-600">
                              {(() => {
                                const paths = getDisplayFilePaths(permissionRequest);
                                return paths.length > 1
                                  ? `${paths.length} files will be permanently deleted:`
                                  : 'This file will be permanently deleted:';
                              })()}
                            </p>
                          </div>
                        )}

                        {/* Non-delete operation badge */}
                        {!isDeleteOperation(permissionRequest) && (
                          <div className="mb-3">
                            <span className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
                              getOperationBadgeClasses(permissionRequest.fileOperation)
                            )}>
                              {permissionRequest.fileOperation?.toUpperCase()}
                            </span>
                          </div>
                        )}

                        {/* File path(s) display */}
                        <div className={cn(
                          "mb-4 p-3 rounded-lg",
                          isDeleteOperation(permissionRequest)
                            ? "bg-red-500/5 border border-red-500/20"
                            : "bg-muted"
                        )}>
                          {(() => {
                            const paths = getDisplayFilePaths(permissionRequest);
                            if (paths.length > 1) {
                              return (
                                <ul className="space-y-1">
                                  {paths.map((path, idx) => (
                                    <li key={idx} className={cn(
                                      "text-sm font-mono break-all",
                                      isDeleteOperation(permissionRequest) ? "text-red-600" : "text-foreground"
                                    )}>
                                      • {path}
                                    </li>
                                  ))}
                                </ul>
                              );
                            }
                            return (
                              <p className={cn(
                                "text-sm font-mono break-all",
                                isDeleteOperation(permissionRequest) ? "text-red-600" : "text-foreground"
                              )}>
                                {paths[0]}
                              </p>
                            );
                          })()}
                          {permissionRequest.targetPath && (
                            <p className="text-sm font-mono text-muted-foreground mt-1">
                              → {permissionRequest.targetPath}
                            </p>
                          )}
                        </div>

                        {/* Delete warning text */}
                        {isDeleteOperation(permissionRequest) && (
                          <p className="text-sm text-red-600/80 mb-4">
                            This action cannot be undone.
                          </p>
                        )}

                        {permissionRequest.contentPreview && (
                          <details className="mb-4">
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                              Preview content
                            </summary>
                            <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-x-auto max-h-32 overflow-y-auto">
                              {permissionRequest.contentPreview}
                            </pre>
                          </details>
                        )}
                      </>
                    )}
```

**Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/pages/Execution.tsx
git commit -m "feat(ui): add delete warning banner and multi-file list"
```

---

### Task 8: Update Allow Button for Delete Operations

**Files:**
- Modify: `apps/desktop/src/renderer/pages/Execution.tsx:677-683`

**Step 1: Update the Allow button**

Change:
```typescript
                      <Button
                        onClick={() => handlePermissionResponse(true)}
                        className="flex-1"
                        data-testid="permission-allow-button"
                      >
                        Allow
                      </Button>
```

To:
```typescript
                      <Button
                        onClick={() => handlePermissionResponse(true)}
                        className={cn(
                          "flex-1",
                          isDeleteOperation(permissionRequest) && "bg-red-600 hover:bg-red-700 text-white"
                        )}
                        data-testid="permission-allow-button"
                      >
                        {isDeleteOperation(permissionRequest)
                          ? getDisplayFilePaths(permissionRequest).length > 1
                            ? 'Delete All'
                            : 'Delete'
                          : 'Allow'}
                      </Button>
```

**Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/pages/Execution.tsx
git commit -m "feat(ui): show red Delete button for delete operations"
```

---

### Task 9: Final Verification

**Step 1: Run full typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 2: Run lint**

```bash
pnpm lint
```

Expected: PASS (or only pre-existing warnings)

**Step 3: Manual test (if dev environment available)**

```bash
pnpm dev
```

Test by asking the agent to delete a file and verify:
- Red warning banner appears
- File path in red-tinted box
- "This action cannot be undone" warning
- Red "Delete" button instead of "Allow"

**Step 4: Final commit (if any remaining changes)**

```bash
git status
# If clean, skip. Otherwise:
git add -A
git commit -m "chore: final cleanup"
```

---

## Summary

This plan implements safe file deletion in 9 tasks:

1. **Task 1:** Create SKILL.md with agent instructions
2. **Task 2:** Add `filePaths` to shared types
3. **Task 3:** Update MCP server to accept `filePaths`
4. **Task 4:** Update permission API to handle `filePaths`
5. **Task 5:** Add UI helper functions
6. **Task 6:** Update icon and title for deletes
7. **Task 7:** Add warning banner and file list
8. **Task 8:** Update button to red "Delete"
9. **Task 9:** Final verification

Total: ~9 commits, incremental and reversible.
