import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { Context } from "@/context";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import type { GitHubProfile } from "./types";
import { githubConnect } from "./githubConnect";

const allowlistedProfile = {
    id: 123,
    login: "octocat",
    name: "Octo Cat",
    avatar_url: "",
} satisfies GitHubProfile;

describe("githubConnect (AccountChange integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-githubConnect-changes-",
            initEncrypt: true,
            initAuth: false,
            initFiles: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
        vi.unstubAllGlobals();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("marks an account change with a linked providers hint", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-gh-changes-u1" },
            select: { id: true },
        });

        await githubConnect(
            { uid: account.id } as any,
            { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "" } as any,
            "token",
        );

        const change = await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true, hint: true },
        });

        expect(change).toEqual({
            cursor: expect.any(Number),
            hint: { linkedProviders: true },
        });
    });

    it("does not overwrite an existing custom username when connecting GitHub", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-gh-custom-u1", username: "custom" },
            select: { id: true },
        });

        await githubConnect(
            { uid: account.id } as any,
            { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "" } as any,
            "token",
        );

        const updated = await db.account.findUnique({ where: { id: account.id }, select: { username: true } });
        expect(updated?.username).toBe("custom");
    });

    it("sets the username from GitHub login when the user has no username", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-gh-empty-u1" },
            select: { id: true },
        });

        await githubConnect(
            { uid: account.id } as any,
            { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "" } as any,
            "token",
        );

        const updated = await db.account.findUnique({ where: { id: account.id }, select: { username: true } });
        expect(updated?.username).toBe("octocat");
    });

    it("allows a listed GitHub username to connect its identity", async () => {
        harness.resetEnv({ AUTH_GITHUB_ALLOWED_USERS: "OctoCat" });
        const account = await db.account.create({
            data: { publicKey: "pk-gh-allowlisted-u1" },
            select: { id: true },
        });

        await githubConnect(
            Context.create(account.id),
            allowlistedProfile,
            "token",
        );

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
            select: { providerUserId: true },
        });
        expect(identity).toEqual({ providerUserId: "123" });
    });

    it("rejects a GitHub username outside the configured allowlist before linking", async () => {
        harness.resetEnv({ AUTH_GITHUB_ALLOWED_USERS: "someone-else" });
        const account = await db.account.create({
            data: { publicKey: "pk-gh-denied-u1" },
            select: { id: true },
        });

        await expect(githubConnect(
            Context.create(account.id),
            allowlistedProfile,
            "token",
        )).rejects.toThrow("not-eligible");

        const identities = await db.accountIdentity.findMany({ where: { accountId: account.id } });
        expect(identities).toEqual([]);
    });

    it("keeps GitHub identity connection open when the allowlist is empty", async () => {
        harness.resetEnv({ AUTH_GITHUB_ALLOWED_USERS: "" });
        const account = await db.account.create({
            data: { publicKey: "pk-gh-empty-allowlist-u1" },
            select: { id: true },
        });

        await githubConnect(
            Context.create(account.id),
            allowlistedProfile,
            "token",
        );

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "github" },
            select: { providerUserId: true },
        });
        expect(identity).toEqual({ providerUserId: "123" });
    });
});
