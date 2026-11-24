# 开发验证记录

## 项目概览按 Space 缓存与六小时会话开启刷新（2026-11-24）

- 保留开始时已有改动、双协议云连接、Mock、历史分批和宿主接入。新增 SQLite 按 scope/connection/Space 的概览缓存，绑定初始化null并即时拉取；旧 sessions.overview 仅兼容保留。overview() 改为SQLite-only，云概览请求集中到绑定/过期session-start刷新路径。
- 会话开启未获取或超过6小时才刷新，恰好6小时不刷新；已核实Claude/Codex阻塞等待，其余默认非阻塞先返回旧缓存。多Space并发且分别提交，失败保留原内容及成功时间。无新增路由、请求等待参数、配置项或定时器；不做Topic结果复查。
- 纯开启信号不创建任务/轮次/正文/上传批次，交付复用create_hosts身份元数据与原context-delivery路由。新增回归覆盖跨进程交付继承、同一原生会话恢复后重新交付、绑定同轮返回、创建重放不返回解绑概览、解绑重绑晚到写回及连接切换。独立审查发现的问题均有失败回归再修复。
- 当前工作区最终 npm test：139项、139通过、0失败/跳过；typecheck、lint、build及插件范围diff --check通过。编译产物HTTP→工程Mock另验证：绑定后get_memory次数1，缓存内新会话后仍1，过期阻塞开启后2；解绑后缓存行0且不再访问概览，全程tasks=0。
- 本机受管服务在原端口加载API10，云连接和暂停状态保留。升级前后项目2、会话4、轨迹69、批次700、绑定2，数量不变，SQLite integrity_check=ok。旧库新增缓存前有恢复备份，未清库、迁移空间、上传测试内容、打包发布或提交。
- 宿主生命周期能力不扩充猜测：DSH实时入口、OpenCode v2当前事件流、Cline setup、Prime原生Skill入口没有可靠开启信号，不把turn-start冒充session-start。现有已安装接入需在Viewer更新，才能使用安装器新的阻塞SessionStart等待预算和最新Skill说明。完整22宿主实机验收不由本轮服务/Mock测试替代。

## 真实 add 与 scheduler/status 诊断（2026-11-24）

- 使用此前创建的独立测试 Space 和随机诊断 user_id，提交两条明确标记的合成消息，无真实项目内容。算法 add 返回 code=200、success=true、memory_view=project、task_id=019c4da6-58ed-4380-a7c1-b724790901f2；同次写入身份立即查询为 in_progress，随后 completed，open_episode_messages=0、memory_ids=[]。未生成主题不能解释为状态查询失败。
- 经插件 CloudClient 的算法适配器使用真实 task_id 查询，同样正确解包为 completed。本轮已补足之前只有隔离桩/Mock 的真实上传与任务查询验证。
- 对照实测：正确 user_id/task_id 返回任务；同一有效用户不传 task_id 时，HTTP200且data=[]；错误用户或不存在的非空task_id为HTTP404。与用户空数组形态相同的已复现路径是缺失有效task_id，不能将其解释为任务完成。原始用户请求尚未提供，具体是否参数遗漏/位置错误仍需原命令确认。
- 本地核心路由只从 Query 接收 user_id/task_id；task_id为空时列举用户任务，非空查不到则404。真实部署含项目记忆扩展，结论以实测为准，不将本地旧核心当作部署版本证明。

## 云服务双协议访问配置（2026-11-23）

- 保留开始时已有工作区改动、工程 Mock、历史容量组批和中英 Viewer。新增算法/工程协议选择、配置基址、鉴权方式、算法云项目 ID；旧配置按工程接口升级。Viewer 使用原「MemOS API 基址」展示实际地址，新增只读连接验证。
- 新增配置、七接口映射、响应身份核对、连接迁移/隔离、开放 Episode、结果未确认、切换采集窗口和 Viewer 回归，均有先失败后通过的证据。本次最终当前工作区 `npm test`：99 项，99 通过，0 失败/跳过；typecheck、lint、build 及插件目录 diff --check 均通过。此数目为当前工作区测试集合，不代表历史文档中已删除的测试重新运行。
- 实际算法部署的 OpenAPI 确认 create_space 必填 project_id。真实只读联调：空间、领域和概览正常；检索初期 HTTP 200 但 degraded 含 project，已增加失败回归并识别为不可用，不能把降级空数组当作 EMPTY。最后以同样的会话/query 复核返回 channels=[project]、degraded=[]、主题0项，检索通道恢复正常。真实云端上传及任务整理尚未执行，本次上传/状态契约由本地隔离桩和保留的 Mock 链路验证。
- 实际 Viewer 检查确认接口类型、完整基址、云项目 ID、无鉴权模式及只读连接测试成功。受管服务保持原回环端口，API 更新为 9；按用户指示切换本机算法连接配置，保留原暂停状态和 Key（无鉴权不发送），私人部署地址不写为源码默认值。
- 配置和旧库升级前有备份，SQLite 完整性为 ok；切换前后项目2、会话4、轨迹45、批次10、绑定2，数量不变。旧 Mock 绑定保留但不计当前启用，不迁移空间、不补传旧任务。没有打包、发布或提交。

## 历史确认数量配置与2条测试（2026-11-23）

- 新增唯一配置 historyUploadConfirmCount（正安全整数，兼容默认100），设置抽屉可改。Viewer 从既有 /api/bind 同次预检读取最新 pending 与阈值，删除界面固定100判断；缺失阈值拒绝提交，不回退旧值。
- 回归先失败再实现，覆盖独立于字节容量的保存/重载、无效值拒绝、2条不确认/3条确认、多空间不重复计数及旧100/101行为。全量实际764项、760通过、0失败、4项既有DSH环境跳过；构建、lint、限定diff检查通过。
- 按本次明确授权，通过本地服务将当前个人配置 historyUploadConfirmCount 设为2；GET配置与磁盘回读均为2，既有其他配置逐项相等。未提交历史上传、未更改绑定或清理SQLite。之后设回100无需代码修改，刷新Viewer即可加载新的配置控件与判断。

## 历史按配置容量逐批上传（2026-11-23）

- 增加唯一配置 uploadMaxBytes（正安全整数，旧配置默认39000字节），设置抽屉可修改；替换业务代码中的重复固定阈值。新增统一 messageRequest，使组批与实际发送按最终请求体 JSON UTF-8 字节计算，包含路由和结构开销。
- 显式历史任务按原始会话时间逐个物化，再按容量逐批准备；不混合不同会话身份，前批接收并处理完成才继续。复用现有 historyUploads、同步周期、batch_traces 与 batch_deliveries，不新增表、依赖、轮询器或任务服务。
- 超大单条静默 skipped：零发送尝试、无 task_id、不进入失败提示；本地正文保持完整，必要时对应工具关联一起跳过。覆盖判断按来源的全部投影消息累积成功/跳过回执，部分成功重试只补缺失部分。新增空间不加入在途任务，解绑重绑不恢复旧授权，重启后再次显式扫描/上传不重复发送既有成功内容。
- Viewer 提交前刷新独立待处理轨迹数，同一来源跨 Space 仅计一次，Codex 父子别名也去重；100不确认、101确认，取消不提交。上传期间禁用并显示上传中，所有批次处理结束显示已完成。API版本升为7，拒绝旧后台静默忽略容量配置。
- 专项先失败后实现，覆盖配置持久化、UTF-8及JSON边界、阈值变化、超大消息及工具关联、部分投影失败/补传、父子来源去重、暂停恢复、授权撤销、旧容量阻塞退役、确认取消与完成按钮状态。全量实际输出 tests800/pass796/fail0/skipped4；四项跳过仍为既有DSH环境测试。类型检查、语法静态检查、构建和插件范围 git diff --check 均退出0。
- 源码及编译产物都执行隔离 MemOS Mock 链路：两份反向文件名的原生历史按2020/2021原始时间导入；首次网络请求时只物化最早会话，运行中新增目标不参与，暂停不继续发送，每次请求均不超过配置上限；再次上传和重启后上传不重发成功内容。未执行真实云端联调、打包发布、Git提交，也未通过工具改写个人数据库或宿主接入。
- 保留既有已发送快照；未物化的历史不在服务启动时自动扫描，重启后仍使用已有显式扫描/上传入口继续。实时采集保留原整轮快照规则，此次拆批与静默跳过针对显式历史上传。

