/**
 * CDP Relay Server for Chrome Extension mode
 *
 * This server acts as a bridge between Playwright clients and a Chrome extension.
 * Instead of launching a browser, it waits for the extension to connect and
 * forwards CDP commands/events between them.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";

// ============================================================================
// Types
// ============================================================================

export interface RelayOptions {
  port?: number;
  host?: string;
}

export interface RelayServer {
  wsEndpoint: string;
  port: number;
  stop(): Promise<void>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
}

interface ConnectedTarget {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
}

interface PlaywrightClient {
  id: string;
  ws: WSContext;
  knownTargets: Set<string>; // targetIds this client has received attachedToTarget for
}

// Message types for extension communication
interface ExtensionCommandMessage {
  id: number;
  method: "forwardCDPCommand";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

interface ExtensionResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

interface ExtensionEventMessage {
  method: "forwardCDPEvent";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | { method: "log"; params: { level: string; args: string[] } };

// CDP message types
interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CDPResponse {
  id: number;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}

interface CDPEvent {
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

// ============================================================================
// Relay Server Implementation
// ============================================================================

export async function serveRelay(options: RelayOptions = {}): Promise<RelayServer> {
  // Accomplish uses port 9224 to avoid conflicts with Claude Code's dev-browser (9222)
  const port = options.port ?? 9224;
  const host = options.host ?? "127.0.0.1";

  // State
  const connectedTargets = new Map<string, ConnectedTarget>();
  const namedPages = new Map<string, string>(); // name -> sessionId
  const playwrightClients = new Map<string, PlaywrightClient>();
  let extensionWs: WSContext | null = null;

  // Pending requests to extension
  const extensionPendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let extensionMessageId = 0;

  // ============================================================================
  // Helper Functions
  // ============================================================================

  function log(...args: unknown[]) {
    console.log("[relay]", ...args);
  }

  function sendToPlaywright(message: CDPResponse | CDPEvent, clientId?: string) {
    const messageStr = JSON.stringify(message);

    if (clientId) {
      const client = playwrightClients.get(clientId);
      if (client) {
        client.ws.send(messageStr);
      }
    } else {
      // Broadcast to all clients
      for (const client of playwrightClients.values()) {
        client.ws.send(messageStr);
      }
    }
  }

  /**
   * Send Target.attachedToTarget event with deduplication.
   * Tracks which targets each client has seen to prevent "Duplicate target" errors.
   */
  function sendAttachedToTarget(
    target: ConnectedTarget,
    clientId?: string,
    waitingForDebugger = false
  ) {
    const event: CDPEvent = {
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.sessionId,
        targetInfo: { ...target.targetInfo, attached: true },
        waitingForDebugger,
      },
    };

    if (clientId) {
      const client = playwrightClients.get(clientId);
      if (client && !client.knownTargets.has(target.targetId)) {
        client.knownTargets.add(target.targetId);
        client.ws.send(JSON.stringify(event));
      }
    } else {
      // Broadcast to all clients that don't know about this target yet
      for (const client of playwrightClients.values()) {
        if (!client.knownTargets.has(target.targetId)) {
          client.knownTargets.add(target.targetId);
          client.ws.send(JSON.stringify(event));
        }
      }
    }
  }

  async function sendToExtension({
    method,
    params,
    timeout = 30000,
  }: {
    method: string;
    params?: Record<string, unknown>;
    timeout?: number;
  }): Promise<unknown> {
    if (!extensionWs) {
      throw new Error("Extension not connected");
    }

    const id = ++extensionMessageId;
    const message = { id, method, params };

    extensionWs.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        extensionPendingRequests.delete(id);
        reject(new Error(`Extension request timeout after ${timeout}ms: ${method}`));
      }, timeout);

      extensionPendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });
  }

  async function routeCdpCommand({
    method,
    params,
    sessionId,
  }: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<unknown> {
    // Handle some CDP commands locally
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/Extension-Bridge",
          revision: "1.0.0",
          userAgent: "dev-browser-relay/1.0.0",
          jsVersion: "V8",
        };

      case "Browser.setDownloadBehavior":
        return {};

      case "Target.setAutoAttach":
        if (sessionId) {
          break; // Forward to extension for child frames
        }
        return {};

      case "Target.setDiscoverTargets":
        return {};

      case "Target.attachToBrowserTarget":
        // Browser-level session - return a fake session since we only proxy tabs
        return { sessionId: "browser" };

      case "Target.detachFromTarget":
        // If detaching from our fake "browser" session, just return success
        if (sessionId === "browser" || params?.sessionId === "browser") {
          return {};
        }
        // Otherwise forward to extension
        break;

      case "Target.attachToTarget": {
        const targetId = params?.targetId as string;
        if (!targetId) {
          throw new Error("targetId is required for Target.attachToTarget");
        }

        for (const target of connectedTargets.values()) {
          if (target.targetId === targetId) {
            return { sessionId: target.sessionId };
          }
        }

        throw new Error(`Target ${targetId} not found in connected targets`);
      }

      case "Target.getTargetInfo": {
        const targetId = params?.targetId as string;

        if (targetId) {
          for (const target of connectedTargets.values()) {
            if (target.targetId === targetId) {
              return { targetInfo: target.targetInfo };
            }
          }
        }

        if (sessionId) {
          const target = connectedTargets.get(sessionId);
          if (target) {
            return { targetInfo: target.targetInfo };
          }
        }

        // Return first target if no specific one requested
        const firstTarget = Array.from(connectedTargets.values())[0];
        return { targetInfo: firstTarget?.targetInfo };
      }

      case "Target.getTargets":
        return {
          targetInfos: Array.from(connectedTargets.values()).map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        };

      case "Target.createTarget":
      case "Target.closeTarget":
        // Forward to extension
        return await sendToExtension({
          method: "forwardCDPCommand",
          params: { method, params },
        });
    }

    // Forward all other commands to extension
    return await sendToExtension({
      method: "forwardCDPCommand",
      params: { sessionId, method, params },
    });
  }

  // ============================================================================
  // HTTP/WebSocket Server
  // ============================================================================

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Health check / server info
  app.get("/", (c) => {
    return c.json({
      wsEndpoint: `ws://${host}:${port}/cdp`,
      extensionConnected: extensionWs !== null,
      mode: "extension",
    });
  });

  // List named pages
  app.get("/pages", (c) => {
    return c.json({
      pages: Array.from(namedPages.keys()),
    });
  });

  // Get or create a named page
  app.post("/pages", async (c) => {
    const body = await c.req.json();
    const name = body.name as string;

    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    // Check if page already exists by name
    const existingSessionId = namedPages.get(name);
    if (existingSessionId) {
      const target = connectedTargets.get(existingSessionId);
      if (target) {
        // Activate the tab so it becomes the active tab
        await sendToExtension({
          method: "forwardCDPCommand",
          params: {
            method: "Target.activateTarget",
            params: { targetId: target.targetId },
          },
        });
        return c.json({
          wsEndpoint: `ws://${host}:${port}/cdp`,
          name,
          targetId: target.targetId,
          url: target.targetInfo.url,
        });
      }
      // Session no longer valid, remove it
      namedPages.delete(name);
    }

    // Create a new tab
    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    try {
      const result = (await sendToExtension({
        method: "forwardCDPCommand",
        params: { method: "Target.createTarget", params: { url: "about:blank" } },
      })) as { targetId: string };

      // Wait for Target.attachedToTarget event to register the new target
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Find and name the new target
      for (const [sessionId, target] of connectedTargets) {
        if (target.targetId === result.targetId) {
          namedPages.set(name, sessionId);
          // Activate the tab so it becomes the active tab
          await sendToExtension({
            method: "forwardCDPCommand",
            params: {
              method: "Target.activateTarget",
              params: { targetId: target.targetId },
            },
          });
          return c.json({
            wsEndpoint: `ws://${host}:${port}/cdp`,
            name,
            targetId: target.targetId,
            url: target.targetInfo.url,
          });
        }
      }

      throw new Error("Target created but not found in registry");
    } catch (err) {
      log("Error creating tab:", err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Delete a named page (removes the name, doesn't close the tab)
  app.delete("/pages/:name", (c) => {
    const name = c.req.param("name");
    const deleted = namedPages.delete(name);
    return c.json({ success: deleted });
  });

  // ============================================================================
  // Playwright Client WebSocket
  // ============================================================================

  app.get(
    "/cdp/:clientId?",
    upgradeWebSocket((c) => {
      const clientId =
        c.req.param("clientId") || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return {
        onOpen(_event, ws) {
          if (playwrightClients.has(clientId)) {
            log(`Rejecting duplicate client ID: ${clientId}`);
            ws.close(1000, "Client ID already connected");
            return;
          }

          playwrightClients.set(clientId, { id: clientId, ws, knownTargets: new Set() });
          log(`Playwright client connected: ${clientId}`);
        },

        async onMessage(event, _ws) {
          let message: CDPCommand;

          try {
            message = JSON.parse(event.data.toString());
          } catch {
            return;
          }

          const { id, sessionId, method, params } = message;

          if (!extensionWs) {
            sendToPlaywright(
              {
                id,
                sessionId,
                error: { message: "Extension not connected" },
              },
              clientId
            );
            return;
          }

          try {
            const result = await routeCdpCommand({ method, params, sessionId });

            // After Target.setAutoAttach, send attachedToTarget for existing targets
            // Uses deduplication to prevent "Duplicate target" errors
            if (method === "Target.setAutoAttach" && !sessionId) {
              for (const target of connectedTargets.values()) {
                sendAttachedToTarget(target, clientId);
              }
            }

            // After Target.setDiscoverTargets, send targetCreated events
            if (
              method === "Target.setDiscoverTargets" &&
              (params as { discover?: boolean })?.discover
            ) {
              for (const target of connectedTargets.values()) {
                sendToPlaywright(
                  {
                    method: "Target.targetCreated",
                    params: {
                      targetInfo: { ...target.targetInfo, attached: true },
                    },
                  },
                  clientId
                );
              }
            }

            // After Target.attachToTarget, send attachedToTarget event (with deduplication)
            if (
              method === "Target.attachToTarget" &&
              (result as { sessionId?: string })?.sessionId
            ) {
              const targetId = params?.targetId as string;
              const target = Array.from(connectedTargets.values()).find(
                (t) => t.targetId === targetId
              );
              if (target) {
                sendAttachedToTarget(target, clientId);
              }
            }

            sendToPlaywright({ id, sessionId, result }, clientId);
          } catch (e) {
            log("Error handling CDP command:", method, e);
            sendToPlaywright(
              {
                id,
                sessionId,
                error: { message: (e as Error).message },
              },
              clientId
            );
          }
        },

        onClose() {
          playwrightClients.delete(clientId);
          log(`Playwright client disconnected: ${clientId}`);
        },

        onError(event) {
          log(`Playwright WebSocket error [${clientId}]:`, event);
        },
      };
    })
  );

  // ============================================================================
  // Extension WebSocket
  // ============================================================================

  app.get(
    "/extension",
    upgradeWebSocket(() => {
      return {
        onOpen(_event, ws) {
          if (extensionWs) {
            log("Closing existing extension connection");
            extensionWs.close(4001, "Extension Replaced");

            // Clear state
            connectedTargets.clear();
            namedPages.clear();
            for (const pending of extensionPendingRequests.values()) {
              pending.reject(new Error("Extension connection replaced"));
            }
            extensionPendingRequests.clear();
          }

          extensionWs = ws;
          log("Extension connected");
        },

        async onMessage(event, ws) {
          let message: ExtensionMessage;

          try {
            message = JSON.parse(event.data.toString());
          } catch {
            ws.close(1000, "Invalid JSON");
            return;
          }

          // Handle response to our request
          if ("id" in message && typeof message.id === "number") {
            const pending = extensionPendingRequests.get(message.id);
            if (!pending) {
              log("Unexpected response with id:", message.id);
              return;
            }

            extensionPendingRequests.delete(message.id);

            if ((message as ExtensionResponseMessage).error) {
              pending.reject(new Error((message as ExtensionResponseMessage).error));
            } else {
              pending.resolve((message as ExtensionResponseMessage).result);
            }
            return;
          }

          // Handle log messages
          if ("method" in message && message.method === "log") {
            const { level, args } = message.params;
            console.log(`[extension:${level}]`, ...args);
            return;
          }

          // Handle CDP events from extension
          if ("method" in message && message.method === "forwardCDPEvent") {
            const eventMsg = message as ExtensionEventMessage;
            const { method, params, sessionId } = eventMsg.params;

            // Handle target lifecycle events
            if (method === "Target.attachedToTarget") {
              const targetParams = params as {
                sessionId: string;
                targetInfo: TargetInfo;
              };

              const target: ConnectedTarget = {
                sessionId: targetParams.sessionId,
                targetId: targetParams.targetInfo.targetId,
                targetInfo: targetParams.targetInfo,
              };
              connectedTargets.set(targetParams.sessionId, target);

              log(`Target attached: ${targetParams.targetInfo.url} (${targetParams.sessionId})`);

              // Use deduplication helper - only sends to clients that don't know about this target
              sendAttachedToTarget(target);
            } else if (method === "Target.detachedFromTarget") {
              const detachParams = params as { sessionId: string };
              connectedTargets.delete(detachParams.sessionId);

              // Also remove any name mapping
              for (const [name, sid] of namedPages) {
                if (sid === detachParams.sessionId) {
                  namedPages.delete(name);
                  break;
                }
              }

              log(`Target detached: ${detachParams.sessionId}`);

              sendToPlaywright({
                method: "Target.detachedFromTarget",
                params: detachParams,
              });
            } else if (method === "Target.targetInfoChanged") {
              const infoParams = params as { targetInfo: TargetInfo };
              for (const target of connectedTargets.values()) {
                if (target.targetId === infoParams.targetInfo.targetId) {
                  target.targetInfo = infoParams.targetInfo;
                  break;
                }
              }

              sendToPlaywright({
                method: "Target.targetInfoChanged",
                params: infoParams,
              });
            } else {
              // Forward other CDP events to Playwright
              sendToPlaywright({
                sessionId,
                method,
                params,
              });
            }
          }
        },

        onClose(_event, ws) {
          if (extensionWs && extensionWs !== ws) {
            log("Old extension connection closed");
            return;
          }

          log("Extension disconnected");

          for (const pending of extensionPendingRequests.values()) {
            pending.reject(new Error("Extension connection closed"));
          }
          extensionPendingRequests.clear();

          extensionWs = null;
          connectedTargets.clear();
          namedPages.clear();

          // Close all Playwright clients
          for (const client of playwrightClients.values()) {
            client.ws.close(1000, "Extension disconnected");
          }
          playwrightClients.clear();
        },

        onError(event) {
          log("Extension WebSocket error:", event);
        },
      };
    })
  );

  // ============================================================================
  // Start Server
  // ============================================================================

  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  const wsEndpoint = `ws://${host}:${port}/cdp`;

  log("CDP relay server started");
  log(`  HTTP: http://${host}:${port}`);
  log(`  CDP endpoint: ${wsEndpoint}`);
  log(`  Extension endpoint: ws://${host}:${port}/extension`);
  log("");
  log("Waiting for extension to connect...");

  return {
    wsEndpoint,
    port,
    async stop() {
      for (const client of playwrightClients.values()) {
        client.ws.close(1000, "Server stopped");
      }
      playwrightClients.clear();
      extensionWs?.close(1000, "Server stopped");
      server.close();
    },
  };
}
