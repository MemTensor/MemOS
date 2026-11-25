const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const imageTypes = new Set(['input_image', 'output_image', 'image', 'image_url', 'local_image']);
function image(value: unknown): boolean {
    const item = object(value);
    return imageTypes.has(String(item.type)) || typeof item.mimeType === 'string' && item.mimeType.startsWith('image/')
        || typeof item.mime_type === 'string' && item.mime_type.startsWith('image/')
        || typeof item.media_type === 'string' && item.media_type.startsWith('image/');
}
function label(value: unknown, position: number): string {
    const item = object(value);
    const path = typeof item.path === 'string' && !item.path.startsWith('data:') ? item.path : undefined;
    const name = typeof item.name === 'string' ? item.name : typeof item.filename === 'string' ? item.filename : path ? `[Image #${position}]` : undefined;
    if (!name && !path) return '[image]';
    return `<image${name ? ` name=${name}` : ''}${path ? ` path=${JSON.stringify(path)}` : ''}>`;
}
function opening(value: unknown): boolean {
    const item = object(value);
    return ['text', 'input_text'].includes(String(item.type)) && typeof item.text === 'string'
        && item.text.startsWith('<image name=') && item.text.endsWith('>') && !item.text.includes('\n');
}
function clean(value: unknown, parseJson = true, toolResult = false): unknown {
    if (typeof value === 'string') {
        // These are complete encoded payload values, not substring searches in prose.
        if (parseJson && value.startsWith('data:image/')) return '[image]';
        if (parseJson && (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))) {
            try { const parsed: unknown = JSON.parse(value); const normalized = clean(parsed, true, toolResult); return JSON.stringify(parsed) === JSON.stringify(normalized) ? value : JSON.stringify(normalized); }
            catch { /* Ordinary tool text need not be JSON. */ }
        }
        return value;
    }
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        let position = 0;
        for (let i = 0; i < value.length; i++) {
            const part = value[i];
            if (opening(part) && image(value[i + 1])) {
                position++; result.push(clean(part, false, toolResult)); i++;
                if (object(value[i + 1]).text === '</image>') i++;
            } else if (image(part)) {
                result.push({ type: 'text', text: label(part, ++position) });
            } else result.push(clean(part, true, toolResult));
        }
        return result;
    }
    if (!value || typeof value !== 'object') return value;
    if (image(value)) return { type: 'text', text: label(value, 1) };
    const row = object(value), result: Record<string, unknown> = {};
    if (row.role === 'user' || row.role === 'assistant') toolResult = false;
    else if (row.role === 'tool' || ['tool_result', 'tool-result', 'function_call_output', 'custom_tool_call_output', 'computer_call_output', 'local_shell_call_output'].includes(String(row.type))) toolResult = true;
    for (const [key, part] of Object.entries(row)) {
        if (key === 'image_url' || key === 'imageUrl' || key === 'b64_json' || key === 'image_base64') {
            result[key] = '[image]';
        } else if (['image_generation_call', 'image_generation'].includes(String(row.type)) && ['result', 'output'].includes(key)) {
            result[key] = { type: 'text', text: label(row, 1) };
        } else {
            // Text blocks and user/assistant prose may discuss JSON image examples verbatim.
            const parse = key !== 'command' && (toolResult || key !== 'text' && !(key === 'content' && typeof part === 'string'));
            result[key] = clean(part, parse, toolResult);
        }
    }
    return result;
}

/** Remove media payloads at structural boundaries; never scan or rewrite prose substrings. */
export function stripImages<T>(value: T): T { return clean(value) as T; }