## 对话解绑指定项目空间（2026-11-23）

- 新增第五个 Skill `memos-unbind-project-space` 和 `memos-pm unbind --space-id`，不增加身份参数、环境变量、数据库表、依赖、缓存或定时器。共用 projectContext 与准确 Agent＋项目解析；本轮已有文件增加 unbind 分支，旧绑定和查询形式兼容。
- 服务端 POST /api/unbind-project 复用 projectSpacesDialog 的准确本地项目定位，再使用 Store.unbind 原事务。仅解除指定本地关联，零云请求、无需 Key，不受暂停或更换云配置阻碍。UNBOUND 返回缓存名称及剩余spaces，NOT_BOUND为无数据改动的成功空操作；失效身份／额外路由字段拒绝。
- 最后解绑关闭采集窗口；取消该目标未完成投递，保留其他目标与历史轨迹／批次／回执。新增实际 service.sync 在途请求成功与失败回归：成功仍记录真实 accepted/taskId，失败保持cancelled，不重试目标；其他空间继续上传。不改 Store.unbind 或 Viewer 原接口。
- 明确的解绑调用及结果纳入已有绑定控制过滤；只扩展命令识别，共用实时／历史／Codex缓存／上传规则，迟到结果在重启后仍可关联。同轮业务和示例保留，混合动态脚本不猜测删除，既有发送快照不改写。
- 新增CLI、服务、身份桥、操作过滤、Prime及22profile第五Skill安装卸载回归，新增分支先红后绿。最终全量输出：tests776、pass772、fail0、skipped4（既有DSH环境依赖）。typecheck、lint语法静态检查、build、插件范围git diff --check均退出0。
- 编译后专属入口／CLI子进程 → 本地HTTP → SQLite通过：解绑准确项目、名称及剩余列表正确，重复NOT_BOUND、最后解绑停采、旧轮拒绝、其他项目保留、原绑定／spaces形式兼容，无Key、云调用0。未修改个人宿主配置、未执行真实云端或全宿主模型交互验收、未打包发布或提交。使用前更新目标Agent接入配置并按宿主要求重新加载第五Skill。

## 对话查询当前项目本地空间（2026-11-23）

- 新增第四个 Skill `memos-list-project-spaces`，接受“当前项目关联了哪些项目／空间／组织”“记忆保存在哪”等绑定语境表达；执行零参数 `memos-pm spaces`，无额外路由参数或同义词常量表。
- CLI 内部共享原绑定身份解析，Prime 共用原生会话当前轮读取器，保留嵌套宿主冲突／过期身份拒绝。Cursor/Grok 对零参数查询同样注入现有身份变量。其余桥接复用原通道；既有本轮专属文件增加 spaces 分支，原 --space-id 绑定形式兼容，同轮旧文件可原子升级，不另建查询目录／身份变量。
- 新增本地 HTTP /api/project-spaces，直接读取 Store.spaces，不复用 Viewer 会联网补查名称的方法。无 Key／暂停／切换云配置仍能查看本地名称和 ID。已知会话项目优先，否则最长目录匹配，当前 Agent 隔离；未登记或解绑返回 EMPTY，缺失身份不能冒充 EMPTY。查询服务的 total_changes 不变、云调用0；缺失名称保持空字符串。
- 新增 CLI、服务、宿主桥、第四 Skill 安装和子进程回归；全22安装分支纳入清单，覆盖共享文件及用户改动保护。先运行新增分支观察失败再实现。原绑定、创建、检索及历史等全量回归实际输出：tests757、pass753、fail0、skipped4（既有 DSH 环境依赖）。typecheck、lint（语法静态检查）、build、插件范围 git diff --check 均退出0。
- 额外执行编译后的专属入口／CLI子进程 → 本地HTTP → SQLite：未绑定EMPTY，多空间名称与完整ID正确，名称缺失保留空值，绑定数据不变，旧轮拒绝，旧绑定形式ALREADY_BOUND，无Key且云调用0。Prime专项确认身份请求不含任务正文。
- 未修改个人宿主配置，未执行真实宿主全量模型交互验收、真实云端联调、打包发布或提交。使用前通过Viewer更新目标Agent接入配置，按宿主要求重启或重新加载第四Skill。

## 对话绑定已有项目空间（2026-11-23）

- 新增第三个 Skill `memos-bind-project-space` 与 `memos-pm bind --space-id`。CLI 不接受 context、目录、Agent 或会话参数；当前身份由宿主原生环境、执行前桥接或当前轮专属入口自动传递。复用已有身份登记和项目绑定，不新建数据库表、依赖、配置开关或后台定时器。
- 专属入口仅保存当前轮身份元数据，权限 0600；同会话下一轮或结束时删除旧入口，服务端仍验证 current 身份。精确原生 session 查找不建立任务、不采集正文、不访问云端；身份缺失、冲突或过期失败关闭，不猜测最近会话或工具目录。
- 绑定追加已有 Space，重复绑定返回 ALREADY_BOUND，不改变 boundAt 与下一完整轮准入。校验空间可访问性、领域及每 Agent＋项目最多20空间；不调用 create/space，不自动补传历史。绑定不会修改创建状态，因此同轮原有业务继续向已有目标正常投递。
- 工具调用、结果按来源/轮次/可靠调用 ID 关联过滤；仅保留无正文的控制身份以处理迟到结果和重启。实时入库、Viewer、Codex 快照/新解析缓存、历史扫描/导入及上传共用过滤。用户示例、相邻业务、thinking 和其他轮次同 ID 保留。动态混合脚本无法可靠拆分时保守保留；已发送审计与旧未重放缓存不自动改写。
- CLI、服务、身份桥接、控制记录、历史与增量缓存、22 个 profile 的第三 Skill 安装/卸载均有回归；新增分支先验证失败再实现。全量实际输出：tests 743、pass 739、fail 0、skipped 4（既有 DSH 环境依赖）；类型检查、语法静态检查、构建、插件范围 git diff --check 均退出0。最终过滤微调后相关11项再次通过；独立审查发现嵌套 Agent 继承父绑定环境的身份冲突，增加失败回归并修复后再次全量通过。
- 额外执行编译后的专属入口和 CLI 子进程 → 本地 HTTP → 隔离 MemOS Mock：仅传 Space ID 能绑定准确会话项目，重复返回 ALREADY_BOUND，旧轮返回 CONTEXT_MISSING，云端 create 请求为0。所有测试使用临时目录，未执行真实云端联调、打包发布或提交，也未操作个人宿主接入配置。
- 需在 Viewer 对目标 Agent 执行“更新接入配置”并按宿主要求重启/重新加载，以部署第三个 Skill。22 分支 fixture 不构成全部宿主真实模型交互验收。

## 对话创建项目空间（2026-11-22）

