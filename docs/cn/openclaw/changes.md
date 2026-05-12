---
title: OpenClaw 插件更新日志
---

::OpenclawReleaseTimeline
---
releases:
  - date: '2026-05-08'
    plugins:
      - title: '云插件'
        version: 'v0.1.15'
        sections:
          - title: '新增'
            items:
              - '为 OpenClaw / Moltbot / ClawDBot 插件清单新增 `activation.onCapabilities: ["hook"]` 能力声明。'
              - '适配 OpenClaw 5.3 及其之后版本的插件加载机制：OpenClaw 会在插件注册前基于能力声明判断插件是否应被加载。该声明确保本插件作为 lifecycle hook 插件能够被正确识别和加载，从而继续注册 `before_agent_start`、`agent_end` 等 hook。'
          - title: '改进'
            items:
              - '调整 `hooks.allowConversationAccess: true` 的自动补充时机，在 gateway 就绪后再写入宿主配置，使宿主配置更新能够触发 gateway 自动重启并应用所需的 hook 权限。'

  - date: '2026-04-29'
    plugins:
      - title: '云插件'
        version: 'v0.1.14'
        summary: '适配 OpenClaw 2026.4.23 及其之后版本对 agent_end 的权限限制：插件会在启动 gateway 时自动检查配置，并为插件补充 `hooks.allowConversationAccess: true`，帮助用户避免因缺少该配置导致记忆写入相关 hook 无法正常工作。'

  - date: '2026-04-16'
    plugins:
      - title: '云插件'
        version: 'v0.1.13'
        summary: '全面支持多 Agent 模式下的共享知识库访问与协同处理。'
        sections:
          - title: '共享知识库支持（多 Agent 场景）'
            items:
              - '**多 Agent 知识库支持**：全面支持了多 Agent 对知识库的协同访问与处理。允许不同的 Agent 节点共享、检索和调用同一个知识库中的数据，提升了复杂任务下多智能体协作时的知识获取效率与上下文一致性。'

  - date: '2026-04-03'
    plugins:
      - title: '云插件'
        version: 'v0.1.12'
        summary: '推出本地可视化配置界面，深度重构配置解析架构并适配 OpenClaw 插件安全审查。'
        sections:
          - title: '可视化配置 UI (Config UI)'
            items:
              - '**本地配置服务**：内置 HTTP 服务提供插件管理后台，支持在浏览器中可视化查看与修改配置，并实现配置变更的实时同步（默认访问地址为 `http://127.0.0.1:38463`）。'
              - '**启动稳定性保障**：服务启动流程中引入了网关就绪检测 (`waitForGatewayReady`)，确保服务状态稳定。'
              - '**界面体验优化**：新增响应式布局与可折叠悬浮导航工具，并补充了全新的 SVG 图标。'
          - title: '架构优化与安全合规'
            items:
              - '**适配插件安全审查（移除子进程）**：为了符合严格的插件沙箱与安全合规要求，完全移除了 `child_process` 的 `spawn`/`exec` 调用。插件自更新机制由原来的“后台静默下载并强制更新”改为了“仅检测版本并在日志中打印手动更新命令提示”，避免后台进程逃逸风险。'
              - '**适配插件安全审查（移除默认越权）**：移除了 `plugin.json` 声明文件中的所有 `default` 默认值设定，确保插件在无显式配置时不会触发越权或非预期调用。'
              - '**配置 Schema 集中管理**：重构配置解析逻辑 (`getConfigResolution`)，集中管理环境变量、用户配置与默认值的优先级策略，提升了代码的安全性和健壮性。'

  - date: '2026-03-30'
    plugins:
      - title: '云插件'
        version: 'v0.1.11'
        summary: '强化多 Agent 场景的细粒度控制，增强动态用户标识提取能力。'
        sections:
          - title: '会话与用户身份管理'
            items:
              - '**Direct Session User ID 支持**：新增 `useDirectSessionUserId` 配置，开启后可直接从 `sessionKey` 中解析并提取真实会话的用户 ID，满足复杂代理场景下的数据隔离需求。'
          - title: '多 Agent 配置增强'
            items:
              - '**Agent 运行白名单**：新增 `allowedAgents` 配置项，允许在多 Agent 模式下仅对特定的 Agent 触发记忆召回和记录，避免全局拦截带来的冗余消耗。'
              - '**差异化覆盖机制 (Agent Overrides)**：引入 `agentOverrides` 配置对象，支持针对不同的 Agent 单独覆盖如知识库 ID (`knowledgebaseIds`)、召回条数 (`memoryLimitNumber`)、功能开关 (`recallEnabled`) 等核心参数。'

  - date: '2026-03-24'
    plugins:
      - title: '云插件'
        version: 'v0.1.10'
        sections:
          - items:
            - '**消息入库质量提升**：新增并强化对 OpenClaw 入站元数据、时间戳包裹、飞书尾部系统提示的清洗，减少无效噪音写入记忆。'
            - '**多渠道消息前缀清洗优化**：扩展并统一处理 WebChat、WhatsApp、Telegram、Slack、Discord、Zalo 等 channel 的消息 envelope/前缀，降低平台包装信息对记忆写入与召回质量的干扰。'
            - '**召回展示更准确**：召回结果时间展示优先使用更新时间，提升时间语义一致性。'
            - '**Recall Filter 更稳健**：默认参数与运行时回退值（超时、重试）保持对齐，提升本地模型场景稳定性。'
            - '**超时与资源管理优化**：修复定时器清理问题，避免异常路径下的资源泄漏。'
            - '**配置能力补全**：插件 schema 补齐 Recall Filter 相关字段，配置更完整、可控性更强。'
            - '**可观测性增强**：增加过滤前后数量日志，便于排查召回质量与过滤效果。'
  - date: '2026-03-13'
    plugins:
      - title: '云插件'
        version: 'v0.1.9'
        summary: '无感升级与记忆召回优化。本次更新主要包含以下改进，旨在提升插件的易用性与 Token 利用率：'
        sections:
          - title: '插件无感自检测升级'
            items:
              - '新增插件版本自检测机制，后台定期检查 NPM 仓库最新版本。'
              - '检测到新版本后自动触发静默升级流程，用户无需手动操作即可持续获取最新能力与修复。'
          - title: '支持用户配置模型进行 Memory Recall'
            items:
              - '引入基于 LLM 的记忆二次筛选能力。'
              - '新增 recallFilterModel、recallFilterBaseUrl 等配置项，可指定独立模型进行相关性评审。'
              - '可有效剔除干扰项，仅保留对当前对话真正有用的记忆片段。'
          - title: '对话注入瘦身（System Prompt 优化）'
            items:
              - '重构记忆注入逻辑，将静态协议与指令移动到 appendSystemContext。'
              - 'prependContext 仅保留动态检索得到的 memory-list 数据。'
              - '显著降低重复提示词带来的 Token 消耗，并提升模型对核心记忆的聚焦。'
  - date: '2026-03-09'
    plugins:
      - title: '云插件'
        version: 'v0.1.8'
        summary: '支持用户开启多Agent模式，实现从上下文中识别agent进行记忆隔离，同时做了开关，兼容旧版本。'

  - date: '2026-03-05'
    plugins:
      - title: '云插件'
        version: 'v0.1.7'
        summary: '支持用户自定义searchMemory接口的relativity字段。'

  - date: '2026-02-26'
    plugins:
      - title: '云插件'
        version: '其他历史版本（基础功能）'
        summary: '支持 before_agent_start 事件中 searchMemory、在 agent_end 事件中进行 addMessage。'
---
::
