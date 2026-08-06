---
title: OpenClaw Plugin Changelog
---

::OpenclawReleaseTimeline
---
releases:
  - date: '2026-05-08'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.15'
        sections:
          - title: 'Added'
            items:
              - 'Added `activation.onCapabilities: ["hook"]` to the OpenClaw, Moltbot, and ClawDBot plugin manifests.'
              - 'Added compatibility with the plugin loading mechanism introduced in OpenClaw 5.3 and later. OpenClaw evaluates capability declarations before plugin registration; this declaration ensures the plugin is recognized and loaded as a lifecycle hook plugin, allowing hooks such as `before_agent_start` and `agent_end` to continue registering correctly.'
          - title: 'Improved'
            items:
              - 'Adjusted the automatic `hooks.allowConversationAccess: true` patching flow to run after the gateway is ready, allowing the host config update to trigger a gateway restart and apply the required hook permission.'

  - date: '2026-04-29'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.14'
        summary: 'Added compatibility support for the agent_end permission restriction introduced in OpenClaw 2026.4.23 and later: when the gateway starts, the plugin automatically checks the host config and adds `hooks.allowConversationAccess: true` for this plugin, helping users avoid memory-write hook failures caused by missing permissions.'
  - date: '2026-04-16'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.13'
        summary: 'Fully supports shared knowledge base access and collaborative processing in multi-agent mode.'
        sections:
          - title: 'Shared Knowledge Base Support (Multi-Agent Scenario)'
            items:
              - '**Multi-Agent Knowledge Base Support**: Fully supported collaborative access and processing of the knowledge base by multiple agents. Allows different agent nodes to share, retrieve, and invoke data from the same knowledge base, improving knowledge acquisition efficiency and context consistency during multi-agent collaboration in complex tasks.'

  - date: '2026-04-03'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.12'
        summary: 'Introduced local visual configuration interface, deeply refactored configuration resolution architecture, and adapted to OpenClaw plugin security review.'
        sections:
          - title: 'Visual Configuration UI (Config UI)'
            items:
              - '**Local Configuration Service**: Built-in HTTP service provides a plugin management backend, supporting visual configuration viewing and modification in the browser, and real-time synchronization of configuration changes (default URL is `http://127.0.0.1:38463`).'
              - '**Startup Stability Assurance**: Introduced gateway readiness detection (`waitForGatewayReady`) in the service startup process to ensure stable service status.'
              - '**UI Experience Optimization**: Added responsive layout and collapsible floating navigation tools, along with new SVG icons.'
          - title: 'Architecture Optimization & Security Compliance'
            items:
              - '**Security Review Adaptation (Subprocess Removed)**: To comply with strict plugin sandbox and security requirements, completely removed `child_process` `spawn`/`exec` calls. The auto-update mechanism was changed from "silent background download and force update" to "version detection only with manual update command prompts in logs", eliminating the risk of background process escape.'
              - '**Security Review Adaptation (Default Overstep Removed)**: Removed all `default` value settings in the `plugin.json` declaration files to ensure the plugin does not trigger unauthorized or unexpected calls when no explicit configuration is provided.'
              - '**Centralized Schema Management**: Refactored configuration resolution logic (`getConfigResolution`) to centrally manage priority strategies for environment variables, user configurations, and default values, enhancing code security and robustness.'

  - date: '2026-03-30'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.11'
        summary: 'Strengthened fine-grained control for multi-agent scenarios and enhanced dynamic user identity extraction capabilities.'
        sections:
          - title: 'Session & User Identity Management'
            items:
              - '**Direct Session User ID Support**: Added `useDirectSessionUserId` configuration. When enabled, it directly parses and extracts the real session user ID from the `sessionKey`, meeting data isolation needs in complex agent scenarios.'
          - title: 'Multi-Agent Configuration Enhancements'
            items:
              - '**Agent Execution Whitelist**: Added the `allowedAgents` configuration item, allowing memory recall and recording to be triggered only for specific agents in multi-agent mode, avoiding redundant consumption caused by global interception.'
              - '**Differentiated Override Mechanism (Agent Overrides)**: Introduced the `agentOverrides` configuration object, supporting individual overrides for core parameters such as knowledge base IDs (`knowledgebaseIds`), recall limit (`memoryLimitNumber`), and feature switches (`recallEnabled`) for different agents.'

  - date: '2026-03-24'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.10'
        sections:
          - items:
            - '**Improved memory ingestion quality:** Added and strengthened cleanup for OpenClaw inbound metadata, timestamp wrappers, and trailing Feishu system hints to reduce noisy writes into memory.'
            - '**Multi-channel message prefix cleanup improvements**: Expanded and standardized envelope/prefix stripping for channels such as WebChat, WhatsApp, Telegram, Slack, Discord, and Zalo, reducing platform wrapper noise in memory ingestion and recall quality.'
            - '**More accurate recall display**: Recall timestamps now prioritize update time for better temporal consistency.'
            - '**More robust Recall Filter**: Default parameters are aligned with runtime fallback values (timeout and retries), improving stability in local model scenarios.'
            - '**Timeout and resource management optimization**: Fixed timer cleanup behavior to prevent resource leaks on exceptional code paths.'
            - '**Configuration completeness**: Completed Recall Filter-related fields in the plugin schema for more complete and controllable configuration.'
            - '**Enhanced observability**: Added before/after filtering count logs to make recall quality and filter effect troubleshooting easier.'
  - date: '2026-03-13'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.9'
        summary: 'Silent upgrade and memory recall optimization. This release includes the following improvements to enhance usability and Token efficiency:'
        sections:
          - title: 'Silent Self-Detection and Upgrade'
            items:
              - 'Added a plugin version self-check mechanism that periodically checks the latest version from the NPM registry in the background.'
              - 'When a new version is detected, a silent upgrade is triggered automatically so users can continuously receive the latest capabilities and fixes without manual actions.'
          - title: 'Support Custom Models for Memory Recall'
            items:
              - 'Introduced LLM-based secondary filtering for memory recall.'
              - 'Added configuration options such as recallFilterModel and recallFilterBaseUrl, allowing an independent model to evaluate relevance.'
              - 'Effectively removes noisy results and keeps only memory snippets that are truly useful for the current conversation.'
          - title: 'Lean Prompt Injection (System Prompt Optimization)'
            items:
              - 'Refactored memory injection logic by moving static protocols and instructions to appendSystemContext.'
              - 'prependContext now keeps only dynamically retrieved memory-list data.'
              - 'Significantly reduces Token usage caused by repetitive prompts and improves model focus on core memory.'
  - date: '2026-03-09'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.8'
        summary: 'Added support for multi-agent mode, enabling agent identification from context for memory isolation, with a compatibility switch for older versions.'

  - date: '2026-03-05'
    plugins:
      - title: 'Cloud Plugin'
        version: 'v0.1.7'
        summary: 'Added support for user-defined relativity in the searchMemory API.'

  - date: '2026-02-26'
    plugins:
      - title: 'Cloud Plugin'
        version: 'Other Historical Versions (Core Capabilities)'
        summary: 'Supports searchMemory in the before_agent_start event and addMessage in the agent_end event.'
---
::