- 按用户确认方案先运行失败回归，再逐步实现：独立创建 Skill、create CLI、纯身份上下文、现有创建／绑定复用、整轮上传排除、下一轮完整准入及双 Skill 安装管理。
- 核心 HTTP 回归 17 项覆盖未绑定零正文／零云调用、已有 Space 追加、名称与领域必填、禁止路由覆盖、会话目录固定、Codex 原生头目录、创建轮零 add、重启、并发不重复创建、不确定结果不重试、迟到旧提交／Stop、子任务迟到结果、源轮次与 Hook 标识差异、历史队列绕过及旧任务继续正常上传。
- Prime 专项使用原生 JSONL，创建后重启服务，再追加下一用户轮完整工具过程；不额外调用创建 wrapper，也能正常上传一次。Antigravity 仅投影原生来源身份元数据；不可靠或半写来源拒绝交付旧 token。Grok 首个 Shell 在任何 PostToolUse 前也可通过 PreToolUse 注入创建身份。
- 最终 `npm test` 实际输出：tests 709、pass 705、fail 0、cancelled 0、skipped 4、todo 0；跳过仍为缺少 `MEMOS_PM_DSH_ROOT` 的四项既有真实 DSH 组件测试。`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check` 均退出 0。
- 构建后额外执行编译 Hook 子进程 → 编译 CLI 子进程 → 本地 HTTP → 独立 MemOS Mock：当前 session 项目定位正确，同轮重复请求仅创建一个 Space，创建轮 add=0，下一轮完整消息 add=1。
- 保留本轮开始时已有的工作区改动；未修改个人宿主配置、未启动／重启个人服务、未访问真实云端、未打包发布或提交。两个 Skill 需通过 Viewer 更新接入配置并按宿主要求重新加载。Mock 和 fixture 不替代 22 宿主及真实 MemOS 的完整实机验收。

日期：2026-11-17。环境：macOS，Node 26.4.0，npm 11.17.0。结论：公共链路可运行，开发包可独立安装；**未完成方案要求的全量真实环境验收**。

## 会话 ID 上传与项目绑定上限（2026-11-22）

- `add/message` 和 `search/memory` 直接使用已有 `session.id` 作为 `conversation_id`；本地轮次校验 ID 不变。上传继续省略 domains、session_id 及任务状态，保留 get/status 处理进度查询，没有新增会话字段或参数层级。
- 每个 Agent＋项目最多绑定 20 个不同 Space。Viewer 提交和创建确认后读取当前绑定列表，满额弹窗“单个项目绑定空间不能超过20个”；两个服务入口在云请求前拒绝，复用 SQLite 事务兜底并发。重复绑定允许，解绑释放名额；并发创建已获云端 ID 但未绑定时保留原有恢复流程。
- 新增边界测试先失败后通过，覆盖跨轮、重试、重启、不同会话、历史补传、第二十个/第二十一个、重复绑定、Agent/目录隔离、最后名额并发竞争、确认期间状态变化与后端错误弹窗。专项 42/42 通过；全量 npm test：664 项，660 通过、0 失败、4 项既有 DSH 环境测试跳过；typecheck、lint、build、插件范围 git diff --check 通过。
- 本地受管服务通过现有更新机制在原端口加载当前构建；配置、userId、暂停状态保留，SQLite integrity_check=ok，原本为空的项目/会话/轨迹/批次/绑定计数保持为 0。本次没有清库、修改宿主接入、打包发布或调用真实云端创建/绑定/上传，云端联调仍待验证。

## 上传契约、业务元数据与省略 domains（2026-11-22）

- `add/message` 始终省略 domains。删除上传前领域补查、冻结/恢复领域快照及 40089 专用刷新；保留新建/绑定时的 Space→Domain 映射校验。新库不创建投递领域列，旧列兼容保留但不使用；userId 生成及配置不变。
- 共用上传投影将原生调用规范成 function tool_calls，多个结果按可靠 tool_call_id 拆分，保留混合文字、thinking、调用和结果的顺序。对象、数组和显式 null 正文无损序列化；空工具结果保留。必需字段缺失、非法调用包或成员名称缺 ID 会阻塞该批并保留本地证据。各宿主构造器不再将缺参猜成空对象，原始字符串和显式空对象/null 保持准确。
- 宿主元数据保留可靠原生 id、实际发生时间与 role_id/role_name；时间转带时区 ISO，缺少原生 ID 时基于既有来源身份生成稳定 ID，拆分使用固定序号。模型、用量、签名和宿主包装排除，业务工具 JSON 的同名字段保留。Copilot 提交先于原生 ID 的用户记录仅在已核对同轮、同正文且未发送时补齐原生 ID。
- 迁移复用 SQLite user_version=4：先备份存在待处理内容的旧库，明确未尝试任务可升级，来源不全不能缩减原快照；旧已尝试且未确认请求停止自动重试。成功快照及回执不重写，旧时间偏移仅在匹配视图统一；一条来源的全部投影消息匹配后才记覆盖。没有强制重放既有 Codex 解析缓存，已丢失的历史元数据不补造。
- 新增专项先红后绿，独立审查发现的非法空工具包被跳过、空数组结果被删除、旧时区回执失配均有失败回归并修复；另覆盖工具参数缺失/显式null、外层和块内 thinking 同时保留、来源不全迁移不丢正文、实时与历史补传不重复。
- 全量 npm test：650 项，646 通过、0 失败、4 项既有 DSH 环境测试跳过；typecheck、lint、build、插件范围 git diff --check 通过。测试使用隔离目录与本地桩服务；未执行真实云端创建、绑定或上传，完整云端联调仍待验证。

## Space 与 Domain 映射及上传快照（2026-11-22）

- 增量增加 `space_domains(baseUrl,spaceId,domains)` 与 `batch_deliveries.domains`，不新增配置、定时器、来源标记或业务接口。新建时保存所选领域，已有空间的两个绑定入口缺映射或为空时读取 `list/domains`，正向缓存跨 Agent、项目、重启及解绑复用；空领域或无效响应阻止新绑定。
- 实时与历史上传按 Space 固定领域快照，重试保持原参数。缺映射补查失败只阻塞该目标，不消耗发送次数，不随同步周期重复补查；重新绑定补齐后核对原有内容条件再恢复。旧已尝试但无快照的任务保持阻塞，成功回执不改写。40089 明确失败并刷新映射供后续投递使用，不自动重试旧参数。
- 新增服务、存储、云契约回归先失败再实现；专项覆盖缓存持久化/云隔离/外部多领域、空值与非法响应、连接切换、历史补传、冻结重试、延迟补查时解绑及领域阻塞后解绑重绑。独立审查发现的旧历史授权恢复问题已增加先失败回归并修复；解绑同时取消 blocked 目标。
- 当前全量 `npm test`：623 项、619 通过、0 失败、4 项既有 DSH 环境测试跳过；typecheck、lint、build 及插件范围 `git diff --check` 通过。旧采集和上传测试仅补齐明确的领域 fixture，保留原有业务断言；Mock 保持空 Space 返回空领域，不添加生产默认值。
- 已在原端口更新受管实例，实际 SQLite 可读到映射表及领域快照列，完整性检查为 `ok`；采用增量升级，未清库，升级前后的项目、会话、轨迹、批次与绑定计数均为 0。未执行真实云端绑定、查询领域或上传，接口联调仍待真实环境验证。

## 新建 Space 的固定 Domain 选择（2026-11-22）

