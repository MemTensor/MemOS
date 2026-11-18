/** Stable chronological merge which never reverses an individual execution's source order. */
export function orderTraceRecords<T extends Record<string, unknown>>(records: T[], extraEdges: [string, string][] = []): { records: T[]; cyclic: boolean } {
    const key = (row: T) => String(row.sourceId ?? row.id);
    const byId = new Map(records.map(row => [key(row), row]));
    const edges = new Map<string, Set<string>>(), incoming = new Map(records.map(row => [key(row), 0]));
    const edge = (from: string, to: string) => {
        if (from === to || !byId.has(from) || !byId.has(to)) return;
        const next = edges.get(from) ?? new Set<string>();
        if (!next.has(to)) { next.add(to); edges.set(from, next); incoming.set(to, incoming.get(to)! + 1); }
    };
    const sources = new Map<string, T[]>();
    for (const row of records) {
        const source = `${row.originSessionId ?? row.sessionId}\0${row.nativeTurnId ?? ''}`;
        const group = sources.get(source) ?? []; group.push(row); sources.set(source, group);
    }
    const compare = (left: T, right: T) => String(left.occurredAt ?? '\uffff').localeCompare(String(right.occurredAt ?? '\uffff'))
        || String(left.originSessionId ?? '').localeCompare(String(right.originSessionId ?? ''))
        || Number(left.sourceOrdinal ?? 0) - Number(right.sourceOrdinal ?? 0)
        || key(left).localeCompare(key(right));
    const calls = new Map<string, string>();
    const callKey = (row: T, id: unknown) => `${row.originSessionId}\0${row.nativeTurnId}\0${id}`;
    for (const group of sources.values()) {
        group.sort((left, right) => Number(left.sourceOrdinal ?? 0) - Number(right.sourceOrdinal ?? 0) || compare(left, right));
        for (let index = 1; index < group.length; index++) edge(key(group[index - 1]!), key(group[index]!));
    }
    for (const row of records) {
        const message = row.message as { tool_calls?: { id?: string }[] } | undefined;
        for (const call of message?.tool_calls ?? []) if (call.id) calls.set(callKey(row, call.id), key(row));
    }
    for (const row of records) {
        const message = row.message as { tool_call_id?: string } | undefined;
        const call = message?.tool_call_id ? calls.get(callKey(row, message.tool_call_id)) : undefined;
        if (call) edge(call, key(row));
    }
    for (const [from, to] of extraEdges) edge(from, to);
    const ready = records.filter(row => incoming.get(key(row)) === 0).sort(compare), ordered: T[] = [];
    while (ready.length) {
        const row = ready.shift()!; ordered.push(row);
        for (const next of edges.get(key(row)) ?? []) {
            incoming.set(next, incoming.get(next)! - 1);
            if (incoming.get(next) === 0) { ready.push(byId.get(next)!); ready.sort(compare); }
        }
    }
    const cyclic = ordered.length !== records.length;
    if (cyclic) {
        const included = new Set(ordered.map(key));
        ordered.push(...records.filter(row => !included.has(key(row))).sort(compare));
    }
    return { records: ordered, cyclic };
}
