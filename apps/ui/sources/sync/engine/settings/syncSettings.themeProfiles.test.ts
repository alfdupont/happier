import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage, loadLocalSettings, saveLocalSettings } from '@/sync/domains/state/persistence';
import { loadPendingAccountSettings, loadPendingAccountSettingsState, savePendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { createThemeProfileMigrationEdits, encodeThemeProfileSelection, resolveAccountThemeProfileView } from '@/sync/domains/settings/themeProfiles';
import type { ThemeProfileSelectionByMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { applySettingsLocalDelta, syncSettings } from './syncSettings';

const boundary = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock('@/sync/http/client', () => ({ serverFetch: boundary.serverFetch }));

const profile = (id: string, name = id): ThemeProfileV1 => ({
    schemaVersion: 1, id, name,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' }, assetAppearance: 'dark', overrides: { light: {}, dark: {} },
});

describe('account theme library migration', () => {
    const credentials = { token: 'plain-token' };
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    const initialState = storage.getState();
    let serverLibrary: readonly ThemeProfileV1[];
    let serverAppearanceThemeSelection: unknown;
    let writes: Record<string, unknown>[];
    let serverVersion: number;

    function queueLibrary(profiles: readonly ThemeProfileV1[], selection?: ThemeProfileSelectionByMode) {
        const state = storage.getState();
        const persisted = loadPendingAccountSettingsState(scope);
        const view = resolveAccountThemeProfileView({ profiles: state.settings.themeProfiles,
            legacy: state.localSettings.themeProfiles, selection: state.localSettings.themeProfileSelection,
            legacyScope: state.localSettings.themeProfileLegacyAccountScope, scope,
            pendingProfiles: persisted.settings.themeProfiles, pendingIntent: persisted.themeProfileMigration });
        const next = { profiles, activeProfileIds: selection ?? view.state.activeProfileIds };
        let pending = persisted.settings;
        storage.getState().applyLocalSettings({ themeProfileLegacyAccountScope: scope });
        applySettingsLocalDelta({ delta: { themeProfiles: profiles }, durability: 'immediate', settingsSecretsKey: null,
            themeProfileMigration: { edits: createThemeProfileMigrationEdits(view.state, next, view.legacyProfileIds),
                legacyProfileIds: Object.fromEntries(view.legacyProfileIds),
                representedLegacyProfileIds: Object.fromEntries(view.representedLegacyProfileIds) },
            getPendingSettings: () => pending, setPendingSettings: value => { pending = value; },
            schedulePendingSettingsFlush: () => {},
        });
        storage.getState().applyLocalSettings({ themeProfileSelection: encodeThemeProfileSelection(next, view.legacyProfileIds) });
        return pending;
    }

    beforeEach(() => {
        getPersistenceStorage().clearAll();
        invalidateAccountEncryptionModeCache();
        writes = [];
        serverVersion = 4;
        serverLibrary = [profile('cloud')];
        serverAppearanceThemeSelection = undefined;
        const localSettings = { ...localSettingsDefaults, themeProfileSelection: { light: null, dark: 'local' }, themeProfiles: {
            profiles: [profile('local')], activeProfileIds: { light: null, dark: 'local' },
        } };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });
        savePendingAccountSettings(scope, {});
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                writes.push(body.content.v);
                serverLibrary = body.content.v.themeProfiles;
                if (Object.hasOwn(body.content.v, 'appearanceThemeSelectionV1')) {
                    serverAppearanceThemeSelection = body.content.v.appearanceThemeSelectionV1;
                }
                return Response.json({ success: true, version: ++serverVersion });
            }
            if (path === '/v2/account/settings') {
                return Response.json({ content: { t: 'plain', v: {
                    themeProfiles: serverLibrary,
                    ...(serverAppearanceThemeSelection !== undefined
                        ? { appearanceThemeSelectionV1: serverAppearanceThemeSelection } : {}),
                } }, version: serverVersion });
            }
            throw new Error(`Unexpected request: ${path}`);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        getPersistenceStorage().clearAll();
        storage.setState(initialState, true);
    });

    it('merges local profiles into the fetched account library without syncing activation', async () => {
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ themeProfiles: [profile('cloud'), profile('local')] });
        expect(writes[0]).not.toHaveProperty('themeProfileSelection');
        expect(storage.getState().settings).toMatchObject({ themeProfiles: [profile('cloud'), profile('local')] });
        expect(loadLocalSettings()).toMatchObject({
            themeProfiles: { profiles: [] }, themeProfileSelection: { light: null, dark: 'local' },
        });
    });

    it('migrates remembered profiles into the account library before restoring an unset device', async () => {
        const remembered = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        } as const;
        serverLibrary = [];
        serverAppearanceThemeSelection = remembered;
        const localSettings = { ...localSettingsDefaults, themePreference: 'adaptive' as const };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(writes).toHaveLength(1);
        const references = { themePreference: 'dark',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'remembered' } } };
        expect(writes[0]).toMatchObject({ themeProfiles: [profile('remembered')], appearanceThemeSelectionV1: references });
        expect(serverLibrary).toEqual([profile('remembered')]);
        expect(storage.getState().settings.themeProfiles).toEqual([profile('remembered')]);
        expect(loadLocalSettings()).toMatchObject({
            themePreference: 'dark', themeProfileSelection: { light: null, dark: 'remembered' },
        });
        expect(serverAppearanceThemeSelection).toEqual(references);
    });

    it('imports remembered profiles without replacing an explicit device theme', async () => {
        serverLibrary = [];
        serverAppearanceThemeSelection = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        };
        const localSettings = { ...localSettingsDefaults, themePreference: 'light' as const,
            themeProfileSelection: { light: 'paperLight', dark: null } };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(serverLibrary).toEqual([profile('remembered')]);
        expect(serverAppearanceThemeSelection).toEqual({ themePreference: 'dark',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'remembered' } } });
        expect(loadLocalSettings()).toMatchObject({ themePreference: 'light', themeProfileSelection: { light: 'paperLight', dark: null } });
    });

    it('backfills a device selection made before its account could remember one', async () => {
        const localSettings = { ...localSettingsDefaults, themePreference: 'light' as const,
            themeProfileSelection: { light: 'catppuccinLatte', dark: null } };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(serverAppearanceThemeSelection).toEqual({ themePreference: 'light',
            themeProfiles: { profiles: [], activeProfileIds: { light: 'catppuccinLatte', dark: null } } });
    });

    it('keeps an explicit pending selection while migrating the old embedded selection', async () => {
        const historical = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        } as const;
        const explicit = {
            themePreference: 'light',
            themeProfiles: { profiles: [], activeProfileIds: { light: 'catppuccinLatte', dark: null } },
        } as const;
        serverLibrary = [];
        serverAppearanceThemeSelection = historical;
        const localSettings = { ...localSettingsDefaults, themePreference: 'light' as const,
            themeProfileSelection: { light: 'catppuccinLatte', dark: null } };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: { appearanceThemeSelectionV1: explicit }, clearPendingSettings: vi.fn() });

        expect(serverLibrary).toEqual([profile('remembered')]);
        expect(serverAppearanceThemeSelection).toEqual(explicit);
    });

    it('keeps a device reset made during the account migration above captured theme snapshots', async () => {
        const historical = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        } as const;
        const capturedSelection = {
            themePreference: 'dark',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'catppuccinMocha' } },
        } as const;
        const latestSelection = {
            themePreference: 'light',
            themeProfiles: { profiles: [], activeProfileIds: { light: 'catppuccinLatte', dark: null } },
        } as const;
        const resetSelection = {
            themePreference: 'adaptive',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: null } },
        } as const;
        serverLibrary = [];
        serverAppearanceThemeSelection = historical;
        const localSettings = { ...localSettingsDefaults, themePreference: 'dark' as const,
            themeProfileSelection: { light: null, dark: 'catppuccinMocha' } };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });
        savePendingAccountSettings(scope, { appearanceThemeSelectionV1: latestSelection });

        const serve = boundary.serverFetch.getMockImplementation()!;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            const response = await serve(path, init);
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                storage.getState().applyLocalSettings({ themePreference: 'adaptive',
                    themeProfileSelection: { light: null, dark: null } });
                savePendingAccountSettings(scope, { appearanceThemeSelectionV1: resetSelection });
            }
            return response;
        });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: { appearanceThemeSelectionV1: capturedSelection }, clearPendingSettings: vi.fn() });

        expect(serverAppearanceThemeSelection).toEqual(latestSelection);
        expect(loadLocalSettings()).toMatchObject({ themePreference: 'adaptive',
            themeProfileSelection: { light: null, dark: null } });
        expect(loadPendingAccountSettings(scope).appearanceThemeSelectionV1).toEqual(resetSelection);
    });

    it('remaps remembered profile IDs through an account library collision', async () => {
        const selected = profile('remembered', 'This device selected this version');
        serverLibrary = [profile('remembered', 'Existing account version')];
        serverAppearanceThemeSelection = {
            themePreference: 'dark',
            themeProfiles: { profiles: [selected], activeProfileIds: { light: null, dark: selected.id } },
        };
        const localSettings = { ...localSettingsDefaults, themePreference: 'adaptive' as const };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([
            ['remembered', 'Existing account version'], ['remembered_2', 'This device selected this version'],
        ]);
        expect(serverAppearanceThemeSelection).toEqual({ themePreference: 'dark',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'remembered_2' } } });
        expect(loadLocalSettings()).toMatchObject({ themePreference: 'dark',
            themeProfileSelection: { light: null, dark: 'remembered_2' } });
    });

    it('keeps remembered selection and profiles when the account library migration is rejected', async () => {
        const remembered = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        } as const;
        serverLibrary = [];
        serverAppearanceThemeSelection = remembered;
        const localSettings = { ...localSettingsDefaults, themePreference: 'adaptive' as const };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });
        const serve = boundary.serverFetch.getMockImplementation()!;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                return Response.json({ success: false, error: 'temporarily-unavailable' });
            }
            return serve(path, init);
        });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await expect(syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() }))
            .rejects.toThrow('Failed to update settings (v2): 200');

        expect(serverLibrary).toEqual([]);
        expect(serverAppearanceThemeSelection).toEqual(remembered);
        expect(loadLocalSettings()).toMatchObject({ themePreference: 'adaptive', themeProfileSelection: null });
    });

    it('does not reimport the historical profile snapshot after its account copy is deleted', async () => {
        const remembered = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        } as const;
        serverLibrary = [];
        serverAppearanceThemeSelection = remembered;
        const localSettings = { ...localSettingsDefaults, themePreference: 'adaptive' as const };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });
        expect(serverLibrary.map(entry => entry.id)).toEqual(['remembered']);

        serverLibrary = [];
        saveLocalSettings({ ...localSettingsDefaults, themePreference: 'adaptive' });
        storage.getState().applyLocalSettings({ ...localSettingsDefaults, themePreference: 'adaptive' });
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(serverLibrary).toEqual([]);
    });

    it('does not restore a remembered profile into a different active account after migration acknowledgement', async () => {
        const remembered = {
            themePreference: 'dark',
            themeProfiles: { profiles: [profile('remembered')], activeProfileIds: { light: null, dark: 'remembered' } },
        } as const;
        serverLibrary = [];
        serverAppearanceThemeSelection = remembered;
        const localSettings = { ...localSettingsDefaults, themePreference: 'adaptive' as const };
        saveLocalSettings(localSettings);
        storage.setState({ settings: { ...settingsDefaults }, settingsVersion: 0, settingsScope: scope, localSettings });
        const otherScope = { ...scope, accountId: 'account-b' };
        const serve = boundary.serverFetch.getMockImplementation()!;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                storage.getState().activateSettingsScope(otherScope);
                storage.getState().applyLocalSettings({ themePreference: 'light', themeProfileSelection: { light: 'paperLight', dark: null } });
            }
            return serve(path, init);
        });

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });

        expect(serverLibrary).toEqual([profile('remembered')]);
        expect(storage.getState().settingsScope).toEqual(otherScope);
        expect(loadLocalSettings()).toMatchObject({ themePreference: 'light',
            themeProfileSelection: { light: 'paperLight', dark: null } });
    });

    it('durably queues a library before its legacy source can be consumed, including a matching cached value', () => {
        const delta = { themeProfiles: [profile('local', 'Edited local')] };
        storage.getState().applySettingsLocal(delta);
        let memoryPending = {};
        applySettingsLocalDelta({
            delta, durability: 'immediate', settingsSecretsKey: null,
            getPendingSettings: () => memoryPending,
            setPendingSettings: (next) => { memoryPending = next; },
            schedulePendingSettingsFlush: () => {},
        });
        // A restart/in-flight GET reads persistence, not the debounced in-memory object.
        expect(loadPendingAccountSettings(scope)).toEqual(delta);
    });

    it('keeps the legacy profiles when the account update fails', async () => {
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (init?.method === 'POST') throw new Error('offline');
            return Response.json({ content: { t: 'plain', v: { themeProfiles: serverLibrary } }, version: serverVersion });
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await expect(syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() }))
            .rejects.toThrow('offline');
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([profile('local')]);
    });

    it('preserves unseen account profiles when a legacy profile is edited before the first fetch', async () => {
        const edited = profile('local', 'Edited before sync');
        const pending = queueLibrary([edited]);
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending,
            clearPendingSettings: next => savePendingAccountSettings(scope, next) });
        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([
            ['cloud', 'cloud'], ['local', 'Edited before sync'],
        ]);
        expect(Object.keys(writes[0])).toEqual(['themeProfiles', 'appearanceThemeSelectionV1']);
        expect(writes[0].appearanceThemeSelectionV1).toEqual({ themePreference: 'adaptive',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'local' } } });
    });

    it('retains unrelated edits awaiting the existing quiet flush while staging a migration attempt', async () => {
        const pending = queueLibrary([profile('local', 'Edited local')]);
        let latestPending = pending;
        const serve = boundary.serverFetch.getMockImplementation()!;
        let changed = false;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v2/account/settings' && !init?.method && !changed) {
                changed = true;
                applySettingsLocalDelta({ delta: { analyticsOptOut: true }, settingsSecretsKey: null,
                    getPendingSettings: () => latestPending, setPendingSettings: next => { latestPending = next; },
                    schedulePendingSettingsFlush: () => {},
                });
            }
            return serve(path, init);
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending,
            getLatestPendingSettings: () => latestPending,
            clearPendingSettings: next => { latestPending = next; savePendingAccountSettings(scope, next); } });
        expect(latestPending.analyticsOptOut).toBe(true);
        expect(loadPendingAccountSettings(scope).analyticsOptOut).toBe(true);
    });

    it('preserves unseen account profiles without resurrecting a deleted legacy profile', async () => {
        const pending = queueLibrary([], { light: null, dark: null });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending,
            clearPendingSettings: next => savePendingAccountSettings(scope, next) });
        expect(serverLibrary.map(entry => entry.id)).toEqual(['cloud']);
    });

    it('rebases a newer in-flight edit and selection through the acknowledged legacy collision map', async () => {
        serverLibrary = [profile('local', 'Other device')];
        const pending = queueLibrary([profile('local', 'First edit')]);
        const serve = boundary.serverFetch.getMockImplementation()!;
        let changed = false;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (init?.method === 'POST' && !changed) {
                changed = true;
                queueLibrary([profile('local', 'Second edit')], { light: 'local', dark: null });
            }
            return serve(path, init);
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const clearPendingSettings = (next: Parameters<typeof savePendingAccountSettings>[1]) => savePendingAccountSettings(scope, next);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending, clearPendingSettings });
        expect(loadPendingAccountSettings(scope).themeProfiles?.map(entry => [entry.id, entry.name])).toEqual([
            ['local', 'Other device'], ['local_2', 'Second edit'],
        ]);
        expect(loadLocalSettings().themeProfileSelection).toEqual({ light: 'local_2', dark: null });
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: loadPendingAccountSettings(scope), clearPendingSettings });
        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([
            ['local', 'Other device'], ['local_2', 'Second edit'],
        ]);
        expect(loadPendingAccountSettingsState(scope).themeProfileMigration).toBeNull();
    });

    it('does not reimport the old draft after interruption between server acknowledgement and local cleanup', async () => {
        serverLibrary = [profile('local', 'Other device')];
        const pending = queueLibrary([profile('local', 'Edited local')]);
        const mmkv = getPersistenceStorage();
        const save = mmkv.set.bind(mmkv);
        const interrupted = vi.spyOn(mmkv, 'set').mockImplementation((key, value) => {
            if (key === 'local-settings' && typeof value === 'string'
                && JSON.parse(value).themeProfiles.profiles.length === 0) throw new Error('simulated interrupted cleanup');
            save(key, value);
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const clearPendingSettings = (next: Parameters<typeof savePendingAccountSettings>[1]) => savePendingAccountSettings(scope, next);
        await expect(syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending, clearPendingSettings }))
            .rejects.toThrow('simulated interrupted cleanup');
        interrupted.mockRestore();
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: loadPendingAccountSettings(scope), clearPendingSettings });
        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([
            ['local', 'Other device'], ['local_2', 'Edited local'],
        ]);
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([]);
    });

    it('retries an accepted edit whose response was lost without duplicating the legacy profile', async () => {
        serverLibrary = [profile('local', 'Other device')];
        const pending = queueLibrary([profile('local', 'Edited local')]);
        const serve = boundary.serverFetch.getMockImplementation()!;
        let interrupted = false;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            const response = await serve(path, init);
            if (init?.method === 'POST' && !interrupted) {
                interrupted = true;
                throw new Error('response lost');
            }
            return response;
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const clearPendingSettings = (next: Parameters<typeof savePendingAccountSettings>[1]) => savePendingAccountSettings(scope, next);
        await expect(syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending, clearPendingSettings }))
            .rejects.toThrow('response lost');
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: loadPendingAccountSettings(scope), clearPendingSettings });
        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([
            ['local', 'Other device'], ['local_2', 'Edited local'],
        ]);
    });

    it('edits an already deduplicated account profile without reimporting its legacy definition', async () => {
        serverLibrary = [profile('local')];
        storage.getState().applySettingsLocal({ themeProfiles: serverLibrary });
        const pending = queueLibrary([profile('local', 'Edited shared profile')]);
        const serve = boundary.serverFetch.getMockImplementation()!;
        let interrupted = false;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            const response = await serve(path, init);
            if (init?.method === 'POST' && !interrupted) {
                interrupted = true;
                throw new Error('response lost');
            }
            return response;
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const clearPendingSettings = (next: Parameters<typeof savePendingAccountSettings>[1]) => savePendingAccountSettings(scope, next);
        await expect(syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending, clearPendingSettings }))
            .rejects.toThrow('response lost');
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: loadPendingAccountSettings(scope), clearPendingSettings });
        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([['local', 'Edited shared profile']]);
    });

    it.each([true, false])('reuses the imported identity when a retry finds the original conflicting ID freed (cached=%s)', async (cached) => {
        serverLibrary = [profile('local', 'Other device')];
        if (cached) storage.getState().applySettingsLocal({ themeProfiles: serverLibrary });
        const pending = queueLibrary(cached ? [profile('local', 'Other device'), profile('local_2', 'Edited local')]
            : [profile('local', 'Edited local')]);
        const serve = boundary.serverFetch.getMockImplementation()!;
        let interrupted = false;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            const response = await serve(path, init);
            if (init?.method === 'POST' && !interrupted) {
                interrupted = true;
                // Another device removes the original collision while this reply is lost.
                serverLibrary = serverLibrary.filter(entry => entry.id !== 'local');
                serverVersion += 1;
                throw new Error('response lost');
            }
            return response;
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const clearPendingSettings = (next: Parameters<typeof savePendingAccountSettings>[1]) => savePendingAccountSettings(scope, next);
        await expect(syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: pending, clearPendingSettings }))
            .rejects.toThrow('response lost');
        await syncSettings({ credentials, encryption, settingsScope: scope,
            pendingSettings: loadPendingAccountSettings(scope), clearPendingSettings });
        expect(serverLibrary.map(entry => [entry.id, entry.name])).toEqual([['local_2', 'Edited local']]);
    });

    it('does not migrate a failed import into a different account', async () => {
        storage.getState().applyLocalSettings({ themeProfileLegacyAccountScope: scope });
        const otherScope = { ...scope, accountId: 'account-b' };
        storage.setState({ settingsScope: otherScope });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: otherScope, pendingSettings: {}, clearPendingSettings: vi.fn() });
        expect(writes).toEqual([]);
        expect(storage.getState().settings).toMatchObject({ themeProfiles: [profile('cloud')] });
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([profile('local')]);
    });

    it('does not restore migrated profiles after a subsequent deletion', async () => {
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const clearPendingSettings = (pending: Parameters<typeof savePendingAccountSettings>[1]) => savePendingAccountSettings(scope, pending);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings });
        const pendingSettings = { themeProfiles: [profile('cloud')] };
        savePendingAccountSettings(scope, pendingSettings);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings, clearPendingSettings });
        expect(serverLibrary).toEqual([profile('cloud')]);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings });
        expect(writes).toHaveLength(2);
        expect(storage.getState().settings).toMatchObject({ themeProfiles: [profile('cloud')] });
    });

    it('remerges migration input with a newer account library after a version conflict', async () => {
        const serve = boundary.serverFetch.getMockImplementation()!;
        let conflicted = false;
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (init?.method === 'POST' && !conflicted) {
                conflicted = true;
                serverVersion += 1;
                serverLibrary = [...serverLibrary, profile('another-device')];
                return Response.json({ success: false, error: 'version-mismatch', currentVersion: serverVersion,
                    currentContent: { t: 'plain', v: { themeProfiles: serverLibrary } } });
            }
            return serve(path, init);
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });
        expect(serverLibrary.map((entry) => entry.id)).toEqual(['cloud', 'another-device', 'local']);
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([]);
    });

    it('finishes a captured account migration without changing another account selection', async () => {
        const serve = boundary.serverFetch.getMockImplementation()!;
        const otherScope = { ...scope, accountId: 'account-b' };
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                storage.getState().activateSettingsScope(otherScope);
                storage.getState().applyLocalSettings({ themeProfileSelection: { light: 'paperLight', dark: 'nightDark' } });
            }
            return serve(path, init);
        });
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await syncSettings({ credentials, encryption, settingsScope: scope, pendingSettings: {}, clearPendingSettings: vi.fn() });
        expect(serverLibrary.map((entry) => entry.id)).toEqual(['cloud', 'local']);
        expect(storage.getState().settingsScope).toEqual(otherScope);
        expect(storage.getState().settings.themeProfiles).toEqual([]);
        expect(loadLocalSettings().themeProfileSelection).toEqual({ light: 'paperLight', dark: 'nightDark' });
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([]);
    });
});