- Viewer 在名称与新建按钮之间增加固定“编程 / 办公 / 自定义”选择，不请求领域列表。自定义弹窗按去除首尾空白后的 Unicode 码点限制为 1–24 个字符；取消恢复原选择，未选或弹窗未确认时不能新建。绑定已有 Space 不要求 Domain。
- 后端在任何云调用前校验 Domain，创建请求携带 `domains:[{domain}]`。本地 API 升为 6，阻止旧 v5 服务忽略领域参数。未改上传、检索、任务状态或 Mock 接口实现。
- 服务与界面回归先失败再实现。最终 `npm test`：604 项，600 通过、0 失败、4 项既有 DSH 环境测试跳过；typecheck、lint（语法静态检查）、build、限定插件目录的 `git diff --check` 通过。
- 实际浏览器验证：未选禁用、25 字拒绝、自定义确认及创建确认展示领域；桌面控件同行、390px 窄屏单列，未观察到控制台错误。视觉评分 96，记录在 `.omx/state/domain-selection/ralph-progress.json`。未确认实际云端创建。
- 按用户明确要求暂停发送并停止旧服务后，删除本地活动 `memory.sqlite` 及其 WAL/SHM，重建空库；项目、会话、轮次、轨迹、批次与绑定均为 0，完整性检查为 `ok`。保留原配置及宿主接入，受管服务在原端口以 API 6 重启。此操作为本次授权的一次性清理，不增加启动时自动清库逻辑。

## Copilot CLI 本地项目发现（2026-11-22）

- 已安装 Hook 的 Copilot 在原生 `session-state/<sessionId>/workspace.yaml` 中有准确的项目 `cwd`，但项目发现函数缺少 Copilot 分支，源码与运行服务均返回空列表；未绑定时 Hook 正常提前返回，不能用采集会话来补足初始项目发现。
- 增加仅读取 workspace 元数据的发现分支，复用目录去重、路径验证与现有缓存刷新。核对本机官方包的根目录解析与 YAML serializer；覆盖普通、引号和 literal-block 路径、自定义 `COPILOT_HOME`、缺失/错误来源和符号链接。无新增依赖、表、API 或宿主配置。
- 新增 4 项回归先全部失败，再修复通过；项目发现与缓存专项 32/32 通过。当前工作区全量 `npm test`：491 项、487 通过、0 失败、4 项 DSH 环境测试跳过；typecheck、lint 通过。源码实读已能发现 `/Users/niu/code/tmp_test_copilot1`。上述验证不代表真实 Copilot 模型上下文或云端上传链路已验收。
- build、`git diff --check` 通过；通过已有受管服务更新机制加载新构建后，实际 `/api/projects?agentType=copilot-cli&refresh=1` 返回 `tmp_test_copilot1` 及准确目录。未创建绑定或改写宿主会话。

## Cursor 续聊结束标记与聚合回答（2026-11-22）

- 来源模型区分稳定任务正文与末尾可被续聊替换的 turn_ended。标记保留或替换都由提交时证据确定读取起点，稳定正文哈希继续严格验证；旧 pending 只在重建原快照哈希一致后转换。已认领与竞争区间使用实际读取起点，兼容新旧来源描述。
- afterAgentResponse 作为本轮正文投影核对，可对应一条或连续多条原生消息；重叠、乱序 Hook 不重复正文，原生重复消息和工具位置不变。匿名 Shell 仅在命令及目录唯一对应、双方显式执行参数不冲突时复用 Hook 身份；有歧义的记录保留。
- 新增 7 个服务/Mock 回归：末尾标记替换/保留及半行长回答、旧 pending 哈希恢复、真实历史变更拒绝、新旧边界冲突、重复匿名 Shell 保留、显式超时冲突拒绝合并。先复现再修复。产品修改限于 cursor-cli/source.ts 和 capture.ts，无新增用户配置、依赖、表或定时器。
- npm test：487 项，483 通过、0 失败、4 项既有环境测试跳过；typecheck、lint、build、git diff --check 通过。
- 构建后只读检查发现个人服务已载入当前 revision，并由正常同步恢复实际轮次 d33740d9（“夏青是小李的同事吗”）。批次 bd54d96a、Mock 任务 mock_task_9ef66a49-0af3-4e36-a9dc-71696934254f 均 completed，attempts=1；5 条消息依次为用户、说明、工具调用、工具结果、最终回答，序列化 13,734 字节。直接查询 Mock 确认实际上传正文与本地批次完全一致。没有手工改写个人数据库或直接构造真实上传请求。

## Cursor 首轮来源恢复与回答入库（2026-11-22）

- 首次 Hook 缺少路径时，根据宿主工作区元数据和准确会话 ID 定位；现有同步流程也会重试缺失路径。读取失败保存入口文件元数据与具体错误；缺少入口证据时，只有明确且唯一的原生轮次 ID 可以恢复边界，不能按相同问题或最新文件猜测。
- afterAgentResponse 正文先入库供 Viewer 查看，仍需原生完成证据才能上传。同一已验证轮次内按出现次数合并 Hook 与原生正文，保留原生重复消息、多段文本及无法对应的 Hook 内容，不依赖 Hook 到达顺序。使用已有 receipt、同步和事务；没有新增用户配置、依赖或数据表。
- 新增 8 个服务/Mock 回归用例：首次缺路径、未知边界不误采旧轮、入口读取失败后重启恢复、明确原生轮次恢复、多段/重复回答、部分 Hook 正文匹配、Hook 逆序以及 stop 后文件出现且无后续 Hook。先复现失败再修复；Cursor 三组测试合计 38 通过。
- npm test：480 项，476 通过、0 失败、4 项既有环境测试跳过；typecheck、lint、build、git diff --check 通过。编译产物额外验证首次无路径、Viewer 详情可读回答、stop 后文件落盘及 Mock 只收到一次完整上传。
- 真实会话 2469a169 的文件定位已只读验证。未重启个人服务或改写真实轨迹；新 Hook 使用已构建入口。缺少来源证据的旧 pending 不自动猜测补传，真实 Cursor 新一轮模型交互仍待实测。

## Cursor 原生完成核对与完整快照（2026-11-20）

- 新增 Cursor 专属收尾读取器及 `cursor_receipts` 待核对表，复用已有同步周期和投递队列。stop/sessionEnd 不再直接生成批次；对应原生区间的完整 JSONL、turn_ended、正文与已知工具/子任务收齐后，在同一事务内保存轨迹、生成快照并删除 receipt。没有新增等待时长、重试次数或后台定时器配置。
- 提交 Hook 入口先取文件元数据，绑定准入后再读取该时刻的前缀，记录身份、位置及哈希。补读验证源身份、已有内容、当前启用窗口和唯一轮次归属；半行、缺文件、变化来源、未知结束状态保持待核对。显式取消／失败可以没有回答；旧来源区间不重复认领。
- Hook 工具调用和结果保留，助手正文以原生记录补齐，可靠调用 ID 合并去重；来源位置与块位置用于合并排序。快照、详情、实时投递和历史补传共用排序。子任务精确关联父轮次，关联缺失时保守等待。所有 Hook 记录沿用入口时间，旧轮次不能跨解绑重绑窗口继续写入。
- 新增专属读取器与服务/Mock 集成回归，先复现 stop 先到造成漏回答，再验证长回答半行、迟到/重复回调、重启、暂停、同文连续问题、来源重用、文件变化、工具闭合、子任务、窗口隔离及 live/detail/history 顺序。复审发现的窗口泄漏和补读顺序问题均有回归验证。
- 最终 npm test：464 项，460 通过、0 失败、4 项既有 DSH 环境测试跳过；typecheck、lint（语法检查）、build 和限定插件目录的 git diff --check 通过。测试使用隔离临时目录及 Mock/桩服务。
- 未修改真实宿主配置、重启个人服务、修复旧已发送批次或触发真实补传，未打包或发布。缺少可靠来源边界时保持待核对；无 ID 的重叠内容保守保留，不能据此声称全部宿主轨迹严格去重。真实 Cursor 模型交互验收仍需在更新接入后执行。

