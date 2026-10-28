import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateChannel,
  DesktopUpdateRemoteOutcome,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  nextRemoteDesktopUpdateStep,
  normalizeRemoteUpdateReason,
  type RemoteDesktopUpdateAttempts,
} from "./remoteUpdateFlow.ts";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-remote-updates");

const ACTION_RETRY_DELAY = Duration.millis(250);
const PREPARED_UPDATE_TTL = Duration.minutes(5);
const CHANNEL_SWITCH_RETRY_DELAY = Duration.seconds(1);
const CHANNEL_SWITCH_RETRIES = 30;

interface PreparedUpdate {
  readonly requestId: string;
  readonly downloadedVersion: string;
  readonly status: "prepared" | "committing" | "failed";
  readonly failureReason?: string;
  readonly expiresAt: number;
  /** The track a switching request left; restored if this install fails. */
  readonly restoreChannel?: DesktopUpdateChannel;
}

type CommitClaim =
  | { readonly _tag: "invalid"; readonly expired?: PreparedUpdate }
  | { readonly _tag: "failed"; readonly prepared: PreparedUpdate }
  | { readonly _tag: "committing" }
  | { readonly _tag: "claimed"; readonly prepared: PreparedUpdate };

export const listen: Effect.Effect<
  void,
  never,
  DesktopUpdates.DesktopUpdates | DesktopTelemetryPublisher.DesktopTelemetryPublisher | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const activeRequestIdRef = yield* Ref.make(Option.none<string>());
  const requestControlRef = yield* Ref.make<{
    readonly active: Option.Option<{
      readonly requestId: string;
      readonly signal: Deferred.Deferred<void>;
    }>;
    readonly cancelledBeforeStart: ReadonlyArray<string>;
  }>({ active: Option.none(), cancelledBeforeStart: [] });
  const preparedUpdateRef = yield* Ref.make(Option.none<PreparedUpdate>());
  const pendingRestoreRef = yield* Ref.make(Option.none<Fiber.Fiber<void>>());

  const publishReport = (
    state: DesktopUpdateState,
    terminal?: { readonly outcome: DesktopUpdateRemoteOutcome; readonly reason?: string },
    explicitRequestId?: string,
  ): Effect.Effect<void> => {
    const reason = normalizeRemoteUpdateReason(terminal?.reason);
    return Ref.get(activeRequestIdRef).pipe(
      Effect.flatMap((requestId) =>
        publisher.publishUpdateReport({
          version: 1,
          type: "desktopUpdateStatus",
          ...(explicitRequestId !== undefined
            ? { requestId: explicitRequestId }
            : Option.isSome(requestId)
              ? { requestId: requestId.value }
              : {}),
          ...(terminal === undefined ? {} : { outcome: terminal.outcome }),
          ...(reason ? { reason } : {}),
          state,
        }),
      ),
    );
  };

  // Updater actions hold the channel briefly; wait them out instead of failing.
  const setChannelWhenIdle = (channel: DesktopUpdateChannel) =>
    updates.setChannel(channel).pipe(
      Effect.retry({
        while: (error) => error._tag === "DesktopUpdateActionInProgressError",
        schedule: Schedule.spaced(CHANNEL_SWITCH_RETRY_DELAY),
        times: CHANNEL_SWITCH_RETRIES,
      }),
    );

  // A switch whose build never installs puts back the track it left.
  const restoreTrack = (prepared: PreparedUpdate) =>
    prepared.restoreChannel === undefined
      ? Effect.void
      : setChannelWhenIdle(prepared.restoreChannel).pipe(Effect.ignore);

  // Restores run in the background (a failed install still holds the updater). The next request
  // waits for the latest one, so a late restore can never overwrite that request's track.
  const scheduleRestore = (prepared: PreparedUpdate) =>
    Effect.forkDetach(restoreTrack(prepared)).pipe(
      Effect.flatMap((fiber) => Ref.set(pendingRestoreRef, Option.some(fiber))),
    );

  const failPrepared = Effect.fn("DesktopRemoteUpdates.failPrepared")(function* (
    requestId: string,
    reason: string,
    state: DesktopUpdateState,
  ) {
    const failed = yield* Ref.modify(preparedUpdateRef, (prepared) => {
      if (
        Option.isNone(prepared) ||
        prepared.value.requestId !== requestId ||
        prepared.value.status === "failed"
      ) {
        return [Option.none<PreparedUpdate>(), prepared] as const;
      }
      return [
        prepared,
        Option.some({ ...prepared.value, status: "failed" as const, failureReason: reason }),
      ] as const;
    });
    if (Option.isNone(failed)) return;
    // Scheduled before the failure is reported, so the next request already waits for it.
    yield* scheduleRestore(failed.value);
    yield* publishReport(state, { outcome: "failed", reason }, requestId);
  });

  const clearActiveRequest = (requestId: string) =>
    Ref.update(activeRequestIdRef, (active) =>
      Option.isSome(active) && active.value === requestId ? Option.none() : active,
    );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const { latest, changes } = yield* updates.subscribe;
      yield* publishReport(latest);
      yield* Stream.runForEach(changes, (state) =>
        Effect.gen(function* () {
          yield* publishReport(state);
          const prepared = yield* Ref.get(preparedUpdateRef);
          if (
            Option.isSome(prepared) &&
            prepared.value.status === "committing" &&
            state.errorContext === "install"
          ) {
            const reason = state.message ?? "The desktop app failed to install the update.";
            yield* failPrepared(prepared.value.requestId, reason, state);
          }
        }),
      );
    }),
  ).pipe(Effect.forkScoped);

  const handleRequest = (request: DesktopTelemetryRequestDesktopUpdate): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const cancellation = yield* Deferred.make<void>();
        const shouldStart = yield* Ref.modify(requestControlRef, (control) => {
          if (control.cancelledBeforeStart.includes(request.requestId)) {
            return [
              false,
              {
                ...control,
                cancelledBeforeStart: control.cancelledBeforeStart.filter(
                  (requestId) => requestId !== request.requestId,
                ),
              },
            ] as const;
          }
          return [
            true,
            {
              ...control,
              active: Option.some({ requestId: request.requestId, signal: cancellation }),
            },
          ] as const;
        });
        if (!shouldStart) return;

        const pendingRestore = yield* Ref.getAndSet(pendingRestoreRef, Option.none());
        if (Option.isSome(pendingRestore)) yield* Fiber.await(pendingRestore.value);
        const now = yield* Clock.currentTimeMillis;
        const [expired, prepared] = yield* Ref.modify(preparedUpdateRef, (current) =>
          Option.isSome(current) &&
          current.value.status === "prepared" &&
          current.value.expiresAt <= now
            ? ([[current, Option.none<PreparedUpdate>()], Option.none()] as const)
            : ([[Option.none<PreparedUpdate>(), current], current] as const),
        );
        // Restore before this request picks its own track, so the two cannot race.
        if (Option.isSome(expired)) yield* restoreTrack(expired.value);
        if (Option.isSome(prepared) && prepared.value.status !== "failed") {
          yield* publishReport(
            yield* updates.getState,
            {
              outcome: "failed",
              reason: "A prepared desktop update is already in progress.",
            },
            request.requestId,
          );
          return;
        }
        yield* Ref.set(activeRequestIdRef, Option.some(request.requestId));
        yield* logInfo("remote update requested", {
          requestId: request.requestId,
          channel: request.channel,
        });
        // Switch before subscribing so the step machine never sees the old track's offer.
        const previousChannel = (yield* updates.getState).channel;
        // Set once this request prepares its build; otherwise a track switch is undone.
        let keepsTrack = request.channel === undefined;
        if (request.channel !== undefined) {
          const switched = yield* setChannelWhenIdle(request.channel).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              updates.getState.pipe(
                Effect.flatMap((state) =>
                  publishReport(
                    state,
                    { outcome: "failed", reason: error.message },
                    request.requestId,
                  ),
                ),
                Effect.as(false),
              ),
            ),
          );
          if (!switched) return;
        }
        const { latest, changes } = yield* updates.subscribe;
        const disabledReason = Option.getOrNull(yield* updates.disabledReason);
        let attempts: RemoteDesktopUpdateAttempts = { checks: 0, downloads: 0 };
        // State events can precede reservation release; re-enqueue refused actions so they retry after release.
        const retries = yield* Queue.unbounded<DesktopUpdateState>();
        const retryLater = (state: DesktopUpdateState) =>
          Effect.sleep(ACTION_RETRY_DELAY).pipe(
            Effect.andThen(Queue.offer(retries, state)),
            Effect.asVoid,
            Effect.forkScoped,
          );

        // Only a host crossing tracks needs the exact database-checked release, or an older one.
        const crossing = (state: DesktopUpdateState) =>
          request.targetVersion !== undefined &&
          request.channel !== undefined &&
          desktopUpdateChannelOf(state.currentVersion) !== request.channel;
        const step = Effect.fn("DesktopRemoteUpdates.step")(function* (
          state: DesktopUpdateState,
        ): Effect.fn.Return<boolean, never, Scope.Scope> {
          // A track switch was checked against one release; refuse any other before downloading,
          // but only after this request's own check, since a cached offer can be stale.
          const found = state.downloadedVersion ?? state.availableVersion;
          const mismatched = crossing(state) && found !== null && found !== request.targetVersion;
          if (mismatched && attempts.checks > 0 && state.status !== "checking") {
            yield* publishReport(
              state,
              {
                outcome: "failed",
                reason: `The desktop app found ${found}, not ${request.targetVersion}. Try again in a few minutes.`,
              },
              request.requestId,
            );
            return true;
          }
          const next = mismatched
            ? ({ action: attempts.checks === 0 ? "check" : "wait" } as const)
            : nextRemoteDesktopUpdateStep(state, attempts, disabledReason);
          switch (next.action) {
            case "wait":
              return false;
            case "check":
              attempts = { ...attempts, checks: attempts.checks + 1 };
              // Only a guarded crossing may be offered an older release.
              yield* updates.check("remote-update", { allowDowngrade: crossing(state) }).pipe(
                Effect.flatMap((result) => {
                  if (result.checked) return Effect.void;
                  attempts = { ...attempts, checks: attempts.checks - 1 };
                  return retryLater(state);
                }),
                Effect.forkScoped,
              );
              return false;
            case "download":
              attempts = { ...attempts, downloads: attempts.downloads + 1 };
              yield* updates.download.pipe(
                Effect.flatMap((result) => {
                  if (result.accepted) return Effect.void;
                  attempts = { ...attempts, downloads: attempts.downloads - 1 };
                  return retryLater(state);
                }),
                Effect.forkScoped,
              );
              return false;
            case "install": {
              // The download event fires before its action releases the
              // updater reservation. Wait until the prepared install can
              // be committed by the client in a separate RPC.
              if (yield* updates.isActionActive) {
                yield* retryLater(state);
                return false;
              }
              if (state.downloadedVersion === null) {
                yield* publishReport(
                  state,
                  {
                    outcome: "failed",
                    reason: "The desktop app lost the downloaded update.",
                  },
                  request.requestId,
                );
                return true;
              }
              yield* Ref.set(
                preparedUpdateRef,
                Option.some({
                  requestId: request.requestId,
                  downloadedVersion: state.downloadedVersion,
                  status: "prepared",
                  expiresAt:
                    (yield* Clock.currentTimeMillis) + Duration.toMillis(PREPARED_UPDATE_TTL),
                  ...(keepsTrack || previousChannel === request.channel
                    ? {}
                    : { restoreChannel: previousChannel }),
                }),
              );
              keepsTrack = true;
              yield* publishReport(state, { outcome: "ready-to-install" }, request.requestId);
              yield* logInfo("remote update prepared", { requestId: request.requestId });
              return true;
            }
            case "done": {
              // For a switch, "up to date" means the feed has no build of the checked release.
              const done =
                request.targetVersion !== undefined && next.outcome === "up-to-date"
                  ? {
                      outcome: "failed" as const,
                      reason: `The desktop app found no build of ${request.targetVersion}.`,
                    }
                  : next;
              yield* publishReport(
                state,
                {
                  outcome: done.outcome,
                  ...(done.reason === undefined ? {} : { reason: done.reason }),
                },
                request.requestId,
              );
              yield* logInfo("remote update finished", {
                requestId: request.requestId,
                outcome: done.outcome,
                reason: done.reason ?? null,
              });
              return true;
            }
          }
        });

        yield* Effect.raceFirst(
          Effect.gen(function* () {
            if (yield* step(latest)) return;
            yield* Stream.merge(changes, Stream.fromQueue(retries)).pipe(
              Stream.mapEffect(step),
              Stream.takeUntil((done) => done),
              Stream.runDrain,
            );
          }),
          Deferred.await(cancellation),
        );
        // Restored after the scope closes, once this request's own check and download stop.
        return !keepsTrack && previousChannel !== request.channel ? previousChannel : undefined;
      }),
    ).pipe(
      Effect.flatMap((restore) =>
        restore === undefined ? Effect.void : setChannelWhenIdle(restore).pipe(Effect.ignore),
      ),
      Effect.ensuring(
        Effect.all(
          [
            clearActiveRequest(request.requestId),
            Ref.update(requestControlRef, (control) => ({
              ...control,
              active:
                Option.isSome(control.active) &&
                control.active.value.requestId === request.requestId
                  ? Option.none()
                  : control.active,
            })),
          ],
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        logError("remote update request failed unexpectedly", {
          requestId: request.requestId,
          cause: String(cause),
        }),
      ),
    );

  yield* Stream.runForEach(publisher.updateRequests, handleRequest).pipe(Effect.forkScoped);

  yield* Stream.runForEach(publisher.updateCancellations, (cancellation) =>
    Effect.gen(function* () {
      const activeSignal = yield* Ref.modify(requestControlRef, (control) => {
        if (
          Option.isSome(control.active) &&
          control.active.value.requestId === cancellation.requestId
        ) {
          return [Option.some(control.active.value.signal), control] as const;
        }
        return [
          Option.none<Deferred.Deferred<void>>(),
          {
            ...control,
            cancelledBeforeStart: [
              ...control.cancelledBeforeStart.filter(
                (requestId) => requestId !== cancellation.requestId,
              ),
              cancellation.requestId,
            ],
          },
        ] as const;
      });
      if (Option.isSome(activeSignal)) {
        yield* Deferred.succeed(activeSignal.value, undefined);
      }
      const matchedPrepared = yield* Ref.modify(preparedUpdateRef, (prepared) => {
        if (Option.isNone(prepared) || prepared.value.requestId !== cancellation.requestId) {
          return [Option.none<PreparedUpdate>(), prepared] as const;
        }
        return [prepared, prepared.value.status === "prepared" ? Option.none() : prepared] as const;
      });
      if (Option.isSome(matchedPrepared)) {
        if (matchedPrepared.value.status === "prepared") {
          yield* scheduleRestore(matchedPrepared.value);
        }
        yield* Ref.update(requestControlRef, (control) => {
          return {
            ...control,
            cancelledBeforeStart: control.cancelledBeforeStart.filter(
              (requestId) => requestId !== cancellation.requestId,
            ),
          };
        });
      }
    }),
  ).pipe(Effect.forkScoped);

  yield* Stream.runForEach(publisher.updateCommits, (commit) =>
    Effect.gen(function* () {
      const current = yield* updates.getState;
      const now = yield* Clock.currentTimeMillis;
      const claim = yield* Ref.modify(
        preparedUpdateRef,
        (prepared): readonly [CommitClaim, Option.Option<PreparedUpdate>] => {
          if (Option.isNone(prepared) || prepared.value.requestId !== commit.requestId) {
            return [{ _tag: "invalid" as const }, prepared] as const;
          }
          if (prepared.value.status === "prepared" && prepared.value.expiresAt <= now) {
            return [{ _tag: "invalid" as const, expired: prepared.value }, Option.none()] as const;
          }
          if (prepared.value.status === "failed") {
            return [{ _tag: "failed" as const, prepared: prepared.value }, prepared] as const;
          }
          if (prepared.value.status === "committing") {
            return [{ _tag: "committing" as const }, prepared] as const;
          }
          return [
            { _tag: "claimed" as const, prepared: prepared.value },
            Option.some({ ...prepared.value, status: "committing" as const }),
          ] as const;
        },
      );
      if (claim._tag === "invalid") {
        if (claim.expired !== undefined) yield* scheduleRestore(claim.expired);
        yield* publishReport(
          yield* updates.getState,
          {
            outcome: "failed",
            reason: "This desktop update is no longer prepared.",
          },
          commit.requestId,
        );
        return;
      }
      if (claim._tag === "failed") {
        yield* publishReport(
          current,
          {
            outcome: "failed",
            reason: claim.prepared.failureReason ?? "The desktop app failed to install the update.",
          },
          commit.requestId,
        );
        return;
      }
      if (claim._tag === "committing") {
        return;
      }
      yield* Ref.set(activeRequestIdRef, Option.some(commit.requestId));
      if (current.downloadedVersion !== claim.prepared.downloadedVersion) {
        const reason = "This desktop update is no longer prepared.";
        yield* failPrepared(commit.requestId, reason, current);
        return;
      }
      const result = yield* updates.installPrepared(claim.prepared.downloadedVersion);
      if (
        !result.accepted &&
        result.state.downloadedVersion === claim.prepared.downloadedVersion &&
        (yield* updates.isInstallActive)
      ) {
        // Join the existing install; reconnect and target-version checks prove its handoff.
        yield* logInfo("remote update commit joining an in-progress install", {
          requestId: commit.requestId,
        });
        return;
      }
      if (!result.accepted || result.failed) {
        const reason = result.state.message ?? "The desktop app could not start the install.";
        yield* failPrepared(commit.requestId, reason, result.state);
        return;
      }
      // Installation kills this backend; only transport loss followed by the target version proves handoff.
    }).pipe(
      Effect.ensuring(clearActiveRequest(commit.requestId)),
      Effect.catchCause((cause) =>
        logError("remote update commit failed unexpectedly", {
          requestId: commit.requestId,
          cause: String(cause),
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);
});
