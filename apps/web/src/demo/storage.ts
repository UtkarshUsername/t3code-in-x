import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  Persistence,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  CredentialStore,
  makePullRequestRoutingPermissions,
  ProfileStore,
  PullRequestRoutingPermissions,
  type StoredPullRequestRoutingPermission,
} from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  ServerConfig,
  VcsListRefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* Ref.make(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    const routing = yield* Ref.make<ReadonlyArray<StoredPullRequestRoutingPermission>>([]);
    const routingPermissions = yield* makePullRequestRoutingPermissions({
      read: Ref.get(routing),
      write: (permissions) => Ref.set(routing, permissions),
    });
    const shell = new Map<EnvironmentId, OrchestrationV2ShellSnapshot>();
    const threads = new Map<string, OrchestrationV2ThreadDetailSnapshot>();
    const configs = new Map<EnvironmentId, ServerConfig>();
    const refs = new Map<string, VcsListRefsResult>();
    const cacheKey = (environmentId: EnvironmentId, value: string) => `${environmentId}:${value}`;
    const clearKeys = (values: Map<string, unknown>, environmentId: EnvironmentId) => {
      for (const key of values.keys()) {
        if (key.startsWith(`${environmentId}:`)) values.delete(key);
      }
    };

    const targetStore = Persistence.ConnectionTargetStore.of({
      list: Ref.get(catalog).pipe(Effect.map((document) => document.targets)),
      listDisabled: Ref.get(catalog).pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: (registration, routes) =>
        Ref.update(catalog, (document) =>
          registerConnectionInCatalog(document, registration, routes),
        ),
      setRoutes: (environmentId, routes) =>
        Ref.update(catalog, (document) => setRoutesInCatalog(document, environmentId, routes)),
      remove: (environmentId) =>
        Ref.update(catalog, (document) => removeConnectionFromCatalog(document, environmentId)),
      setEnabled: (environmentId, enabled) =>
        Ref.update(catalog, (document) =>
          setConnectionEnabledInCatalog(document, environmentId, enabled),
        ),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        Ref.get(catalog).pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((profile) => profile.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        Ref.update(catalog, (document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        Ref.update(catalog, (document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        Ref.get(catalog).pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        Ref.update(catalog, (document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        Ref.update(catalog, (document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        Ref.get(catalog).pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
            ),
          ),
        ),
      put: (token) =>
        Ref.update(catalog, (document) => putRemoteDpopTokenInCatalog(document, token)),
      remove: (environmentId) =>
        Ref.update(catalog, (document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    const cacheStore = Persistence.EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(shell.get(environmentId))),
      saveShell: (environmentId, snapshot) =>
        Effect.sync(() => {
          shell.set(environmentId, snapshot);
        }),
      loadThread: (environmentId, threadId) =>
        Effect.sync(() => Option.fromUndefinedOr(threads.get(cacheKey(environmentId, threadId)))),
      saveThread: (environmentId, snapshot) =>
        Effect.sync(() => {
          threads.set(cacheKey(environmentId, snapshot.projection.thread.id), snapshot);
        }),
      removeThread: (environmentId, threadId) =>
        Effect.sync(() => {
          threads.delete(cacheKey(environmentId, threadId));
        }),
      loadServerConfig: (environmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(configs.get(environmentId))),
      saveServerConfig: (environmentId, config) =>
        Effect.sync(() => {
          configs.set(environmentId, config);
        }),
      loadVcsRefs: (environmentId, cwd) =>
        Effect.sync(() => Option.fromUndefinedOr(refs.get(cacheKey(environmentId, cwd)))),
      saveVcsRefs: (environmentId, cwd, value) =>
        Effect.sync(() => {
          refs.set(cacheKey(environmentId, cwd), value);
        }),
      removeVcsRefs: (environmentId, cwd) =>
        Effect.sync(() => {
          refs.delete(cacheKey(environmentId, cwd));
        }),
      clearVcsRefs: (environmentId) => Effect.sync(() => clearKeys(refs, environmentId)),
      clear: (environmentId) =>
        Effect.sync(() => {
          shell.delete(environmentId);
          configs.delete(environmentId);
          clearKeys(threads, environmentId);
          clearKeys(refs, environmentId);
        }),
    });

    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, routingPermissions),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(Persistence.EnvironmentCacheStore, cacheStore),
    );
  }),
);