## 任务轨迹入库边界与 Cursor 工具采集（2026-11-20）

- 新采集在普通写入、Codex 专属写入和历史导入前复用任务规范化：保留文字、可读 thinking、实际 Skill/检索/业务工具操作及子 Agent 轨迹；按明确来源和消息块类型排除宿主提示与清单。真实工具结果保持不透明，不按正文关键词或业务 JSON 字段名清理。
- 原始包装仅保留必要来源元数据与规范化消息；工具失败保存实际错误，不再用整份 Hook 事件兜底。Cursor 修复外层 role/内层 message.content，pre/post 和 transcript 只有可靠执行 ID 相同时才去重；安装器覆盖全部 preToolUse，保留其他用户 Hook。
- 删除上传层按 Skill 路径、工具名称和 memos-pm 命令排除操作的旧规则，继续保留有逐项子执行证据的 Codex 重复包装消除。真实超大检索结果保留并受既有整轮容量限制，不静默截断或删除。
- 回归先验证 Cursor 解析、任务内容边界、规范化幂等与重启兼容的缺失行为，再实现；覆盖实时入库与上传、历史导入、混合消息、失败工具、业务正文保护、子 Agent、重复回放和既有快照/回执。
- 全量 npm test：432 项，428 通过、0 失败、4 项既有 DSH 环境测试跳过。typecheck、lint（语法检查）、build 和限定插件目录的 git diff --check 通过。测试使用隔离临时目录和 Mock/桩服务。
- 未重启真实服务、未修改真实宿主配置、未迁移个人轨迹或触发补传；未打包或发布。无时间标识的 Cursor 旧 transcript 不补当前时间强行导入，真实宿主及真实云端完整验收仍未完成。

## 已执行

| 检查 | 结果 | 证明范围 |
|---|---|---|
| `npm test` | 40/40 通过 | SQLite、路由、轮次、上传确认、失败次数持久化、上下文保留、全部适配 profile 的针对性协议测试、Mock、Viewer |
| `npm run typecheck` | 通过 | src/tests/dev 严格类型检查 |
| `npm run lint` | 通过 | 源码语法检查；不是 ESLint 全规则扫描 |
| `npm run build` / prepack | 通过 | TypeScript→独立 JS，入口、资源路径转换 |
| `npm run test:package` | 通过 | 临时干净 npm 安装；编译后后台服务、四项 Viewer 资源、实际 HTTP 上传、CLI 五状态与退出码、Hook/native loader、共享 Skill 引用 |
| Viewer 实际浏览器 | 通过 | 创建项目、首次绑定、会话/工具原文、上传状态、检索、暂停恢复、22 Agent 列表，无控制台错误 |
| 独立架构审查 | 通过 | 当前未发现未修复的正常主链路阻断；复跑40测试及类型检查 |
| 限定精简后回归 | 通过 | 删除未用游标表/变量/别名；公共代码格式化，无新增功能或依赖 |

Mock 使用真正 HTTP，与插件业务服务分进程/实例；不做模型记忆抽取。Hook 测试使用真实 Node 子进程 stdin→本地 HTTP→宿主协议 stdout；Prime 采用真实子进程 JSONL 协议测试。这些都不替代实际宿主模型执行证据。

修复且有回归：空会话生命周期记录不触发建空间；已有真实消息的子代理可上传；历史 native turn 不覆盖当前轮；最多两次发送跨重启保持；云端处理失败不抹去 uploaded；tool name 不误作 role_name；Kimi 工具参数对象转 JSON 字符串。

## 尚未完成的必需验收

1. **真实 MemOS**：未提供本任务专用 Key；未创建真实空间或上传用户轨迹。省略 domains 后空领域 Space 能否写入、完整工具/特殊事件、多模态和其余接口暂定字段须真服务验证。
2. **22 宿主实机**：已实现22入口/profile，不宣称22全部支持验证。多数目标版本未安装；本机旧版 Claude/Cursor/Copilot/CodeBuddy 与目标版本不同。Codex与WorkBuddy版本匹配也仅是探测证据。
3. **入口缺口**：Grok 首token概览、Cursor异步初始化的首请求时序；TRAE CN准确build及完整轨迹、Devin完整轨迹；Antigravity真实日志中用户轮结构。这些正常链路要求仍需宿主能力/源码证据，不能计为已达标。
4. **真实模型上下文及评测集**：未获得22宿主连续两轮、多工具、Skill调用的模型侧证据；未提供评测方测试集。
5. **发布条件**：包名可用性、发布主体、许可证尚未确认；没有发布 npm。Linux/Windows及最低Node版本未实机验证。

详细逐宿主证据见 compatibility-hooks.md / compatibility-native.md。未实现闲时补传、超大单消息拆分、广泛异常恢复，符合当前边界；不是隐藏的后台重试。

## 产物与范围

- 代码：本插件目录 `src/`、`viewer/`、`skills/`、`dev/`、`scripts/`、`tests/`、`docs/`。
- 历史独立包验证已完成；2026-11-18 按开发阶段要求删除 `.tgz` 及临时打包记录，后续使用源码部署，不执行打包。
- 浏览器截图：`.omx/state/viewer/overview.png`、`agents.png`；视觉检查95分，通过。
- 未修改相邻 `memos-local-plugin`；未实际安装到用户宿主配置，未提交 Git，未发布服务。

## 从 Viewer 移出的适配器开发备注（2026-11-18）

以下为原始实现备注快照，不代表新增实机验证结果。用户操作提示保留在各 profile 的 limitations；协议、源码和验收细节仅保留在开发文档。

| Agent | 原始备注 |
|---|---|
| Codex CLI | Native /hooks trust approval required; transcript format is version-specific. |
| Cursor CLI | Enable transcripts. beforeSubmitPrompt cannot append context; sessionStart is asynchronous. |
| GitHub Copilot CLI | userPromptTransformed from rolling docs appends context; availability in target 1.0.112 requires native verification. userPromptSubmitted stdout is ignored. |
| Grok Build | First-token injection unavailable; prompt identity and transcript capture supported. Source baseline 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8 differs from release. |
| Kimi Code | New kimi-code only; remote execution needs local service bridge. |
| ZCode | Desktop profile; temporary transcript read synchronously during hook. |
| TRAE CN desktop | Desktop CN only; exact version and full transcript source unverified. Not TRAE CLI. |
| Antigravity CLI | PreInvocation is a model request, not a user turn; user turns derive from transcript message identities. |
| Devin CLI | Full assistant transcript source unverified; hook events retain available records only. |
| Deep Agents Code | Hooks v2; projection read by stable record identity. |
| WorkBuddy desktop | Local macOS desktop 5.3.14 bundles engine 2.115.0; source-verified hooks and transcript, model end-to-end validation pending. |
| OpenCode v1 | Protocol fixture verified; real host/model integration requires acceptance testing. |
| OpenCode v2 | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Kilo CLI | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Cline CLI | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Pi | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Prime Agent | Protocol fixture verified; real host/model integration requires acceptance testing. |
| DeepSeek Harness | Protocol fixture verified; real host/model integration requires acceptance testing. |

## 任务轨迹范围调整（2026-11-18）

- 新规则：轨迹入库和上传只保留用户任务、工具调用与结果、助手回复。系统及临时注入提示、运行状态不生成轨迹和待上传消息。
- 修复 DSH 嵌套助手回复的角色解析；同一原生用户消息按 ID 去重。工具名称、参数和完整结果保留。
- 本机 DSH 样例迁移：24 条旧记录 → 用户任务、助手回复各 1 条，正文逐项一致；24 个待上传批次清理为 2 个，迁移前自动生成本地 SQLite 恢复快照。原样例没有工具调用。
- Mock HTTP 验证有效任务内容上传，注入内容及运行日志不上传。56 项测试、类型检查、lint、构建通过；不构成其余宿主与真实云端的全量实机认证。

