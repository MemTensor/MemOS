# MemOS 项目记忆插件

独立本地服务、SQLite、Viewer、Agent 适配与 `memos-pm search`。云端负责记忆整理；插件负责采集用户任务、工具执行和助手回复，按项目绑定的 Space 列表上传与检索。

当前为开发验证版：公共链路及独立安装已通过 Mock 验证，**尚未达到全部 22 宿主与真实 MemOS 的完整验收条件**。具体缺口见 [兼容性](docs/compatibility.md) 和 [验证记录](docs/verification.md)。未发布 npm。

## 源码部署（开发阶段）

需要 Node.js ≥24.12（本次实际验证 26.4.0）。在本目录：

```sh
npm ci
npm run build
npm link
npm run viewer
```

`npm run build` 仅编译 TypeScript 到 `dist/`，不生成安装包。`npm link` 将当前源码目录链接到全局 npm，并注册 `memos-pm` 命令；可用 `command -v memos-pm` 检查。Agent 启动环境需能找到该命令。

构建后，重新运行 Viewer 或新的 CLI 调用会核对后台服务的 API 版本与构建标记，必要时在同一端口优雅更新受管实例，保留原 SQLite 数据。浏览器遇到旧版服务会明确提示更新，不把旧字段误显示为“未绑定 Space”或“待识别”。

Viewer 会启动独立本地服务并打开浏览器。也可用 `npm start` 前台启动，终端显示访问地址。服务只监听 `127.0.0.1`。默认数据目录 `~/.memos-project-memory`；配置 API 基址和 Key 后，在 Viewer 选择 Agent、下拉选择已有本地项目，输入 Space ID 完成绑定，并安装相应 Agent 接入。项目名称和目录由记录自动取得，无需手动创建项目。

项目列表合并该 Agent 的宿主记录与插件已采集的会话目录。宿主记录直接发现覆盖 Claude Code、Codex CLI、DeepSeek Harness、Kimi、WorkBuddy、Pi 和 OpenCode v1/v2；其他宿主在接入后通过已采集会话提供目录。选择项目只读取记录；校验 Space 可访问后，复用 SQLite 的项目和绑定表保存关联。同一目录在不同 Agent 中共用关联；接入已有独立会话时合并它们的 Space 列表、任务及批次。尚待确认的创建操作和云连接不匹配仍会阻止绑定。

一个项目可以绑定零个、一个或多个 Space。第一个卡片负责追加绑定；第二个卡片按 Agent 名称、项目名称及 Space 数量展示关系，不显示目录路径。点击数量打开右侧抽屉，展开 Space 名称与编码；编码右侧依次提供复制、解绑图标。解绑只删除 SQLite 当前关联，保留云端 Space、轨迹和历史发送记录。删除最后一个后项目仍存在，后续上传等待重新绑定。

Hook 安装器在 Homebrew 环境优先保留指向当前 Node 的稳定 `opt/<formula>/bin/node` 入口，避免固定到具体 Cellar 版本；无匹配入口时沿用当前 Node 路径。源码目录移动后，在 Viewer 中执行“修复接入”更新脚本路径。

源码开发可执行 `npm run dev`。宿主接入的安装/修复/卸载都在 Viewer 操作；不会自动改动所有宿主配置。宿主须重启，原生信任确认仍由宿主处理。DSH 接入会写入 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`）的插件专属配置块，保留其他配置；安装后直接 `dsh web` 等正常启动即可。

普通会话与空查询不创建 Space。已登记项目的绑定列表为空时不上传、不自动创建 Space；从未绑定的独立任务仍可在首次上传前创建。暂停只阻止发送，采集继续；恢复不会重发已终止失败批次。每个批次一次请求携带全部当前绑定的 `space_ids`，重试不向已经解绑的 Space 发送。

## 任务轨迹

列表按用户轮次归组，每轮一个白色摘要框；点击打开右侧详情。user、tool use、tool result、thinking、answer 五类按顺序折叠展示，展开后可查看完整内容，长文本在框内滚动。分页按轮次进行，不拆开同一轮。

采集过程中只保存轨迹；宿主结束整轮任务后，创建一个上传批次。上传直接使用确定后的完整消息快照，不重复拼接。重复结束通知不会重复建批。

会话页只展示用户任务、执行过程、助手回复；采集入库与上传使用同一筛选规则。插件注入和宿主临时提示、运行状态不作为项目记忆上传。上传状态单独记录在批次中。旧数据库升级时会先备份，再清理非任务轨迹并修正待上传内容。

## CLI

唯一公开业务命令：

```sh
memos-pm search --session-id <宿主提供的ID> --conversation-id <当前用户轮ID> --query "接口约定"
```

`FOUND` / `EMPTY` 退出 0；`INVALID_QUERY` / `CONTEXT_MISSING` / `UNAVAILABLE` 退出 1。stdout 为单个 JSON 对象。不要猜测标识或复用旧轮标识；共享 Skill 随适配器部署。

一条 search 命令由本地服务补齐项目的全部 `space_ids`，只发起一次云端检索，无需按 Space 重复调用，也不增加模型侧 Space 参数。

## Mock 与验证

在独立终端：

```sh
npm run mock
MEMOS_PM_DATA_DIR=/tmp/memos-project-memory-demo npm run viewer
```

测试 Viewer 中填 API 基址 `http://127.0.0.1:8711/api/openmem/v1`、Key `mock-key`。Mock 主题是固定测试数据，不执行记忆抽取；Mock 重启清空内存数据，应配合新的测试数据目录。不要把 Mock 空间绑定到生产数据目录。

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

`lint` 当前执行源代码语法静态检查；类型检查独立执行。

## 开发阶段约定

当前使用源码目录部署，不执行 `npm pack` 或 `npm run test:package`，不生成/发布安装包。已有 `.tgz` 已删除。打包脚本保留供后续发布阶段使用，不在上述开发验证命令中执行。

[本地 API](docs/local-api.md) · [契约](docs/contracts.md) · [复用范围](docs/reuse.md)
