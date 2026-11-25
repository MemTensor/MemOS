import type { Message } from '../adapters/types.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';

/** Packing and sending must measure precisely the same JSON body. */
export function messageRequest(userId: string, session: { id: string; agentType: string }, spaceId: string, messages: Message[]) {
    return { user_id: userId, conversation_id: session.id, agent_id: session.agentType, space_ids: [spaceId],
        messages: stripImages(messages), allow_memory_view: ['project'], async_mode: true };
}