## 白色轮次轨迹展示（2026-11-18）

- 轮次摘要列表 + 右侧详情；所有内容框为白色，步骤默认折叠。
- 新增回归覆盖：30 条记录的一轮保持完整、缺失轮次记录独立分组、摘要不展示完整回复、折叠保留完整正文。
- 59 项测试、类型检查、lint、构建通过；未打包。
- 本机 Viewer 实测：1 个轮次摘要包含2条记录；展开正文高度280px、内容高度508px，内部滚动；Esc关闭并回到列表；浏览器无错误日志。
- 截图保存在 `.omx/state/turn-view/`。

## 五类轨迹展示（2026-11-18）

- 62 项测试通过，新增覆盖混合 reasoning/text/tool 块顺序、thinking 字段、analysis channel、脱敏思考和多工具结果。
- 当前 DSH 会话实测 user/thinking/answer 独立展示；answer 展开时 thinking 仍收起，正文不再混合。
- 截图：`.omx/state/five-trace-types/viewer.png`。此次仅修改 Viewer 与文档、测试。

## 完整轨迹确定后创建上传任务（2026-11-18）

- 采集期间批次为0；真实结束信号到达且最终记录保存后，一轮创建一个完整消息快照。上传与重试复用快照，不再按采集次数组批。
- 78 项测试、类型检查、lint、构建通过；涵盖拆次采集、重复结束、服务重启、旧轮结束晚到、子会话、超限保留、旧发送历史保留、原生持久化回放去重。
- 本机迁移前备份：`~/.memos-project-memory/memory.sqlite.before-turn-batches-1794987526493.sqlite`。从原始备份核实 DSH turn/end（turn=1，seq=22）后补录结束信号；1轮/2个旧片段变为1轮/1个pending批次，2条消息正文逐项一致，发送次数0。
- 本地服务已重启，URL不变。DSH磁盘入口引用本仓库dist；运行中的DSH须重启以加载新的结束信号处理。未执行真实云上传。

## DSH 命名运行上下文修复（2026-11-18）

- 修复前，已对照问题会话确认 `runtime-context → memos-project-memory 裸标识 → skill-catalog` 的顺序；新增回归先在旧实现上失败。
- 动态 ID 现在进入宿主统一封装的 `memos-project-memory:call-context`，异步登记后通过 admission refresh 生效。初始化概览不混入 ID，只在实际历史提交后确认交付；确认失败可重试且不重复追加。
- DSH 专项 8/8 通过；本机 `0.2.2-rc.4` 的真实 Cordis/SystemPrompt/运行快照/Session/Skill 目录/provider 序列化组合 4/4 通过，源码入口和构建后的 dist 入口分别验证。覆盖首请求刷新、新轮、工具续推、两种注册顺序、会话隔离和服务不可用。
- 组合测试捕获离线模型请求体，驱动 admission 与本地运输为模拟，不构成真实模型执行或真实 MemOS 联调。`rc.3` 已核对官方 npm 源码的对应 API 和时序，未运行该版本。
- 最终工作树完整检查：100 项测试通过、零失败、零跳过；typecheck、lint（语法检查）、build 通过。该总数包含并行完成的项目管理测试，不将其计为本修复新增测试。本次新增 DSH 回归为 8 项单元测试和 4 项真实组件组合测试。
- 使用 `MEMOS_PM_DSH_ROOT` 显式启用真实组件测试；未指定时这四项明确跳过，不能当作宿主兼容验收通过。未执行 npm 打包、发布、数据库迁移或真实云上传。
- 独立架构审查通过；限定 ai-slop-cleaner 检查零额外修改，之后重新完成全量测试、typecheck、lint、build 和 dist 入口的 4 项组合验证。
- 已通过现有安装器修复本机 DSH 接入并更新已安装 Skill／CLI 说明，校验三个受管理文件的所有权哈希，确认 DSH 配置受管理区块之外的文本完全一致。运行中的 DSH 未被停止或重启，须由用户重启后加载新入口；既有会话历史不回写。

本修复修改范围：`src/adapters/deepseek-harness/extension/index.ts`、`tests/adapters/dsh-context.test.ts`、`tests/adapters/dsh-host.test.ts`、`tests/adapters/native.test.ts` 中 DSH 用例、`skills/project-memory/SKILL.md`、`skills/project-memory/references/cli-contract.md`、`docs/contracts.md`、`docs/compatibility-native.md`、本验证记录。

## Hook Node 稳定路径（2026-11-18）

- 仅调整公共Hook安装器的Node路径选择：验证稳定Homebrew链接与当前运行程序一致后保留链接路径；复用已生成的Kimi条目。未新增部署目录、启动脚本或配置参数。
- 97项测试通过，4项需DSH环境的集成测试跳过；类型检查、lint、构建通过。新回归模拟Homebrew版本切换、不同Node目标与无稳定链接。
- 本机Codex9项MemOS hook已更新为 `/opt/homebrew/opt/node/bin/node`，原脚本路径保留；其他hook保持一致，无重复项。Stop命令已通过隔离本地HTTP端点执行验证。
- 修改前配置备份：`~/.memos-project-memory/backups/codex-node-path-1794989897372/`。本地服务已重启，Codex需重新加载配置并按其提示复核变更的hook。


## 2026-11-18：Agent＋项目绑定准入与历史补传

- 完整回归：307 项，303 通过、4 项既有宿主环境测试跳过、0 失败。`typecheck`、`lint`、`build`、`git diff --check` 通过。
- 隔离 HTTP＋Mock：未绑定不入库；绑定后扫描不导入正文；点击历史上传才入库并发送；重复点击幂等；新增 Space 仅补缺失目标；暂停排队与恢复发送；最后解绑拒绝新工作且旧详情保留。
- 绑定边界：进行中轮次只采新增内容；重绑不补采停用间隙；读云或上传等待中解绑不会复活旧工作；不同 Agent 与跨目录子会话路由隔离。
- 实际数据库迁移及修复前均备份。构建触发宿主自动更新时，发现旧 Codex reader 过滤会使旧轨迹丢失来源关联；已停服，从自动迁移前快照恢复来源关联，保留更新后的新增正文，并修复重绑后的冻结逻辑。恢复演练及上线后复核：旧轨迹 session/conversation 关联变化为 0，已确认上传快照变化为 0，既有 272 条孤立来源没有新增。未删除历史记录。
- 备份：`~/.memos-project-memory/backups/before-binding-activation-1795007581803.sqlite`；最近迁移前快照：`~/.memos-project-memory/memory.sqlite.before-agent-bindings-1795007838149.sqlite`；恢复前含新增内容快照：`~/.memos-project-memory/backups/before-source-association-recovery-1795008017094.sqlite`。
- 本地 API v4 已在原端口 60500 运行；Viewer 实际核验“历史会话上传”列、Agent＋项目行、已完成扫描后的可用按钮。当前 Codex 与 DSH 两个 scope 扫描均 ready。原暂停上传设置保留，没有点击实际历史上传。
- 已更新现有 Codex 和 DSH 接入及 Skill。已运行的 DSH 进程需重启以重新加载原生扩展。
- 边界：真实云端未做新增上传验收；无可验证原生历史读取器的宿主只支持补传插件已采集完整轮次，界面明确提示范围；整轮超出既有上传容量仍保留 blocked，不截断内容。


