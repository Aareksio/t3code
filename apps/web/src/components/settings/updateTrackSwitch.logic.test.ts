import type { DesktopUpdateChannel, DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prepareLocalTrackSwitch } from "./updateTrackSwitch.logic";

const STABLE = "0.1.3";

/** Like the desktop app, a build on another track re-checks the feed when its track is saved. */
function fakeBridge(feed: { readonly offer: string | null; readonly failOnce?: boolean }) {
  const saved: DesktopUpdateChannel[] = [];
  let failOnce = feed.failOnce ?? false;
  let state: DesktopUpdateState = {
    enabled: true,
    status: "up-to-date",
    channel: "nightly",
    currentVersion: "0.1.4-nightly.20261027.3796",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  return {
    saved,
    bridge: {
      getUpdateState: async () => state,
      setUpdateChannel: async (channel: DesktopUpdateChannel) => {
        saved.push(channel);
        if (failOnce) {
          failOnce = false;
          throw new Error("feed check failed");
        }
        state = {
          ...state,
          channel,
          status: feed.offer === null ? "up-to-date" : "available",
          availableVersion: feed.offer,
        };
        return state;
      },
    },
  };
}

describe("prepareLocalTrackSwitch", () => {
  it("installs only the release the database guard checked", async () => {
    const ready = fakeBridge({ offer: STABLE });
    const result = await prepareLocalTrackSwitch(ready.bridge, {
      channel: "latest",
      version: STABLE,
      reinstall: true,
    });
    expect(result).toMatchObject({ ok: true, local: { availableVersion: STABLE } });
    expect(ready.saved).toEqual(["latest"]);

    const skewed = fakeBridge({ offer: "0.1.2" });
    expect(
      await prepareLocalTrackSwitch(skewed.bridge, {
        channel: "latest",
        version: STABLE,
        reinstall: true,
      }),
    ).toEqual({
      ok: false,
      message: "This app found 0.1.2, not 0.1.3. Try again in a few minutes.",
    });
    expect(skewed.saved).toEqual(["latest", "nightly"]);
  });

  it("restores the old track when saving the new one fails part way", async () => {
    const broken = fakeBridge({ offer: STABLE, failOnce: true });
    expect(
      await prepareLocalTrackSwitch(broken.bridge, {
        channel: "latest",
        version: STABLE,
        reinstall: true,
      }),
    ).toEqual({ ok: false, message: "feed check failed" });
    expect(broken.saved).toEqual(["latest", "nightly"]);
  });

  it("saves the track without a check when this app is already on it", async () => {
    const undo = fakeBridge({ offer: null });
    expect(
      await prepareLocalTrackSwitch(undo.bridge, {
        channel: "latest",
        version: STABLE,
        reinstall: false,
      }),
    ).toEqual({ ok: true, local: null });
    expect(undo.saved).toEqual(["latest"]);
  });
});
