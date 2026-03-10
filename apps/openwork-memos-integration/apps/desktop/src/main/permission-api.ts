/**
 * Permission API Server
 *
 * HTTP server that the file-permission MCP server calls to request
 * user permission for file operations. This bridges the MCP server
 * (separate process) with the Electron UI.
 */

import http from 'http';
import type { BrowserWindow } from 'electron';
import type { PermissionRequest, FileOperation } from '@accomplish/shared';

export const PERMISSION_API_PORT = 9226;
export const QUESTION_API_PORT = 9227;

interface PendingPermission {
  resolve: (allowed: boolean) => void;
  timeoutId: NodeJS.Timeout;
}

interface PendingQuestion {
  resolveWithData: (data: { selectedOptions?: string[]; customText?: string; denied?: boolean }) => void;
  timeoutId: NodeJS.Timeout;
}

// Store pending permission requests waiting for user response
const pendingPermissions = new Map<string, PendingPermission>();

// Store pending question requests waiting for user response
const pendingQuestions = new Map<string, PendingQuestion>();

// Store reference to main window and task manager
let mainWindow: BrowserWindow | null = null;
let getActiveTaskId: (() => string | null) | null = null;

/**
 * Initialize the permission API with dependencies
 */
export function initPermissionApi(
  window: BrowserWindow,
  taskIdGetter: () => string | null
): void {
  mainWindow = window;
  getActiveTaskId = taskIdGetter;
}

/**
 * Resolve a pending permission request from the MCP server
 * Called when user responds via the UI
 */
export function resolvePermission(requestId: string, allowed: boolean): boolean {
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeoutId);
  pending.resolve(allowed);
  pendingPermissions.delete(requestId);
  return true;
}

/**
 * Resolve a pending question request from the MCP server
 * Called when user responds via the UI
 */
export function resolveQuestion(
  requestId: string,
  response: { selectedOptions?: string[]; customText?: string; denied?: boolean }
): boolean {
  const pending = pendingQuestions.get(requestId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeoutId);
  pending.resolveWithData(response);
  pendingQuestions.delete(requestId);
  return true;
}

/**
 * Generate a unique request ID for file permissions
 */
function generateRequestId(): string {
  return `filereq_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Generate a unique request ID for questions
 */
function generateQuestionRequestId(): string {
  return `questionreq_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Create and start the HTTP server for permission requests
 */
export function startPermissionApiServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Only handle POST /permission
    if (req.method !== 'POST' || req.url !== '/permission') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: {
      operation?: string;
      filePath?: string;
      filePaths?: string[];
      targetPath?: string;
      contentPreview?: string;
    };

    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Validate required fields
    if (!data.operation || (!data.filePath && (!data.filePaths || data.filePaths.length === 0))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'operation and either filePath or filePaths are required' }));
      return;
    }

    // Validate operation type
    const validOperations = ['create', 'delete', 'rename', 'move', 'modify', 'overwrite'];
    if (!validOperations.includes(data.operation)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid operation. Must be one of: ${validOperations.join(', ')}` }));
      return;
    }

    // Check if we have the necessary dependencies
    if (!mainWindow || mainWindow.isDestroyed() || !getActiveTaskId) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Permission API not initialized' }));
      return;
    }

    const taskId = getActiveTaskId();
    if (!taskId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active task' }));
      return;
    }

    const requestId = generateRequestId();

    // Create permission request for the UI
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

    // Send to renderer
    mainWindow.webContents.send('permission:request', permissionRequest);

    // Wait for user response (with 5 minute timeout)
    const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

    try {
      const allowed = await new Promise<boolean>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingPermissions.delete(requestId);
          reject(new Error('Permission request timed out'));
        }, PERMISSION_TIMEOUT_MS);

        pendingPermissions.set(requestId, { resolve, timeoutId });
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed }));
    } catch (error) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timed out', allowed: false }));
    }
  });

  server.listen(PERMISSION_API_PORT, '127.0.0.1', () => {
    console.log(`[Permission API] Server listening on port ${PERMISSION_API_PORT}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`[Permission API] Port ${PERMISSION_API_PORT} already in use, skipping server start`);
    } else {
      console.error('[Permission API] Server error:', error);
    }
  });

  return server;
}

/**
 * Create and start the HTTP server for question requests
 */
export function startQuestionApiServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Only handle POST /question
    if (req.method !== 'POST' || req.url !== '/question') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: {
      question?: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    };

    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Validate required fields
    if (!data.question) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'question is required' }));
      return;
    }

    // Check if we have the necessary dependencies
    if (!mainWindow || mainWindow.isDestroyed() || !getActiveTaskId) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Question API not initialized' }));
      return;
    }

    const taskId = getActiveTaskId();
    if (!taskId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active task' }));
      return;
    }

    const requestId = generateQuestionRequestId();

    // Create question request for the UI
    const questionRequest: PermissionRequest = {
      id: requestId,
      taskId,
      type: 'question',
      question: data.question,
      header: data.header,
      options: data.options,
      multiSelect: data.multiSelect,
      createdAt: new Date().toISOString(),
    };

    // Send to renderer
    mainWindow.webContents.send('permission:request', questionRequest);

    // Wait for user response (with 5 minute timeout)
    const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

    try {
      const response = await new Promise<{ selectedOptions?: string[]; customText?: string; denied?: boolean }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingQuestions.delete(requestId);
          reject(new Error('Question request timed out'));
        }, QUESTION_TIMEOUT_MS);

        pendingQuestions.set(requestId, { resolveWithData: resolve, timeoutId });
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timed out', denied: true }));
    }
  });

  server.listen(QUESTION_API_PORT, '127.0.0.1', () => {
    console.log(`[Question API] Server listening on port ${QUESTION_API_PORT}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`[Question API] Port ${QUESTION_API_PORT} already in use, skipping server start`);
    } else {
      console.error('[Question API] Server error:', error);
    }
  });

  return server;
}

/**
 * Check if a request ID is a file permission request from the MCP server
 */
export function isFilePermissionRequest(requestId: string): boolean {
  return requestId.startsWith('filereq_');
}

/**
 * Check if a request ID is a question request from the MCP server
 */
export function isQuestionRequest(requestId: string): boolean {
  return requestId.startsWith('questionreq_');
}