## 2026-11-19：历史上传完成与失败状态

- 完成显示灰色禁用“已上传历史”；暂停、配置缺失、连接不一致、发送失败、超限或云端处理失败显示红色禁用“上传历史失败”，同时显示原因。扫描失败仍单独提供重试扫描。
- 使用现有配置与逐Space回执推导状态，仅补充history.uploadError；无新配置、数据库表或依赖。已成功历史不会因后来暂停而被误标失败；被成功补传覆盖的旧失败回执不再阻塞展示。
- Viewer保留POST/网络错误，不被后续状态刷新或成功提示覆盖。实际localhost页面已核验红色禁用按钮及暂停说明。
- 完整回归最终316项：312通过、4项既有跳过、0失败；typecheck、lint、build、diff检查通过。首次全量运行有一项既有并发启动端口用例波动，单独10项runtime测试及最终全量重跑均通过。
- 当前本地paused=true保持不变，2项历史投递仍pending、attempts=0、无接收确认。本次没有解除暂停或发送用户历史。配置默认paused=false，上传错误不自动修改该开关；现有配置没有变更审计，无法追溯最早开启暂停的操作者及时间。

## 2026-11-19：Agent 项目缓存与轻量刷新

- 仅已完成接入的 Agent 可以发现项目；当前 Agent 的请求只检查其自身接入状态。首次无缓存时发现，之后复用后台服务缓存；显式刷新合并新增目录。Claude、Pi、DSH 的项目目录取得有效头部身份后不再逐会话读取。未绑定项目不读取历史正文。
- Viewer 为各 Agent 保留项目列表及选择；刷新期间保留可用选项，绑定/解绑只合并绑定状态。项目页使用 GET /api/bind，不再等待会话、标题、完整批次与检索数据；版本探测只在 Agent 接入页执行。GET /api/adapters/installed 只读取接入元数据。
- 新项目首次绑定后台扫描历史；已知项目只从 SQLite 更新已完成轮次索引。新增 Space、状态轮询及普通刷新不重扫宿主历史；提供显式“扫描历史”操作。服务重启后项目缓存重新建立，已有 scope 先使用 SQLite 索引，未导入历史可手动扫描。无新增数据库表、依赖或定时任务。
- 修改范围：src/adapters/{projects,installer}.ts、src/server/{service,http,history}.ts、viewer/{app,view}.js；新增 tests/core/project-cache.test.ts、tests/viewer-project-cache.test.ts，并更新 bound-codex-history、multispace、viewer-history 与 viewer 回归；同步 README、contracts 与 local-api 文档。
- 新增回归先在旧实现失败；最终全量 327 项，323 通过、4 项既有 DSH 环境测试跳过、0 失败。typecheck、lint（语法检查）、build、git diff --check 通过。测试使用临时宿主目录、临时数据库与隔离 HTTP 服务。
- 浏览器工具不可用（没有可用 browser/native surface），未完成真实浏览器交互验收；项目选择、缓存、刷新期间可用性、切换恢复、过期响应与绑定状态通过 DOM/VM 交互回归和实际 HTTP 测试验证。未重启现有服务、未修改宿主接入配置、未发送真实云端请求。源码构建已更新，重新通过 Viewer 入口打开后受管服务会检查构建版本。


## 显式新建 Space 与项目绑定（2026-11-19）

- 沿用已采纳的 Viewer 草稿：Agent／项目选择在上方，下方切换新建与已有 Space；新建必须输入名称并确认，请求期间锁定目标与重复提交。成功后更新绑定关系；名称、完整 ID、复制与解绑复用原 Space 列表。已检查桌面与 390px 手机断点，并修正窄屏目录和历史提示的列对齐。
- 扩展已有 `POST /api/projects` 与 `bindProject`，只增加必要的 `spaceName`，与 `spaceId` 互斥。创建请求只有 `space_name`；直接用创建响应的 ID、名称调用既有 Store 事务，不再查询一次 `get/space`。无新增依赖、数据库表、字段或迁移，无任意名称长度常量、创建重试队列或补偿删除。
- 创建成功但绑定失败时 HTTP 保留已知 ID，Viewer 转到已有 Space 绑定并保留该 ID；创建失败保留输入，结果未确认不自动重试。成功提交后即清空输入，后续刷新失败会明确提示已保存，避免误操作再次创建。
- 本地 API 由 v4 升到 v5，继续使用现有版本与构建标记升级机制。原因是旧进程可能读取新 Viewer 静态文件，却将 `spaceName` 当作纯项目注册并返回假成功。回归先证明旧实现接受 v4，再证明新版拒绝 v4、接受 v5；真实浏览器也观察到旧实例的更新提示。

### 本轮修改文件

- 产品：`src/server/service.ts`、`src/server/http.ts`、`src/runtime/revision.ts`、`viewer/index.html`、`viewer/app.js`、`viewer/style.css`、`viewer/view.js`。
- 新增测试：`tests/core/create-space.test.ts`、`tests/viewer-space-create.test.ts`。
- 适配既有测试：`tests/core/http.test.ts`、`tests/core/runtime.test.ts`、`tests/viewer-history.test.ts`、`tests/viewer-project-cache.test.ts`、`tests/viewer.test.ts`。旧布局哈希改成新布局结构与行为要求。
- 文档：`README.md`、`docs/local-api.md`、`docs/contracts.md`、本文件。

### 实际验证

- 后端新增6项测试先全部失败，再实现后通过。Viewer新增模式、确认、取消、防重、恢复及刷新失败测试也先验证缺失行为；没有将 Mock 创建接入到真实个人数据目录。
- 最终 `npm test`：340 项，336 通过、0 失败、4 跳过。4项跳过仍是缺少 `MEMOS_PM_DSH_ROOT` 的既有真实组件组合测试，不作为本功能的验收证据。
- `npm run typecheck`、`npm run lint`、`npm run build`、限定插件目录的 `git diff --check` 均通过。lint 仍仅代表语法检查。
- 真实 Viewer＋独立本地 Mock HTTP 联调：取消确认后创建请求为0；确认一次后创建请求为1，body仅 `space_name`；列表中出现绑定，Space详情显示完整名称和返回的ID。
- 在同一独立测试 SQLite 上重启服务、刷新页面，原名称与ID完整保留。随后用编译后的 API v5 在新进程打开该数据库，再通过 Viewer 新建第二个 Space，关系从1个变为2个，不覆盖原空间；重启编译后服务并重新读取，两个名称及ID仍一致。Mock重建时显式预置前一阶段fixture空间，以保留对外服务端fixture状态；持久化证据来自原SQLite重新打开，不是重新提交绑定。
- 任务工作区 `drafts/space-create-mock-evidence.json` 保存实际创建请求和重启后的绑定；`space-create-viewer-implemented.jpg` 为最终绑定页，`space-persisted-mock.jpg` 为首次重启后的名称／ID详情，`space-mobile-mock.jpg` 为窄屏检查截图。
- 验证仅覆盖 Mock，不代表真实 MemOS 联调或22宿主完整实机验收。创建请求超时的远端结果仍可能未知；不声称云端创建与本地事务具备原子性或严格幂等。没有打包、发布或修改用户现有记忆库。


## 页面刷新保持与真实规模时延优化（2026-11-19）

### 改动与约束

