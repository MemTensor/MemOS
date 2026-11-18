/** Fictional project memories, recreated on each demo server startup. */
export function projectFixtures() {
  const time = '2026-11-18T00:00:00.000Z';
  const projects = [
    { id: 'mock_space_project_memory', name: 'Mock 项目记忆插件', topics: [
      { key: 'space_binding', name: '空间绑定', summary: '本地项目目录与固定记忆空间关联。', decision: '同一项目的多个 Agent 会话使用同一个固定空间，检索限定在该空间内。', experience: '联调前先核对项目目录和空间 ID，避免把不同项目的记忆混在一起。' },
      { key: 'trajectory_upload', name: '轨迹上传', summary: '整轮任务轨迹确定后创建上传任务。', decision: '用户输入、工具调用与结果、思考和回答按发生顺序保留，整轮结束后创建一次上传任务。', experience: '重复结束通知不能重复创建上传任务；临时注入提示不作为项目记忆。' },
    ] },
    { id: 'mock_space_order_service', name: 'Mock 订单服务', topics: [
      { key: 'order_idempotency', name: '订单幂等', summary: '订单创建通过请求幂等键防止重复下单。', decision: '创建订单要求传入 Idempotency-Key，相同键与相同请求返回原订单。', experience: '客户端超时重试时复用原幂等键，并校验重复请求的内容是否一致。' },
      { key: 'stock_consistency', name: '库存一致性', summary: '库存预占与订单状态通过事务和补偿保持一致。', decision: '下单时预占库存，支付成功后确认扣减，取消或超时后释放预占。', experience: '用并发下单与重复取消用例检查超卖和库存重复释放。' },
    ] },
    { id: 'mock_space_docs_site', name: 'Mock 文档站点', topics: [
      { key: 'docs_routing', name: '文档路由', summary: '文档 URL 包含语言和版本，旧链接保留重定向。', decision: '文档路径使用 /语言/版本/主题；移动页面时为旧地址配置重定向。', experience: '修改导航后检查中英文页面以及外部引用的旧链接。' },
      { key: 'release_checks', name: '发布检查', summary: '文档发布前验证链接、示例与搜索索引。', decision: '发布前运行构建、站内链接检查和代码示例验证，发布后更新搜索索引。', experience: '预览通过后再发布；回滚时同步回滚页面和对应搜索索引。' },
    ] },
  ];
  return {
    spaces: projects.map(project => ({ space_id: project.id, space_name: project.name, instructions: '仅用于 Mock 联调的虚构项目数据。', create_time: time, update_time: time })),
    topics: projects.flatMap(project => project.topics.map(topic => ({
      id: `mock_topic_${topic.key}`, space_id: project.id, domain: null, topic_name: topic.name,
      topic_summary: `Mock 示例：${topic.summary}`, topic_description: `${topic.decision}\n${topic.experience}`,
      decisions: [{ content: topic.decision, time, user_ids: ['mock_user'], history: [], conflicts: [] }],
      experiences: [{ content: topic.experience, time, user_ids: ['mock_user'], history: [], conflicts: [] }],
      timeline: [], sources: [], create_time: time, update_time: time,
    }))),
  };
}
