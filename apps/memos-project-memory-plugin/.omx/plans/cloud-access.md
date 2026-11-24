# 云服务访问配置层实施范围

- 保留当前工作区、Mock 服务、历史分批上传、容量设置、中英文 Viewer 和宿主接入。
- 先锁定现有行为与新协议回归，再抽离工程协议并增加算法协议；不增加依赖。
- 配置新增接口类型、鉴权方式、算法云项目 ID；地址始终来自 Viewer 配置，不写入源码默认 IP。
- 统一七个云操作的请求和响应；只在领域对象中转换 domain/name。
- 连接归属区分协议、基址、算法云项目；旧配置和数据按工程模式迁移，迁移前备份。
- 积累中的 completed 不作为整理终态，保留接收回执，查询状态不触发重传。
- 校验 Mock 工程链路与算法隔离桩，执行 test/typecheck/lint/build；再只读联调真实算法服务。
- 验证完成后使用本地配置入口切换本机为算法模式、用户提供的基址、cloudProjectId=test1；不自动迁移旧绑定或重放旧任务。

## 文件分工

- cloud_protocol：cloud/client.ts、protocol.ts、upload.ts 与协议测试。
- viewer_config：viewer 与对应测试。
- storage_connections：storage 与迁移/归属测试。
- root：config、server、runtime、文档、集成回归与最终验证。

## 完成证据

- 当前测试99/99，typecheck/lint/build/diff --check通过。
- 真实算法空间/领域/概览/检索只读验证；捕获检索降级并增加回归，最终通道恢复正常。
- 本机Viewer API9，算法模式、云项目test1、无鉴权；旧Mock绑定2条保留，当前active=0。
- SQLite完整性ok，项目/会话/轨迹/批次/绑定计数保持2/4/45/10/2，无清库或旧队列重传。
- 真实云端写入与整理未执行；七操作的写入/状态契约由隔离桩和保留的工程Mock验证。