- 产品文件仅 `viewer/app.js`、`src/storage/store.ts`、`src/server/codex-capture.ts`、`src/adapters/codex-cli/rollout.ts`。保持已采纳界面，不改CSS布局，不新增依赖、请求参数、页面存储副本、正文缓存、数据表或定时器。
- URL hash是主页面唯一来源，移除独立 `page`；五页刷新保持、前后退及冷启动项目页切其他页面有回归。单个 `reloadRequest`只标识请求顺序，防止跨页和ABA旧回包覆盖。
- 新增 `traces(sourceId)` 查询索引，保留 `(sessionId,sourceId)` 唯一约束；不重写历史统计算法。状态列表在SQL层只选批次元数据，详情和上传仍读完整正文。
- 创建保存成功后即反馈并解除提交等待，既有 `reload`独立执行；刷新错误明确表示已保存，不恢复旧名称或重复创建，已知ID失败恢复不变。
- 无变化源不重复重建、过滤和深拷贝正文；旧pending通知仅做确认，不再触发无变化的全库归轮。首启、旧缓存、重绑、文件指纹、重写/截断/缺失/归档及子代理检查保留。

### 测试

- 新增 `tests/core/state-performance.test.ts`（3项）、`tests/core/codex-polling-performance.test.ts`（5项）、`tests/viewer-page-restore.test.ts`（4项）；扩展 `tests/viewer-space-create.test.ts`慢刷新解锁回归，并适配 `tests/viewer-history.test.ts`、`tests/viewer-navigation.test.ts`、`tests/viewer-project-cache.test.ts` 的URL环境。关键缺失行为均先获得红灯，再实现。
- 最终 `npm test`：353项，349通过、0失败、4跳过。4项为既有DSH真实组件测试缺少环境；不代表宿主完整验收。
- `npm run typecheck`、`npm run lint`、`npm run build`及限定插件目录的 `git diff --check`均通过。lint仍为语法检查。
- 独立Mock真实浏览器检查五页刷新保持、后退、冷启动项目页加载、确认创建及刷新后绑定保留。创建接口仅调用一次，body只有 `space_name`；Mock暂停状态保持。

### 同规模副本对照

使用同一份SQLite快照与107个冻结rollout文件（约229MB），前后代码各用独立数据库副本，避免活跃日志持续追加影响比较。

| 测量项 | 优化前 | 优化后 |
|---|---:|---:|
| 热绑定状态计算 | 12.944秒 | 0.363秒 |
| 完整状态计算 | 12.427秒 | 0.701秒 |
| 状态JSON响应大小 | 44,025,831字节 | 281,129字节 |
| 状态JSON序列化 | 156毫秒 | 0.59毫秒 |
| 无源变化的后续采集周期 | 8.432 / 9.589秒 | 0.691 / 0.586秒 |
| 对应周期最大事件循环阻塞 | 3.376 / 3.456秒 | 0.259 / 0.294秒 |

- 比较17,934条任务记录的身份和JSON值、348个完整上传快照及8条发送回执，未丢失内容或改变发送目标。3条raw对象仅JSON键顺序不同，所有字段值及文本一致；不可变上传快照完全一致。
- 首次采集仍需完整对账，副本测得约6.9秒；真实源追加仍沿用全局归轮，不宣称消除所有主线程阻塞。

### 当前受管实例

- 已加载新构建，访问端口仍为60500，API仍为兼容的v5；配置逐项一致，上传暂停保持true，没有创建真实云空间或发送历史。
- 实际接口复测：`/api/bind` 355 / 334毫秒；`/api/state` 总计527毫秒、281,803字节，确认批次列表不含messages。该次末尾health为6毫秒。
- 计时汇总位于任务工作区 `drafts/memos-optimization-results-20261119.json`、`drafts/memos-optimized-live-timings-20261119.json`；刷新后保持项目页的浏览器截图为 `drafts/viewer-page-restore-verified.jpg`。
- 没有打包或发布；临时真实数据副本在汇总后清理，不将原始用户轨迹写入测试fixture或提交。


## Viewer 导航合并与云调用诊断（2026-11-19）

- 运行概览合并上传控制、统计、需处理事项与最近会话；诊断作为页内标签。主导航为四项，左下角设置打开云连接抽屉。删除手动同步按钮，保留自动上传、暂停／恢复和刷新；原同步API与后台机制未删除。
- 诊断只查询新式云服务失败记录；右侧详情显示插件会话ID、轮次ID、接口、HTTP状态、业务返回码、响应正文及批次／Space关联。超时无响应、空响应体和HTTP错误分开展示；空间管理无会话时不补造关联。凭据脱敏，不保存上传请求正文。
- 新SQLite表独立于旧纯文本日志；升级有数据的旧库前自动备份。相同请求身份与响应在60秒窗口内聚合计数；不同轮次或批次分开。API列表不携带完整响应，详情与导出按需读取。
- 已验证HTTP错误、业务错误、无效／缺字段响应、网络／超时、异步任务处理失败、并发轮次隔离、原批次跨新轮次的状态查询归属、成功调用无日志、无会话的管理操作、迁移备份和重启持久化。
- 会话轨迹HTML、会话渲染函数区间和既有view函数与本轮开始前快照一致；Agent卡片渲染函数与基线一致。只通过作用域限定的CSS将Agent桌面网格改为四列；未修改适配器安装与配置。
- 全量 `npm test`：368项，364通过、4跳过、0失败。4项DSH真实组件组合测试依赖MEMOS_PM_DSH_ROOT，本次未启用，不能计作实机兼容验收。
- `typecheck`、`lint`（语法检查）、`build` 通过。全量测试以独立临时宿主目录运行，没有使用生产云连接。未打包、未发布。
- 浏览器检查使用真实本地HTTP服务与独立错误Mock：验证暂停／恢复、诊断筛选及会话／轮次ID、错误正文和Key脱敏、设置保存、原会话阅读布局。22张Agent卡片在1440／1920px均四列，1024px两列，390px一列；无横向溢出或页面脚本错误。
- 截图保存在任务工作区 `drafts/viewer-layout-implemented.png`、`viewer-diagnostics-implemented.png`、`viewer-settings-implemented.png`、`viewer-sessions-preserved.png`、`viewer-agents-four-columns.png`、`viewer-layout-implemented-mobile.png`。Mock结果不替代真实MemOS云端验收。
## Seven-adapter Skill capture filtering (2026-11-22)

- Added adapter-owned `skill-filter.ts` policies for Claude Code, Codex CLI, Cursor CLI, Copilot CLI, WorkBuddy, Prime Agent and DeepSeek Harness. OpenCode policies are unchanged. Shared code handles routing, syntax primitives, scoped call/result correlation and summary construction; no new configuration, dependencies or database tables.
- Recognized Skill reads retain `skill_name`, native `call_id` and execution `status` inside tool envelopes. Bodies and extra arguments are removed before storage, including `raw` copies and newly written Codex parser state. Existing historical readers reuse the corresponding policy. Unknown status is not reported as success. Ambiguous identity or indivisible mixed output produces an incomplete summary and a blocked upload.
- Regression coverage includes delayed results and calls, restart, same IDs in different turns/sessions, conflicting IDs, native failure evidence, quoted JSON/comment examples, mixed tool blocks, shell/Python/wrapper examples, WorkBuddy duplicate reconciliation, historical uploads, frozen attempted snapshots and non-target-host isolation. Skill summary projection does not reinterpret ordinary tool result bodies.
- Validation: `npm test` reported **595 tests, 591 passed, 0 failed, 4 skipped** (existing optional DSH host checks). `npm run typecheck`, `npm run lint`, `npm run build` and `git diff --check` passed. Built JavaScript imports were exercised for all seven policies, with an explicit OpenCode dispatch isolation assertion.
- Tests use temporary stores and fixtures/Mock services. No real host/model conversation was run for this change, and no personal database, previously sent payload or unchanged legacy parser cache was cleaned. Dynamically computed paths and arbitrary scripts are outside static recognition; no claim is made that their output can always be classified as a Skill read.
