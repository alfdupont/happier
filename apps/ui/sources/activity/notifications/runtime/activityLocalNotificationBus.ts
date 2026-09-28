import type { Message } from '@/sync/domains/messages/messageTypes';
import type { AgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';

/**
 * Where a ready turn was observed: in the applied transcript, or only in the session projection of
 * a hidden session whose transcript is not applied live (so no message preview is available).
 */
export type ActivityReadyOrigin = 'transcript' | 'projection';

export type ActivityLocalNotificationEvent =
    | Readonly<{
        kind: 'ready';
        sessionId: string;
        messages?: Message[];
        origin: ActivityReadyOrigin;
    }>
    | Readonly<{
        kind: 'agent-request';
        sessionId: string;
        requestId: string;
        requestKind: AgentRequestKind;
        toolName: string;
        toolArgs: unknown;
    }>;

type Listener = (event: ActivityLocalNotificationEvent) => void;

const listeners = new Set<Listener>();

export function subscribeActivityLocalNotifications(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyActivityReady(
    sessionId: string,
    messages?: Message[],
    options?: Readonly<{ origin?: ActivityReadyOrigin }>,
): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) return;

    const event: ActivityLocalNotificationEvent = {
        kind: 'ready',
        sessionId: normalizedSessionId,
        messages,
        origin: options?.origin ?? 'transcript',
    };

    for (const listener of Array.from(listeners)) {
        try {
            listener(event);
        } catch {
            // ignore listener failures
        }
    }
}

export function notifyActivityAgentRequest(params: Readonly<{
    sessionId: string;
    requestId: string;
    requestKind: AgentRequestKind;
    toolName: string;
    toolArgs: unknown;
}>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    const requestId = typeof params.requestId === 'string' ? params.requestId.trim() : '';
    const toolName = typeof params.toolName === 'string' ? params.toolName.trim() : '';
    if (!sessionId || !requestId || !toolName) return;

    const event: ActivityLocalNotificationEvent = {
        kind: 'agent-request',
        sessionId,
        requestId,
        requestKind: params.requestKind,
        toolName,
        toolArgs: params.toolArgs,
    };

    for (const listener of Array.from(listeners)) {
        try {
            listener(event);
        } catch {
            // ignore listener failures
        }
    }
}

export function resetActivityLocalNotificationRuntimeForTests(): void {
    listeners.clear();
}
