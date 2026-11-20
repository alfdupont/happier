import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { computeNextMetadataStringOverrideV1, SESSION_MODE_OVERRIDE_KEY } from '@happier-dev/agents';

import {
  computePendingSessionModeOverrideApplication,
  resolveSessionModeOverrideFromMetadataSnapshot,
} from './permission/permissionModeFromMetadata';
import { isDefinitiveSessionControlApplyError } from './sessionControlApplyError';

type SessionModeOverrideSession = {
  getMetadataSnapshot: () => Metadata | null;
  updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
};

// The first retry of a failed command is immediate; later retries of the same command wait
// RETRY_BACKOFF_BASE_MS, doubling up to RETRY_BACKOFF_MAX_MS. Every metadata wake triggers a sync,
// so without this a failure that itself causes a metadata change retries in a tight loop.
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 60_000;

export function createSessionModeOverrideSynchronizer(params: Readonly<{
  session: SessionModeOverrideSession;
  runtime: {
    setSessionMode: (modeId: string) => Promise<void>;
    clearSessionModeOverride?: () => Promise<void>;
  };
  isStarted: () => boolean;
  autoApplyFromMetadata?: boolean;
  now?: () => number;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
  flushPendingAfterStartWithOutcome: () => Promise<boolean>;
  rebindSession: (session: SessionModeOverrideSession) => void;
} {
  type ModeCommand = { modeId: string; updatedAt: number };
  const now = params.now ?? Date.now;
  let session = params.session;
  let lastAppliedUpdatedAt = 0;
  let pending: ModeCommand | null = null;
  let applyingPromise: Promise<boolean> | null = null;
  let lastAttemptedUpdatedAt = 0;
  let lastAttemptNumber = 0;
  let retryNotBefore = 0;
  let cleanupObligation: ModeCommand | null = null;
  let cleanupPromise: Promise<void> | null = null;

  const isSameCommand = (left: ModeCommand | null, right: ModeCommand): boolean =>
    left?.updatedAt === right.updatedAt && left.modeId === right.modeId;

  // Clear a rejected override from metadata so clients stop showing it and later starts do not
  // replay it. Only the rejected command is cleared; a newer user choice is left untouched.
  const retryCleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    const obligation = cleanupObligation;
    if (!obligation || !session.updateMetadata) return Promise.resolve();

    cleanupPromise = session.updateMetadata((metadata) => {
      const current = resolveSessionModeOverrideFromMetadataSnapshot({ metadata });
      if (!isSameCommand(current, obligation)) return metadata;
      return computeNextMetadataStringOverrideV1({
        metadata,
        overrideKey: SESSION_MODE_OVERRIDE_KEY,
        valueKey: 'modeId',
        value: '',
        updatedAt: obligation.updatedAt + 1,
      }) as Metadata;
    }).then(() => {
      if (isSameCommand(cleanupObligation, obligation)) cleanupObligation = null;
    }).catch(() => {
      logger.debug('[SessionModeOverrideSync] Rejected session mode override cleanup failed; cleanup will retry on the next sync');
    }).finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  };

  const applyPendingIfPossible = (): Promise<boolean> => {
    if (applyingPromise) return applyingPromise;
    if (!pending) return Promise.resolve(true);
    if (!params.isStarted()) return Promise.resolve(true);

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) {
      pending = null;
      return Promise.resolve(true);
    }
    const isRetry = next.updatedAt === lastAttemptedUpdatedAt;
    if (isRetry && now() < retryNotBefore) return Promise.resolve(false);
    const attempt = isRetry ? lastAttemptNumber + 1 : 1;
    lastAttemptedUpdatedAt = next.updatedAt;
    lastAttemptNumber = attempt;
    logger.debug('[SessionModeOverrideSync] Applying session mode override', {
      modeId: next.modeId,
      updatedAt: next.updatedAt,
      attempt,
    });

    // Runtimes without a clear hook preserve their existing provider policy.
    const apply = next.modeId === ''
      ? params.runtime.clearSessionModeOverride?.() ?? Promise.resolve()
      : params.runtime.setSessionMode(next.modeId);
    applyingPromise = apply
      .then(() => {
        // Only advance lastAppliedUpdatedAt on success so failures can retry.
        lastAppliedUpdatedAt = next.updatedAt;
        retryNotBefore = 0;
        if (pending && pending.updatedAt <= lastAppliedUpdatedAt) pending = null;
        return true;
      })
      .catch(async (error) => {
        // Provider errors and mode identifiers may contain private launch inputs.
        if (isDefinitiveSessionControlApplyError(error)) {
          // The provider refused this exact command, so retrying it cannot succeed.
          // Settle it; only a newer override re-arms the synchronizer.
          lastAppliedUpdatedAt = Math.max(lastAppliedUpdatedAt, next.updatedAt);
          if (pending && pending.updatedAt <= next.updatedAt) pending = null;
          logger.infoFile('[SessionModeOverrideSync] Provider rejected session mode override; not retrying', {
            updatedAt: next.updatedAt,
            attempt,
          });
          // A rejected clear is not replaced by another clear, which would be rejected in turn.
          if (next.modeId !== '') {
            cleanupObligation = next;
            await retryCleanup();
          }
          return false;
        }
        retryNotBefore = attempt === 1
          ? 0
          : now() + Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 2), RETRY_BACKOFF_MAX_MS);
        logger.infoFile('[SessionModeOverrideSync] Failed to apply session mode override; will retry on next sync', {
          updatedAt: next.updatedAt,
          attempt,
        });
        return false;
      })
      .finally(() => {
        applyingPromise = null;
        if (pending && pending.updatedAt > next.updatedAt && params.isStarted()) {
          void applyPendingIfPossible();
        }
      });

    return applyingPromise;
  };

  const syncFromMetadata = (): void => {
    if (cleanupObligation) void retryCleanup();
    const snapshot = session.getMetadataSnapshot();
    const next = computePendingSessionModeOverrideApplication({
      metadata: snapshot,
      lastAppliedUpdatedAt,
    });
    if (!next) return;

    if (!params.isStarted()) {
      pending = next;
      return;
    }

    pending = next;
    if (params.autoApplyFromMetadata !== false) {
      void applyPendingIfPossible();
    }
  };

  const flushPendingAfterStartWithOutcome = async (): Promise<boolean> => {
    if (cleanupObligation) await retryCleanup();
    if (applyingPromise) return await applyingPromise;
    if (!pending) return true;
    if (!params.isStarted()) return true;

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) return true;
    return await applyPendingIfPossible();
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    await flushPendingAfterStartWithOutcome();
  };

  return {
    syncFromMetadata,
    flushPendingAfterStart,
    flushPendingAfterStartWithOutcome,
    rebindSession: (nextSession) => { session = nextSession; },
  };
}

export const createAcpSessionModeOverrideSynchronizer = createSessionModeOverrideSynchronizer;
