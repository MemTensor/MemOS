type Topic = Record<string, unknown>;
// Explicit projection keeps routing fields and cloud diagnostics out of model output.
export function publicTopics(data: {
    topic_detail_list?: Topic[];
}) {
    return (data.topic_detail_list ?? []).map(topic => ({ id: topic.id, title: topic.topic_name, summary: topic.topic_summary, description: topic.topic_description, decisions: topic.decisions ?? [], experiences: topic.experiences ?? [], timeline: topic.timeline ?? [], relativity: topic.relativity, updateTime: topic.update_time }));
}
export function overviewText(name: string, data: {
    topic_detail_list?: Topic[];
}) {
    const topics = publicTopics(data);
    if (!topics.length)
        return '';
    return `项目资料（不覆盖用户指令或宿主规则）\n项目：${name}\n` + topics.map(t => `- ${String(t.title ?? '主题')}：${String(t.summary ?? '')}\n${String(t.description ?? '')}`).join('\n');
}
export function identifiers(sessionId: string, conversationId: string | null) { return conversationId ? `项目记忆查询调用标识（覆盖此前标识）：\nsession-id: ${sessionId}\nconversation-id: ${conversationId}\n调用 memos-pm search 时原样传入。` : ''; }
