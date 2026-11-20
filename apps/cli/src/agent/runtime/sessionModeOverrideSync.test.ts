import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionModeOverrideSynchronizer } from './sessionModeOverrideSync';
import { SessionControlApplyError } from './sessionControlApplyError';
import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

describe('createSessionModeOverrideSynchronizer', () => {
  afterEach(() => vi.restoreAllMocks());
  it('retries a failed clear before acknowledging its metadata timestamp', async () => {
    let attempts = 0;
    const runtime = {
      // Provider-control boundary: keep synchronization and override parsing real.
      setSessionMode: async () => {},
      clearSessionModeOverride: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('provider unavailable');
      },
    };
    const sync = createSessionModeOverrideSynchronizer({
      session: { getMetadataSnapshot: () => createTestMetadata({
        sessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: null },
      }) },
      runtime,
      isStarted: () => true,
      autoApplyFromMetadata: false,
    });
    sync.syncFromMetadata();
    expect(await sync.flushPendingAfterStartWithOutcome()).toBe(false);
    sync.syncFromMetadata();
    expect(await sync.flushPendingAfterStartWithOutcome()).toBe(true);
    sync.syncFromMetadata();
    expect(await sync.flushPendingAfterStartWithOutcome()).toBe(true);
    expect(attempts).toBe(2);
  });

  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionMode = vi.fn(async (_modeId: string) => {});

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionMode).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();
    expect(setSessionMode).toHaveBeenCalledWith('plan');
  });

  it('applies overrides immediately once started', async () => {
    const setSessionMode = vi.fn(async (_modeId: string) => {});

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionMode).toHaveBeenCalledWith('plan');
  });

  it('treats modeId="default" as a clear-override marker when the provider has no real default option', async () => {
    const setSessionMode = vi.fn(async (_modeId: string) => {});

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({
          sessionModesV1: {
            v: 1,
            provider: 'opencode',
            updatedAt: 1,
            currentModeId: 'build',
            availableModes: [
              { id: 'build', name: 'Build' },
              { id: 'plan', name: 'Plan' },
            ],
          },
          acpSessionModeOverrideV1: { v: 1, updatedAt: 22, modeId: 'default' },
        } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionMode).not.toHaveBeenCalled();

    // Should not keep attempting to apply "default" on subsequent syncs.
    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionMode).not.toHaveBeenCalled();
  });

  it('applies modeId="default" when the provider exposes it as a real session mode option', async () => {
    const setSessionMode = vi.fn(async (_modeId: string) => {});

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({
          sessionModesV1: {
            v: 1,
            provider: 'codex',
            updatedAt: 1,
            currentModeId: 'plan',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'plan', name: 'Plan' },
            ],
          },
          acpSessionModeOverrideV1: { v: 1, updatedAt: 23, modeId: 'default' },
        } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(setSessionMode).toHaveBeenCalledWith('default');
  });

  it('retries the same override when runtime apply fails', async () => {
    let attempt = 0;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient failure');
    });

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 31, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    expect(setSessionMode).toHaveBeenCalledTimes(2);
    expect(setSessionMode).toHaveBeenLastCalledWith('plan');
  });

  it('logs failed applies and later retry attempts', async () => {
    // Observe the real logger without replacing its file boundary.
    vi.spyOn(logger, 'debug');
    vi.spyOn(logger, 'infoFile');
    let attempt = 0;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient failure');
    });

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 51, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    expect(logger.debug).toHaveBeenCalledWith(
      '[SessionModeOverrideSync] Applying session mode override',
      expect.objectContaining({ modeId: 'plan', updatedAt: 51, attempt: 1 }),
    );
    expect(logger.infoFile).toHaveBeenCalledWith(
      '[SessionModeOverrideSync] Failed to apply session mode override; will retry on next sync',
      { updatedAt: 51, attempt: 1 },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      '[SessionModeOverrideSync] Applying session mode override',
      expect.objectContaining({ modeId: 'plan', updatedAt: 51, attempt: 2 }),
    );
  });

  it('does not start a concurrent apply while flushPendingAfterStart is in flight', async () => {
    let started = false;
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      calls += 1;
      if (calls === 1) return firstCall;
      return Promise.resolve();
    });

    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 41, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    started = true;

    const flushPromise = sync.flushPendingAfterStart();
    sync.syncFromMetadata();
    await Promise.resolve();

    expect(setSessionMode).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flushPromise;
  });

  it('backs off repeated failures of the same override instead of retrying on every sync', async () => {
    let clock = 1_000_000;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      throw new Error('transient failure');
    });
    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ sessionModeOverrideV1: { v: 1, updatedAt: 61, modeId: 'autopilot' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
      autoApplyFromMetadata: false,
      now: () => clock,
    });
    const syncAndFlush = async (): Promise<boolean> => {
      sync.syncFromMetadata();
      return await sync.flushPendingAfterStartWithOutcome();
    };

    // The first retry is immediate; the backoff starts once the retry fails as well.
    expect(await syncAndFlush()).toBe(false);
    expect(await syncAndFlush()).toBe(false);
    expect(setSessionMode).toHaveBeenCalledTimes(2);

    // A burst of metadata wakes inside the backoff window makes no provider call.
    for (let i = 0; i < 50; i += 1) expect(await syncAndFlush()).toBe(false);
    expect(setSessionMode).toHaveBeenCalledTimes(2);

    clock += 1_000;
    await syncAndFlush();
    expect(setSessionMode).toHaveBeenCalledTimes(3);

    // The window doubles after each failure.
    clock += 1_999;
    await syncAndFlush();
    expect(setSessionMode).toHaveBeenCalledTimes(3);
    clock += 1;
    await syncAndFlush();
    expect(setSessionMode).toHaveBeenCalledTimes(4);

    // The window never exceeds one minute.
    for (let i = 0; i < 10; i += 1) {
      clock += 60_000;
      await syncAndFlush();
    }
    expect(setSessionMode).toHaveBeenCalledTimes(14);
  });

  it('applies a newer override at once even while an older one is backing off', async () => {
    let clock = 1_000_000;
    let metadata: any = { sessionModeOverrideV1: { v: 1, updatedAt: 91, modeId: 'autopilot' } };
    const setSessionMode = vi.fn(async (modeId: string) => {
      if (modeId === 'autopilot') throw new Error('transient failure');
    });
    const sync = createSessionModeOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata },
      runtime: { setSessionMode },
      isStarted: () => true,
      autoApplyFromMetadata: false,
      now: () => clock,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    metadata = { sessionModeOverrideV1: { v: 1, updatedAt: 92, modeId: 'plan' } };
    sync.syncFromMetadata();

    expect(await sync.flushPendingAfterStartWithOutcome()).toBe(true);
    expect(setSessionMode).toHaveBeenLastCalledWith('plan');
  });

  it('stops retrying a definitively rejected override and clears it from metadata', async () => {
    vi.spyOn(logger, 'infoFile');
    let metadata: any = { sessionModeOverrideV1: { v: 1, updatedAt: 71, modeId: 'autopilot' } };
    let cleanupAttempts = 0;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      throw SessionControlApplyError.definitive(new Error('rejected'));
    });
    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('offline');
          metadata = updater(metadata);
        },
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(await sync.flushPendingAfterStartWithOutcome()).toBe(false);
    sync.syncFromMetadata();
    expect(await sync.flushPendingAfterStartWithOutcome()).toBe(true);
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    expect(setSessionMode).toHaveBeenCalledTimes(1);
    expect(cleanupAttempts).toBe(2);
    expect(metadata.sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 72, modeId: null });
    expect(logger.infoFile).toHaveBeenCalledTimes(1);
    expect(logger.infoFile).toHaveBeenCalledWith(
      '[SessionModeOverrideSync] Provider rejected session mode override; not retrying',
      { updatedAt: 71, attempt: 1 },
    );
  });

  it('settles a definitively rejected clear without writing another clear', async () => {
    const metadata: any = { sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null } };
    const updateMetadata = vi.fn(async () => {});
    const clearSessionModeOverride = vi.fn(async () => {
      throw SessionControlApplyError.definitive(new Error('rejected'));
    });
    const sync = createSessionModeOverrideSynchronizer({
      session: { getMetadataSnapshot: () => metadata, updateMetadata },
      runtime: { setSessionMode: vi.fn(async () => {}), clearSessionModeOverride },
      isStarted: () => true,
      autoApplyFromMetadata: false,
    });

    for (let i = 0; i < 5; i += 1) {
      sync.syncFromMetadata();
      await sync.flushPendingAfterStart();
    }

    expect(clearSessionModeOverride).toHaveBeenCalledTimes(1);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('does not clear a newer mode choice after an older rejection settles', async () => {
    let metadata: any = { sessionModeOverrideV1: { v: 1, updatedAt: 81, modeId: 'autopilot' } };
    let reject!: (error: unknown) => void;
    const applying = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const setSessionMode = vi.fn()
      .mockImplementationOnce(() => applying)
      .mockResolvedValue(undefined);
    const sync = createSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => { metadata = updater(metadata); },
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    metadata = { sessionModeOverrideV1: { v: 1, updatedAt: 82, modeId: 'plan' } };
    sync.syncFromMetadata();
    reject(SessionControlApplyError.definitive(new Error('rejected')));
    await sync.flushPendingAfterStart();
    await new Promise((r) => setTimeout(r, 0));

    expect(metadata.sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 82, modeId: 'plan' });
    expect(setSessionMode).toHaveBeenLastCalledWith('plan');
  });
});
