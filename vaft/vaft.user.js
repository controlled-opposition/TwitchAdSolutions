// ==UserScript==
// @name         TwitchAdSolutions (vaft)
// @namespace    https://github.com/controlled-opposition/TwitchAdSolutions
// @version      69.4.0
// @description  Multiple solutions for blocking Twitch ads (vaft)
// @updateURL    https://github.com/controlled-opposition/TwitchAdSolutions/raw/master/vaft/vaft.user.js
// @downloadURL  https://github.com/controlled-opposition/TwitchAdSolutions/raw/master/vaft/vaft.user.js
// @author       https://github.com/cleanlock/VideoAdBlockForTwitch#credits
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  "use strict";
  // src/shared/hook.ts
  function installHook(target, key, fn, label) {
    try {
      target[key] = fn;
    } catch {
    }
    if (target[key] !== fn) {
      try {
        const desc = Object.getOwnPropertyDescriptor(target, key);
        if (desc?.configurable) {
          Object.defineProperty(target, key, {
            value: fn,
            writable: true,
            configurable: true,
            enumerable: desc.enumerable
          });
        }
      } catch {
      }
    }
    let hooked = false;
    try {
      hooked = target[key] === fn;
    } catch {
    }
    if (!hooked) {
      console.log(
        "[AD DEBUG] Could not hook " + label + ": the browser or another extension does not let it be replaced"
      );
    }
    return hooked;
  }

  // src/page/twitch.ts
  function findReactNodes(root, constraints) {
    const found = constraints.map(() => null);
    let remaining = constraints.length;
    function visit(fiber) {
      const stateNode = fiber.stateNode;
      if (stateNode) {
        for (let i = 0; i < constraints.length; i++) {
          if (!found[i] && constraints[i](stateNode)) {
            found[i] = stateNode;
            if (--remaining === 0) return true;
          }
        }
      }
      for (let node = fiber.child; node; node = node.sibling) {
        if (visit(node)) return true;
      }
      return false;
    }
    visit(root);
    return found;
  }
  function findReactNode(root, constraint) {
    return findReactNodes(root, [constraint])[0];
  }
  var cachedRootNode = null;
  var cachedContainerKey = null;
  function findReactRootNode() {
    let reactRootNode = null;
    if (!cachedRootNode) {
      cachedRootNode = document.querySelector("#root");
    }
    const rootNode = cachedRootNode;
    if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
      reactRootNode = rootNode._reactRootContainer._internalRoot.current;
    }
    if (reactRootNode == null && rootNode != null) {
      cachedContainerKey ??= Object.keys(rootNode).find((x) => x.startsWith("__reactContainer") || x.startsWith("__reactFiber")) ?? null;
      if (cachedContainerKey != null) {
        reactRootNode = rootNode[cachedContainerKey];
      }
    }
    return reactRootNode;
  }
  var firstPlayerNullAt = 0;
  var loggedNoPlayer = false;
  var firstStateNullAt = 0;
  var loggedNoState = false;
  function getPlayerAndState() {
    const reactRootNode = findReactRootNode();
    if (!reactRootNode) {
      return null;
    }
    let [player, playerState] = findReactNodes(reactRootNode, [
      (node) => node.setPlayerActive && node.props && node.props.mediaPlayerInstance,
      (node) => node.setSrc && node.setInitialPlaybackSettings
    ]);
    player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
    if (player?.playerInstance) {
      player = player.playerInstance;
    }
    if (!player) {
      player = findReactNode(
        reactRootNode,
        (node) => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state
      );
    }
    const playerStateFallback = !playerState ? findReactNode(reactRootNode, (node) => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement) : null;
    const playerStateFallback2 = !playerState && !playerStateFallback ? findReactNode(reactRootNode, (node) => node.state?.videoPlayerInstance?.playerMode !== void 0)?.state?.videoPlayerInstance : null;
    const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
    if (!player) {
      if (!firstPlayerNullAt) firstPlayerNullAt = Date.now();
      if (!loggedNoPlayer && Date.now() - firstPlayerNullAt > 1e4) {
        loggedNoPlayer = true;
        console.log(
          "[AD DEBUG] Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance"
        );
      }
    } else {
      firstPlayerNullAt = 0;
    }
    if (!finalPlayerState) {
      if (!firstStateNullAt) firstStateNullAt = Date.now();
      if (!loggedNoState && Date.now() - firstStateNullAt > 1e4) {
        loggedNoState = true;
        console.log(
          "[AD DEBUG] Player state not found for 10s+ — Twitch may have renamed setSrc/setInitialPlaybackSettings"
        );
      }
    } else {
      firstStateNullAt = 0;
    }
    return {
      player,
      state: finalPlayerState
    };
  }
  function getPlayerVideoElement() {
    const videos = document.getElementsByTagName("video");
    for (let i = 0; i < videos.length; i++) {
      if (!videos[i].dataset.tasAdHidden) {
        return videos[i];
      }
    }
    return null;
  }

  // src/shared/config.ts
  function defaultSharedConfig() {
    return {
      ReloadPlayerAfterAd: true,
      EarlyReloadPollThreshold: 3,
      // Twitch's player polls the playlist about every 2s
      PinBackupPlayerType: true,
      PreferLowQualityBackup: true,
      // autoplay tokens only get a 360p variant ladder
      // Field data: every observed channel serves ads on every Source-tier backup type.
      FastAutoplayFirstTry: true,
      // Users report fewer loading circles than with stripping in place (no MediaSource mixing).
      BackupSwapFirst: true,
      // Off: Twitch may fingerprint the always-complete beacon pattern while still answering 200
      // (TTV-AB maintainer hypothesis).
      DisableAdSpoofing: true,
      // Issue #129 mode D. A hard reload shows a black screen and play icon on desktop; its
      // MediaSource flush is only needed after strip injection.
      SoftReloadNoStrip: true,
      ForceAccessTokenPlayerType: "popout",
      GQLDeviceID: null,
      AuthorizationHeader: void 0,
      ClientIntegrityHeader: null,
      ClientVersion: null,
      ClientSession: null
    };
  }
  var GQL_HEADER_RELAYS = [
    { headers: ["X-Device-Id", "Device-ID"], field: "GQLDeviceID", key: "UpdateDeviceId" },
    { headers: ["Client-Version"], field: "ClientVersion", key: "UpdateClientVersion" },
    { headers: ["Client-Session-Id"], field: "ClientSession", key: "UpdateClientSession" },
    { headers: ["Client-Integrity"], field: "ClientIntegrityHeader", key: "UpdateClientIntegrityHeader" },
    { headers: ["Authorization"], field: "AuthorizationHeader", key: "UpdateAuthorizationHeader" }
  ];
  function pickSharedConfig(source) {
    const config = defaultSharedConfig();
    for (const key of Object.keys(config)) {
      config[key] = source[key];
    }
    return config;
  }

  // src/page/stall.ts
  var ESCALATE_AFTER_FIXES = 3;
  function createStallLadder() {
    return { frozenTicks: 0, fixAttempts: 0, reloadUsed: false };
  }
  function resetStallLadder(ladder) {
    ladder.frozenTicks = 0;
    ladder.fixAttempts = 0;
    ladder.reloadUsed = false;
  }
  function stallTick(ladder, observation, frozenTicksToFix, reloadCap) {
    if (observation === "hold") {
      return { action: "none", capped: false };
    }
    if (observation === "healthy") {
      resetStallLadder(ladder);
      return { action: "none", capped: false };
    }
    ladder.frozenTicks++;
    if (ladder.frozenTicks < frozenTicksToFix) {
      return { action: "none", capped: false };
    }
    ladder.frozenTicks = 0;
    ladder.fixAttempts++;
    const wouldEscalate = ladder.fixAttempts >= ESCALATE_AFTER_FIXES;
    if (wouldEscalate && (!reloadCap || !ladder.reloadUsed)) {
      ladder.fixAttempts = 0;
      ladder.reloadUsed = true;
      return { action: "reload", capped: false };
    }
    return { action: "pause-play", capped: wouldEscalate };
  }

  // src/page/state.ts
  function createPageState() {
    return {
      ...defaultSharedConfig(),
      RecoverFromSilentMute: true,
      DisablePostBreakWedge: false,
      DisableReloadCap: false,
      DriftCorrectionRate: 1.1,
      PlayerBufferingDelay: 600,
      PlayerBufferingSameStateCount: 3,
      // Above ~0.5s a pause/play fix makes Twitch's playback monitor snap to "buffered region
      // 0.04…", and each fix degrades currentTime further.
      PlayerBufferingDangerZone: 0.5,
      PlayerBufferingMinRepeatDelay: 8e3
    };
  }
  var state = createPageState();
  var runtime = {
    isActivelyStrippingAds: false,
    localStorageHookFailed: false,
    playerForMonitoringBuffering: null
  };
  var playerBufferState = {
    channelName: null,
    hasStreamStarted: false,
    position: 0,
    bufferedPosition: 0,
    bufferDuration: 0,
    stall: createStallLadder(),
    lastFixTime: 0,
    isLive: true,
    lastBackupSwitchAt: 0,
    lastReloadAt: 0,
    userPauseIntent: false,
    loggedPauseIntent: false,
    scriptPausedAt: 0,
    inAdBreak: false,
    vaftEverUnmuted: false,
    hasHadData: false,
    adStall: { phase: "idle" },
    lastAdStallReloadAt: 0,
    wedgeWasInAdBreak: false,
    wedge: { phase: "disarmed" }
  };

  // src/page/drift.ts
  var CHECK_INTERVAL_MS = 500;
  var SAFETY_TIMEOUT_MS = 3e4;
  var CAUGHT_UP_S = 1;
  var catchup = null;
  function cancelDriftCorrection() {
    if (!catchup) return;
    const { element, interval, timeout } = catchup;
    catchup = null;
    clearInterval(interval);
    clearTimeout(timeout);
    try {
      element.playbackRate = 1;
    } catch {
    }
    try {
      const current = getPlayerVideoElement();
      if (current && current !== element && current.playbackRate === state.DriftCorrectionRate) {
        current.playbackRate = 1;
      }
    } catch {
    }
  }
  function startDriftCorrection(videoElement) {
    if (state.DriftCorrectionRate <= 1) return;
    cancelDriftCorrection();
    videoElement.playbackRate = state.DriftCorrectionRate;
    console.log("[AD DEBUG] Drift correction: catching up at " + state.DriftCorrectionRate + "x");
    const interval = setInterval(() => {
      try {
        const vid = getPlayerVideoElement();
        if (vid && vid.buffered.length > 0) {
          if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= CAUGHT_UP_S) {
            console.log("[AD DEBUG] Drift correction complete — resumed normal playback speed");
            cancelDriftCorrection();
          }
        }
      } catch {
        cancelDriftCorrection();
      }
    }, CHECK_INTERVAL_MS);
    const timeout = setTimeout(cancelDriftCorrection, SAFETY_TIMEOUT_MS);
    catchup = { element: videoElement, interval, timeout };
  }

  // src/page/workers.ts
  var twitchWorkers = [];
  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach((worker) => {
      worker.postMessage({ key, value });
    });
  }

  // src/page/mask.ts
  function maskAsNative(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: () => "function " + name + "() { [native code] }",
        writable: true,
        configurable: true
      });
    } catch {
    }
    return fn;
  }

  // src/page/storage.ts
  var PRESERVED_PLAYER_SETTINGS = [
    { key: "video-quality", restoreEmpty: false },
    { key: "video-muted", restoreEmpty: false },
    { key: "volume", restoreEmpty: false },
    { key: "lowLatencyModeEnabled", restoreEmpty: true },
    { key: "persistenceEnabled", restoreEmpty: true }
    // Mini Player
  ];
  function onContentLoaded() {
    if (document.getElementById("seventv-extension")) {
      console.log(
        "[AD DEBUG] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV."
      );
    }
    let wasVideoPlaying = true;
    const visibilityChange = () => {
      const video = getPlayerVideoElement();
      if (!video) return;
      if (document.hidden) {
        wasVideoPlaying = !video.paused && !video.ended;
        return;
      }
      if (!playerBufferState.hasStreamStarted) {
        playerBufferState.hasStreamStarted = true;
      }
      if (wasVideoPlaying && !video.ended && video.paused) {
        video.play()?.catch?.(() => {
        });
      }
    };
    document.addEventListener("visibilitychange", visibilityChange);
    try {
      const cachedValues = /* @__PURE__ */ new Map();
      for (const { key } of PRESERVED_PLAYER_SETTINGS) {
        cachedValues.set(key, localStorage.getItem(key));
      }
      const realSetItem = localStorage.setItem;
      const setItemHook = maskAsNative(function(key, value) {
        if (cachedValues.has(key)) {
          cachedValues.set(key, value);
        }
        realSetItem.apply(this, arguments);
      }, "setItem");
      const realGetItem = localStorage.getItem;
      const getItemHook = maskAsNative(function(key) {
        if (cachedValues.has(key)) {
          return cachedValues.get(key);
        }
        return realGetItem.apply(this, arguments);
      }, "getItem");
      const hooked = installHook(localStorage, "setItem", setItemHook, "localStorage.setItem") && installHook(localStorage, "getItem", getItemHook, "localStorage.getItem");
      if (!hooked) {
        runtime.localStorageHookFailed = true;
      }
    } catch (err) {
      console.log("localStorageHooks failed " + err);
      runtime.localStorageHookFailed = true;
    }
  }
  var flagOverrides = [
    {
      key: "preferLowQualityBackup",
      when: "false",
      field: "PreferLowQualityBackup",
      message: "PreferLowQualityBackup disabled via localStorage — sticky CSAI path only, no autoplay fallback or escape hatch"
    },
    {
      key: "fastAutoplayFirstTry",
      when: "false",
      field: "FastAutoplayFirstTry",
      message: "FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)"
    },
    {
      key: "backupSwapFirst",
      when: "false",
      field: "BackupSwapFirst",
      message: "BackupSwapFirst disabled via localStorage — using sticky CSAI path (strip on native stream)"
    },
    {
      key: "disableAdSpoofing",
      when: "false",
      field: "DisableAdSpoofing",
      message: "AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect"
    },
    {
      key: "recoverFromSilentMute",
      when: "false",
      field: "RecoverFromSilentMute",
      message: "RecoverFromSilentMute disabled via localStorage — hard-reload backstop respects already-muted state, mid-session manual mutes preserved across reloads"
    },
    {
      key: "softReloadNoStrip",
      when: "false",
      field: "SoftReloadNoStrip",
      message: "SoftReloadNoStrip disabled via localStorage — post-ad reload always hard, even on no-strip CSAI breaks (issue #129)"
    },
    {
      key: "disablePostBreakWedge",
      when: "true",
      field: "DisablePostBreakWedge",
      message: "Post-break video-wedge recovery DISABLED via localStorage — audio-alive/video-frozen after a break will not be auto-recovered"
    }
  ];
  function readSetting(key) {
    return localStorage.getItem("twitchAdSolutions_" + key);
  }
  function readBoolSetting(key) {
    const value = readSetting(key);
    return value === null ? null : value === "true";
  }
  function readNonNegativeSetting(key, parse) {
    const value = parse(readSetting(key) ?? "");
    return !Number.isNaN(value) && value >= 0 ? value : null;
  }
  function loadLocalStorageConfig() {
    try {
      state.ReloadPlayerAfterAd = readBoolSetting("reloadPlayerAfterAd") ?? state.ReloadPlayerAfterAd;
      state.DisableReloadCap = readBoolSetting("disableReloadCap") ?? state.DisableReloadCap;
      state.DriftCorrectionRate = readNonNegativeSetting("driftCorrectionRate", parseFloat) ?? state.DriftCorrectionRate;
      state.EarlyReloadPollThreshold = readNonNegativeSetting("earlyReloadPollThreshold", (v) => parseInt(v, 10)) ?? state.EarlyReloadPollThreshold;
      state.ForceAccessTokenPlayerType = readSetting("playerType") ?? state.ForceAccessTokenPlayerType;
      state.PinBackupPlayerType = readBoolSetting("pinBackupPlayerType") ?? state.PinBackupPlayerType;
      for (const { key, when, field, message } of flagOverrides) {
        if (readSetting(key) === when) {
          state[field] = when === "true";
          console.log("[AD DEBUG] " + message);
        }
      }
      if (readSetting("hideAdOverlay") === "true") {
        const style = document.createElement("style");
        style.textContent = ".tas-adblock-overlay { display: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      }
    } catch {
    }
  }

  // src/page/player.ts
  var isAppleTouchDevice = (function() {
    try {
      const p = navigator.platform || "";
      if (/^(iPhone|iPad|iPod)/.test(p)) return true;
      return p === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
    } catch {
      return false;
    }
  })();
  var iosSoftReload = isAppleTouchDevice && (function() {
    try {
      return localStorage.getItem("twitchAdSolutions_iosSoftReload") !== "false";
    } catch {
      return true;
    }
  })();
  var SCRIPT_PAUSE_RETRY_MS = 1e4;
  function liveLatency(video) {
    try {
      if (video.seekable && video.seekable.length > 0) {
        const seekableEnd = video.seekable.end(video.seekable.length - 1);
        if (Number.isFinite(seekableEnd)) {
          const latency = Math.max(0, seekableEnd - video.currentTime);
          if (latency < 3600) {
            return latency;
          }
        }
      }
    } catch {
    }
    return null;
  }
  function doTwitchPlayerTask(task, reloadKind) {
    const playerAndState = getPlayerAndState();
    if (!playerAndState) {
      console.log("Could not find react root");
      return "not-done";
    }
    const player = playerAndState.player;
    const playerState = playerAndState.state;
    if (!player) {
      console.log("Could not find player");
      return "not-done";
    }
    if (!playerState) {
      console.log("Could not find player state");
      return "not-done";
    }
    const wasPaused = player.isPaused() || player.core?.paused;
    if (wasPaused) {
      if (playerBufferState.userPauseIntent) {
        if (!playerBufferState.loggedPauseIntent) {
          playerBufferState.loggedPauseIntent = true;
          console.log("[AD DEBUG] Respecting user pause intent — skipping auto-resume");
        }
        return "not-done";
      }
      if (playerBufferState.scriptPausedAt && Date.now() - playerBufferState.scriptPausedAt < SCRIPT_PAUSE_RETRY_MS) {
        try {
          player.play()?.catch?.(() => {
          });
        } catch {
        }
      }
      return "not-done";
    }
    playerBufferState.scriptPausedAt = 0;
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.stall.frozenTicks = 0;
    if (task === "pausePlay") {
      player.pause();
      player.play()?.catch?.(() => {
      });
      playerBufferState.scriptPausedAt = Date.now();
      return "done";
    }
    if (document.pictureInPictureElement) {
      player.pause();
      player.play()?.catch?.(() => {
      });
      console.log("[AD DEBUG] Downgraded reload to pause/play to preserve PiP");
      return "not-done";
    }
    const video = player.getHTMLVideoElement?.();
    if (reloadKind !== "codec-swap" && video && video.readyState >= 3 && !video.paused && !video.ended) {
      const latencySec = liveLatency(video);
      if (latencySec === null) {
        console.log("[AD DEBUG] Latency unknown (seekable unavailable) — proceeding with reload");
      } else if (latencySec > 7) {
        console.log(
          "[AD DEBUG] Player playing but " + latencySec.toFixed(1) + "s behind live — proceeding with reload to reset latency"
        );
      } else {
        console.log(
          "[AD DEBUG] Skipping reload — player healthy (readyState=" + video.readyState + ", playing, latency=" + latencySec.toFixed(1) + "s)"
        );
        return "skipped-healthy";
      }
    }
    const savedSettings = /* @__PURE__ */ new Map();
    try {
      for (const { key } of PRESERVED_PLAYER_SETTINGS) {
        savedSettings.set(key, localStorage.getItem(key));
      }
      if (runtime.localStorageHookFailed && player?.core?.state) {
        localStorage.setItem("video-muted", JSON.stringify({ default: player.core.state.muted }));
        localStorage.setItem("volume", String(player.core.state.volume));
      }
      if (player?.core?.state?.quality?.group) {
        localStorage.setItem("video-quality", JSON.stringify({ default: player.core.state.quality.group }));
      }
    } catch {
    }
    playerBufferState.lastReloadAt = Date.now();
    playerBufferState.adStall = { phase: "idle" };
    playerBufferState.userPauseIntent = false;
    playerBufferState.loggedPauseIntent = false;
    const hardReload = reloadKind === "early" && !iosSoftReload;
    const refreshToken = reloadKind === "early";
    if (reloadKind === "early" && iosSoftReload) {
      console.log(
        "[AD DEBUG] iOS/iPadOS: downgrading hard reload to soft — keeps media element user-gesture-blessed (avoids black-screen + play-icon stall); access-token refresh is retained, so Source quality can still be restored. Opt-out: twitchAdSolutions_iosSoftReload=false"
      );
    }
    console.log("[AD DEBUG] Reloading Twitch player" + (hardReload ? " (hard)" : " (soft)"));
    if (hardReload) {
      try {
        armMuteRestore();
      } catch {
      }
    }
    if (hardReload || refreshToken) {
      playerBufferState.scriptPausedAt = Date.now();
    }
    playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: refreshToken });
    postTwitchWorkerMessage("TriggeredPlayerReload");
    player.play()?.catch?.(() => {
    });
    setTimeout(() => {
      try {
        for (const { key, restoreEmpty } of PRESERVED_PLAYER_SETTINGS) {
          const value = savedSettings.get(key);
          if (value != null && (value !== "" || restoreEmpty)) {
            localStorage.setItem(key, value);
          }
        }
        const video2 = getPlayerVideoElement();
        const savedMuted = savedSettings.get("video-muted");
        const userIntendedMute = savedMuted && savedMuted.includes('"default":true');
        if (video2 && video2.muted && !userIntendedMute) {
          video2.muted = false;
        }
        if (video2 && video2.buffered.length > 0 && video2.readyState >= 3) {
          const liveEdge = video2.buffered.end(video2.buffered.length - 1);
          const drift = liveEdge - video2.currentTime;
          if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
            console.log(
              "[AD DEBUG] Post-hard-reload seek to live — " + drift.toFixed(1) + "s behind, jumping to live edge to flush A/V drift"
            );
            video2.currentTime = liveEdge;
          } else if (drift > 2) {
            console.log("[AD DEBUG] Post-reload live drift correction: " + drift.toFixed(1) + "s behind");
            startDriftCorrection(video2);
          }
        }
      } catch {
      }
    }, 3e3);
    return "done";
  }
  var muteRestore = null;
  function armMuteRestore() {
    const prev = muteRestore;
    prev?.cancel();
    muteRestore = null;
    const v = getPlayerVideoElement();
    if (!v) return;
    const premuted = prev && prev.phase === "awaiting-media" ? prev.premuted.slice() : [];
    const wasInitiallyUnmuted = !v.muted || premuted.includes(v);
    const shouldRecover = playerBufferState.vaftEverUnmuted && state.RecoverFromSilentMute;
    if (!wasInitiallyUnmuted && !shouldRecover) return;
    if (!v.muted) {
      v.muted = true;
      premuted.push(v);
    }
    const clearLeakedPremutes = (cur, where) => {
      for (const el of premuted) {
        if (el !== cur && el.isConnected && el.muted) {
          el.muted = false;
          console.log(
            "[AD DEBUG] " + where + " — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248"
          );
        }
      }
    };
    const listener = (e) => {
      if (e.target && e.target.tagName === "VIDEO") restore();
    };
    const removeListeners = () => {
      document.removeEventListener("canplay", listener, true);
      document.removeEventListener("playing", listener, true);
      document.removeEventListener("loadeddata", listener, true);
    };
    const restore = () => {
      if (instance.phase !== "awaiting-media") return;
      instance.phase = "backstop";
      removeListeners();
      clearTimeout(restoreTimer);
      try {
        const cur = getPlayerVideoElement();
        if (cur) {
          cur.muted = false;
          playerBufferState.vaftEverUnmuted = true;
        }
        clearLeakedPremutes(cur, "Restore");
      } catch {
      }
    };
    const backstop = () => {
      restore();
      if (muteRestore === instance) muteRestore = null;
      try {
        const cur = getPlayerVideoElement();
        if (cur && cur.muted) {
          if (playerBufferState.userPauseIntent) {
            console.log(
              "[AD DEBUG] Hard reload backstop SKIPPED — element muted at 5500ms but userPauseIntent set (likely false-positive pause event during MSE teardown — issue #200 follow-up)"
            );
          } else {
            cur.muted = false;
            playerBufferState.vaftEverUnmuted = true;
            console.log(
              "[AD DEBUG] Hard reload backstop unmute fired — element was still muted at 5500ms (initial: " + (wasInitiallyUnmuted ? "unmuted, we pre-muted" : "already-muted on entry — recovering from silent Twitch re-mute") + ")"
            );
          }
        }
        if (wasInitiallyUnmuted && !playerBufferState.userPauseIntent) {
          clearLeakedPremutes(cur, "Backstop");
        }
      } catch {
      }
    };
    document.addEventListener("canplay", listener, true);
    document.addEventListener("playing", listener, true);
    document.addEventListener("loadeddata", listener, true);
    const restoreTimer = setTimeout(restore, 4e3);
    const backstopTimer = setTimeout(backstop, 5500);
    const instance = {
      phase: "awaiting-media",
      premuted,
      cancel() {
        removeListeners();
        clearTimeout(restoreTimer);
        clearTimeout(backstopTimer);
      }
    };
    muteRestore = instance;
  }

  // src/page/overlay.ts
  var cachedPlayerRootDiv = null;
  var loggedSdaHide = false;
  function hideTwitchAdOverlays() {
    if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
    const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
    for (let i = 0; i < sdaElements.length; i++) {
      const style = sdaElements[i].style;
      if (style.getPropertyValue("display") !== "none" || style.getPropertyPriority("display") !== "important") {
        style.setProperty("display", "none", "important");
        if (!loggedSdaHide) {
          loggedSdaHide = true;
          console.log("[AD DEBUG] Hidden Twitch stream display ad");
        }
      }
    }
    const primaryVideo = runtime.playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
    const allVideos = document.getElementsByTagName("video");
    for (let i = 0; i < allVideos.length; i++) {
      const vid = allVideos[i];
      let adHost = "";
      try {
        const vidSrc = vid.currentSrc || vid.getAttribute("src") || "";
        if (vidSrc && !vidSrc.startsWith("blob:")) {
          const host = new URL(vidSrc, document.location.href).hostname.toLowerCase();
          if (host === "media-amazon.com" || host.endsWith(".media-amazon.com")) {
            adHost = host;
          }
        }
      } catch {
      }
      if (adHost && vid !== primaryVideo) {
        vid.style.setProperty("display", "none", "important");
        try {
          vid.muted = true;
          if (!vid.paused) vid.pause();
        } catch {
        }
        if (!vid.dataset.tasAdHidden) {
          vid.dataset.tasAdHidden = "1";
          console.log("[AD DEBUG] Hidden separate Twitch video ad (" + adHost + ") — issue #249");
        }
      } else if (vid.dataset.tasAdHidden && !adHost) {
        delete vid.dataset.tasAdHidden;
        vid.style.removeProperty("display");
        try {
          vid.muted = false;
        } catch {
        }
        console.log("[AD DEBUG] Restored recycled <video> — source is no longer an ad (#249)");
      }
    }
  }
  function updateAdblockBanner(data) {
    if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) {
      cachedPlayerRootDiv = document.querySelector(".video-player");
    }
    const playerRootDiv = cachedPlayerRootDiv;
    if (playerRootDiv != null) {
      let adBlockDiv = playerRootDiv.querySelector(".tas-adblock-overlay");
      if (adBlockDiv == null) {
        adBlockDiv = document.createElement("div");
        adBlockDiv.className = "tas-adblock-overlay";
        adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
        adBlockDiv.style.display = "none";
        adBlockDiv.P = adBlockDiv.querySelector("p");
        playerRootDiv.appendChild(adBlockDiv);
      }
      if (adBlockDiv.P) {
        const text = "Blocking" + (data.isMidroll ? " midroll" : "") + " ads" + (data.isStrippingAdSegments ? " (stripping)" : "") + (data.activeBackupPlayerType ? " (" + data.activeBackupPlayerType + ")" : "");
        if (adBlockDiv.P.textContent !== text) {
          adBlockDiv.P.textContent = text;
        }
      }
      const display = data.hasAds && playerBufferState.isLive ? "block" : "none";
      if (adBlockDiv.style.display !== display) {
        adBlockDiv.style.display = display;
      }
      if (data.hasAds) {
        hideTwitchAdOverlays();
      }
    }
  }

  // src/page/wedge.ts
  var WATCH_EVALS = 40;
  var MIN_ADVANCE_S = 0.3;
  var HEALTHY_FRAMES = 5;
  var WEDGED_MAX_FRAMES = 1;
  var HEALTHY_TO_DISARM = 3;
  var EVIDENCE_TO_ACT = 6;
  function armWedgeWatch() {
    return { phase: "watching", evalsLeft: WATCH_EVALS, last: null, evidence: 0, healthy: 0, actions: 0 };
  }
  function wedgeSample(watch, time, frames) {
    if (watch.phase !== "watching") return { next: watch, step: { action: "none" } };
    const prev = watch.last;
    const w = { ...watch, last: { time, frames } };
    if (!prev || time <= prev.time + MIN_ADVANCE_S) {
      return { next: w, step: { action: "none" } };
    }
    w.evalsLeft--;
    const framesDelta = frames - prev.frames;
    let step = { action: "none" };
    if (framesDelta < 0) {
      w.evidence = 0;
      w.healthy = 0;
    } else if (framesDelta >= HEALTHY_FRAMES) {
      w.evidence = 0;
      w.healthy++;
      if (w.healthy >= HEALTHY_TO_DISARM) return { next: { phase: "disarmed" }, step };
    } else if (framesDelta <= WEDGED_MAX_FRAMES) {
      w.healthy = 0;
      w.evidence++;
      if (w.evidence >= EVIDENCE_TO_ACT) {
        w.evidence = 0;
        w.actions++;
        const action = w.actions >= 2 ? "reload" : "nudge";
        step = { action, time, elapsed: time - prev.time, framesDelta };
        if (action === "reload") return { next: { phase: "disarmed" }, step };
      }
    } else {
      w.healthy = 0;
    }
    return { next: w.evalsLeft > 0 ? w : { phase: "disarmed" }, step };
  }

  // src/page/buffer-monitor.ts
  var RELOAD_GRACE_MS = 15e3;
  var BACKUP_SWITCH_GRACE_MS = 1e4;
  var SCRIPT_PAUSE_ECHO_MS = 2e3;
  var AD_STALL_RELOAD_AFTER_MS = 3e3;
  var AD_STALL_COOLDOWN_MS = 15e3;
  function within(at, ms) {
    return !!at && Date.now() - at < ms;
  }
  var pendingTick = false;
  function startBufferMonitor() {
    monitorPlayerBuffering();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !pendingTick) {
        pendingTick = true;
        setTimeout(() => {
          pendingTick = false;
          monitorPlayerBuffering();
        }, 100);
      }
    });
  }
  function monitorPlayerBuffering() {
    runtime.playerForMonitoringBuffering = null;
    {
      const playerAndState = getPlayerAndState();
      if (playerAndState && playerAndState.player && playerAndState.state) {
        runtime.playerForMonitoringBuffering = {
          player: playerAndState.player,
          state: playerAndState.state
        };
        const video = playerAndState.player.getHTMLVideoElement?.();
        if (video && !video.__tasIntentHooked) {
          video.__tasIntentHooked = true;
          video.addEventListener("pause", () => {
            if (!within(playerBufferState.scriptPausedAt, SCRIPT_PAUSE_ECHO_MS)) {
              playerBufferState.userPauseIntent = true;
            }
          });
          video.addEventListener("play", () => {
            playerBufferState.userPauseIntent = false;
            playerBufferState.loggedPauseIntent = false;
          });
        }
      }
    }
    if (runtime.playerForMonitoringBuffering) {
      try {
        const { player, state: twitchState } = runtime.playerForMonitoringBuffering;
        if (!player.core) {
          runtime.playerForMonitoringBuffering = null;
        } else {
          checkStall(player, twitchState);
        }
      } catch (err) {
        console.error("error when monitoring player for buffering: " + err);
        runtime.playerForMonitoringBuffering = null;
      }
    }
    checkPostBreakWedge();
    checkAdStall();
    const isLive = runtime.playerForMonitoringBuffering?.state?.props?.content?.type === "live";
    if (playerBufferState.isLive && !isLive) {
      runtime.isActivelyStrippingAds = false;
      updateAdblockBanner({
        hasAds: false
      });
    }
    playerBufferState.isLive = isLive;
    try {
      hideTwitchAdOverlays();
    } catch {
    }
    const shouldThrottle = typeof document !== "undefined" && document.hidden && !document.pictureInPictureElement && !playerBufferState.inAdBreak;
    const nextDelay = shouldThrottle ? state.PlayerBufferingDelay * 3 : state.PlayerBufferingDelay;
    setTimeout(monitorPlayerBuffering, nextDelay);
  }
  function onChannelChange(channelName) {
    playerBufferState.channelName = channelName;
    playerBufferState.hasStreamStarted = false;
    resetStallLadder(playerBufferState.stall);
    playerBufferState.userPauseIntent = false;
    playerBufferState.loggedPauseIntent = false;
    playerBufferState.hasHadData = false;
    playerBufferState.adStall = { phase: "idle" };
  }
  function checkStall(player, twitchState) {
    if (twitchState.props?.content?.type !== "live" || player.isPaused()) {
      return;
    }
    const video = player.getHTMLVideoElement();
    if (!video || video.ended || (video.readyState ?? 0) < 1 || playerBufferState.lastFixTime > Date.now() - state.PlayerBufferingMinRepeatDelay || runtime.isActivelyStrippingAds || playerBufferState.inAdBreak || within(playerBufferState.lastReloadAt, RELOAD_GRACE_MS) || within(playerBufferState.lastBackupSwitchAt, BACKUP_SWITCH_GRACE_MS)) {
      return;
    }
    const m3u8Url = player.core?.state?.path;
    if (m3u8Url) {
      const lastSlash = m3u8Url.lastIndexOf("/");
      const queryStart = m3u8Url.indexOf("?", lastSlash);
      const fileName = m3u8Url.substring(lastSlash + 1, queryStart !== -1 ? queryStart : void 0);
      if (fileName?.endsWith(".m3u8")) {
        const channelName = fileName.slice(0, -5);
        if (playerBufferState.channelName !== channelName) {
          onChannelChange(channelName);
        }
      }
    }
    if (player.getState() === "Playing") {
      playerBufferState.hasStreamStarted = true;
    }
    const position = player.core?.state?.position;
    const bufferedPosition = player.core?.state?.bufferedPosition;
    const bufferDuration = player.getBufferDuration();
    const videoCurrentTime = video.currentTime;
    if (position === void 0 || bufferedPosition === void 0) {
      playerBufferState.stall.frozenTicks = 0;
      return;
    }
    if (playerBufferState.videoElement && playerBufferState.videoElement !== video) {
      resetStallLadder(playerBufferState.stall);
    }
    playerBufferState.videoElement = video;
    const step = stallTick(
      playerBufferState.stall,
      observeStall(video, position, bufferedPosition, bufferDuration, videoCurrentTime),
      state.PlayerBufferingSameStateCount,
      !state.DisableReloadCap
    );
    if (step.action !== "none") {
      const note = step.capped ? " (reload cap reached, pause/play only — set twitchAdSolutions_disableReloadCap=true to bypass)" : step.action === "reload" ? " (escalating to reload)" : "";
      console.log(
        "Attempt to fix buffering position:" + playerBufferState.position + " bufferedPosition:" + playerBufferState.bufferedPosition + " bufferDuration:" + playerBufferState.bufferDuration + note
      );
      if (video.buffered.length > 1) {
        for (let bi = 0; bi < video.buffered.length; bi++) {
          if (video.buffered.start(bi) > video.currentTime + 0.5) {
            console.log(
              "[AD DEBUG] Seeking past " + (video.buffered.start(bi) - video.currentTime).toFixed(1) + "s buffer gap"
            );
            video.currentTime = video.buffered.start(bi);
            startDriftCorrection(video);
            break;
          }
        }
      }
      console.log(
        "[AD DEBUG] Video state: readyState=" + video.readyState + " networkState=" + video.networkState + " buffered=" + (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0) + " currentTime=" + video.currentTime.toFixed(1) + " paused=" + video.paused
      );
      doTwitchPlayerTask(step.action === "reload" ? "reload" : "pausePlay");
      playerBufferState.lastFixTime = Date.now();
    }
    if (playerBufferState.position > 0 && position - playerBufferState.position > 5 && !playerBufferState.inAdBreak && !within(playerBufferState.lastBackupSwitchAt, BACKUP_SWITCH_GRACE_MS) && (!playerBufferState.lastDriftStartedAt || Date.now() - playerBufferState.lastDriftStartedAt >= 3e4)) {
      console.log(
        "[AD DEBUG] Position jumped " + (position - playerBufferState.position).toFixed(1) + "s — starting drift correction"
      );
      const jumpVideo = player.getHTMLVideoElement?.();
      if (jumpVideo) startDriftCorrection(jumpVideo);
      playerBufferState.lastDriftStartedAt = Date.now();
    }
    playerBufferState.position = position;
    playerBufferState.videoCurrentTime = videoCurrentTime;
    playerBufferState.bufferedPosition = bufferedPosition;
    playerBufferState.bufferDuration = bufferDuration;
  }
  function observeStall(video, position, bufferedPosition, bufferDuration, videoCurrentTime) {
    if (video.readyState < 2 || video.paused) {
      return "hold";
    }
    const positionFrozen = playerBufferState.position === position && (playerBufferState.videoCurrentTime === void 0 || playerBufferState.videoCurrentTime === videoCurrentTime);
    const stalled = playerBufferState.hasStreamStarted && // AND, not OR: on Firefox at the live edge the buffer breathes at ~1-2s while currentTime
    // waits on a segment, and a pause/play there knocks the player back to readyState 1,
    // currentTime 0.
    positionFrozen && bufferDuration < state.PlayerBufferingDangerZone && playerBufferState.bufferedPosition === bufferedPosition && playerBufferState.bufferDuration >= bufferDuration && (position !== 0 || bufferedPosition !== 0 || bufferDuration !== 0);
    return stalled ? "frozen" : "healthy";
  }
  function checkPostBreakWedge() {
    const inAd = playerBufferState.inAdBreak;
    if (playerBufferState.wedgeWasInAdBreak && !inAd) {
      playerBufferState.wedge = armWedgeWatch();
    }
    playerBufferState.wedgeWasInAdBreak = inAd;
    const monitored = runtime.playerForMonitoringBuffering;
    if (state.DisablePostBreakWedge || inAd || playerBufferState.wedge.phase !== "watching" || playerBufferState.userPauseIntent || !monitored || monitored.state?.props?.content?.type !== "live") {
      return;
    }
    try {
      const wv = monitored.player?.getHTMLVideoElement?.();
      if (!wv || wv.ended || wv.paused || !(wv.videoWidth > 0) || (wv.readyState ?? 0) < 2 || typeof wv.getVideoPlaybackQuality !== "function") {
        return;
      }
      let totalFrames = -1;
      try {
        totalFrames = Number(wv.getVideoPlaybackQuality()?.totalVideoFrames);
      } catch {
      }
      if (!Number.isFinite(totalFrames) || totalFrames < 0) {
        return;
      }
      const { next, step } = wedgeSample(playerBufferState.wedge, wv.currentTime || 0, totalFrames);
      playerBufferState.wedge = next;
      if (step.action === "none") {
        return;
      }
      console.log(
        "[AD DEBUG] Post-break video wedge — playhead advancing at " + step.time.toFixed(1) + "s but only " + Math.max(0, step.framesDelta) + " decoded frame(s) over " + step.elapsed.toFixed(1) + "s (audio-alive/video-frozen after break) — " + (step.action === "reload" ? "hard reload" : "pause/play nudge") + " (mirrors TTV-AB v12.0.0)"
      );
      if (step.action === "nudge") {
        doTwitchPlayerTask("pausePlay");
      } else if (within(playerBufferState.lastReloadAt, RELOAD_GRACE_MS)) {
        console.log("[AD DEBUG] Post-break wedge reload SUPPRESSED — a reload fired <15s ago; relying on it");
      } else {
        doTwitchPlayerTask("reload", "early");
      }
      playerBufferState.lastFixTime = Date.now();
    } catch {
    }
  }
  function checkAdStall() {
    if (!runtime.isActivelyStrippingAds) {
      playerBufferState.adStall = { phase: "idle" };
      return;
    }
    if (!runtime.playerForMonitoringBuffering) {
      return;
    }
    try {
      const video = runtime.playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
      if (!video || video.ended || playerBufferState.userPauseIntent) {
        return;
      }
      if (video.readyState >= 3) {
        playerBufferState.hasHadData = true;
      }
      const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
      if (!isStalled) {
        playerBufferState.adStall = { phase: "idle" };
        return;
      }
      if (within(playerBufferState.lastAdStallReloadAt, AD_STALL_COOLDOWN_MS) || within(playerBufferState.lastReloadAt, AD_STALL_COOLDOWN_MS) || !playerBufferState.hasHadData) {
        return;
      }
      const stall = playerBufferState.adStall;
      if (stall.phase === "idle") {
        playerBufferState.adStall = { phase: "stalling", since: Date.now() };
      } else if (Date.now() - stall.since > AD_STALL_RELOAD_AFTER_MS) {
        console.log(
          "[AD DEBUG] Loading circle detected during ad break (" + ((Date.now() - stall.since) / 1e3).toFixed(1) + "s stall, readyState=" + video.readyState + ") — early reload"
        );
        playerBufferState.lastAdStallReloadAt = Date.now();
        playerBufferState.adStall = { phase: "idle" };
        doTwitchPlayerTask("reload", "early");
      }
    } catch {
    }
  }

  // src/page/fetch-hook.ts
  var csaiRequestCounts = /* @__PURE__ */ Object.create(null);
  function countCsaiRequest(url, transport) {
    const csaiType = url.includes("bp=midroll") ? "midroll" : url.includes("bp=preroll") ? "preroll" : "unknown";
    const inBreak = playerBufferState.inAdBreak === true;
    let c = csaiRequestCounts[csaiType];
    if (!c) {
      c = { inBreak: 0, noBreak: 0 };
      csaiRequestCounts[csaiType] = c;
    }
    const n = inBreak ? ++c.inBreak : ++c.noBreak;
    if (n !== 1 && n % 10 !== 0) {
      return;
    }
    const chan = playerBufferState.channelName ? " on " + playerBufferState.channelName : "";
    console.log(
      "[AD DEBUG] CSAI ad request (" + transport + ") — type: " + csaiType + chan + (inBreak ? " during a detected break" : " with NO break detected — vaft never saw this ad") + " | this type so far: " + c.noBreak + " unseen, " + c.inBreak + " during breaks" + (n === 1 ? " (client-side insertion, not blockable via m3u8)" : "")
    );
  }
  function firstStringHeader(headers, names) {
    for (const name of names) {
      const value = headers[name];
      if (typeof value === "string") {
        return value;
      }
    }
    return void 0;
  }
  function hookFetch() {
    let hasLoggedHeaders = false;
    const realFetch = window.fetch;
    installHook(window, "realFetch", realFetch, "window.realFetch");
    const hook = maskAsNative(function(url, init) {
      if (typeof url === "string") {
        if (url.includes("gql")) {
          const headers = init?.headers || {};
          for (const relay of GQL_HEADER_RELAYS) {
            const value = firstStringHeader(headers, relay.headers);
            if (value !== void 0 && state[relay.field] !== value) {
              state[relay.field] = value;
              postTwitchWorkerMessage(relay.key, value);
            }
          }
          if (!hasLoggedHeaders && state.GQLDeviceID && state.AuthorizationHeader) {
            hasLoggedHeaders = true;
            console.log(
              "[AD DEBUG] GQL headers captured — DeviceId: " + (state.GQLDeviceID ? "yes" : "no") + ", Auth: " + (state.AuthorizationHeader ? "yes" : "no") + ", Integrity: " + (state.ClientIntegrityHeader ? "yes" : "no")
            );
          }
          if (init && typeof init.body === "string" && init.body.includes("PlaybackAccessToken") && init.body.includes("picture-by-picture")) {
            init.body = "";
          }
          if (state.ForceAccessTokenPlayerType && init && typeof init.body === "string" && init.body.includes("PlaybackAccessToken")) {
            let replacedPlayerType = "";
            const newBody = JSON.parse(init.body);
            if (Array.isArray(newBody)) {
              for (let i = 0; i < newBody.length; i++) {
                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== state.ForceAccessTokenPlayerType) {
                  replacedPlayerType = newBody[i].variables.playerType;
                  newBody[i].variables.playerType = state.ForceAccessTokenPlayerType;
                }
              }
            } else {
              if (newBody?.variables?.playerType && newBody?.variables?.playerType !== state.ForceAccessTokenPlayerType) {
                replacedPlayerType = newBody.variables.playerType;
                newBody.variables.playerType = state.ForceAccessTokenPlayerType;
              }
            }
            if (replacedPlayerType) {
              console.log(
                `[AD DEBUG] Replaced '${replacedPlayerType}' player type with '${state.ForceAccessTokenPlayerType}' player type`
              );
              init.body = JSON.stringify(newBody);
            }
          }
        }
        if (url.includes("edge.ads.twitch.tv")) {
          countCsaiRequest(url, "fetch");
        }
      }
      return realFetch.apply(this, arguments);
    }, "fetch");
    if (installHook(window, "fetch", hook, "window fetch")) {
      console.log("[AD DEBUG] Window fetch hook installed");
    }
  }
  function hookXhr() {
    const realXHROpen = XMLHttpRequest.prototype.open;
    const hook = maskAsNative(function(_method, url) {
      if (typeof url === "string" && url.includes("edge.ads.twitch.tv")) {
        countCsaiRequest(url, "xhr");
      }
      return realXHROpen.apply(this, arguments);
    }, "open");
    installHook(XMLHttpRequest.prototype, "open", hook, "XMLHttpRequest.open");
  }

  // src/shared/wasm-worker.ts
  var cache = /* @__PURE__ */ Object.create(null);
  function getWasmWorkerJs(twitchBlobUrl) {
    if (cache[twitchBlobUrl]) {
      return cache[twitchBlobUrl];
    }
    const req = new XMLHttpRequest();
    req.open("GET", twitchBlobUrl, false);
    req.overrideMimeType("text/javascript");
    req.send();
    const text = req.responseText;
    cache[twitchBlobUrl] = text;
    return text;
  }

  // src/page/worker-bundle.ts
  function runWorker(__vaftInit) {
(() => {
  "use strict";
  // src/shared/config.ts
  function defaultSharedConfig() {
    return {
      ReloadPlayerAfterAd: true,
      EarlyReloadPollThreshold: 3,
      // Twitch's player polls the playlist about every 2s
      PinBackupPlayerType: true,
      PreferLowQualityBackup: true,
      // autoplay tokens only get a 360p variant ladder
      // Field data: every observed channel serves ads on every Source-tier backup type.
      FastAutoplayFirstTry: true,
      // Users report fewer loading circles than with stripping in place (no MediaSource mixing).
      BackupSwapFirst: true,
      // Off: Twitch may fingerprint the always-complete beacon pattern while still answering 200
      // (TTV-AB maintainer hypothesis).
      DisableAdSpoofing: true,
      // Issue #129 mode D. A hard reload shows a black screen and play icon on desktop; its
      // MediaSource flush is only needed after strip injection.
      SoftReloadNoStrip: true,
      ForceAccessTokenPlayerType: "popout",
      GQLDeviceID: null,
      AuthorizationHeader: void 0,
      ClientIntegrityHeader: null,
      ClientVersion: null,
      ClientSession: null
    };
  }
  var GQL_HEADER_RELAYS = [
    { headers: ["X-Device-Id", "Device-ID"], field: "GQLDeviceID", key: "UpdateDeviceId" },
    { headers: ["Client-Version"], field: "ClientVersion", key: "UpdateClientVersion" },
    { headers: ["Client-Session-Id"], field: "ClientSession", key: "UpdateClientSession" },
    { headers: ["Client-Integrity"], field: "ClientIntegrityHeader", key: "UpdateClientIntegrityHeader" },
    { headers: ["Authorization"], field: "AuthorizationHeader", key: "UpdateAuthorizationHeader" }
  ];

  // src/shared/wasm-worker.ts
  var cache = /* @__PURE__ */ Object.create(null);
  function getWasmWorkerJs(twitchBlobUrl) {
    if (cache[twitchBlobUrl]) {
      return cache[twitchBlobUrl];
    }
    const req = new XMLHttpRequest();
    req.open("GET", twitchBlobUrl, false);
    req.overrideMimeType("text/javascript");
    req.send();
    const text = req.responseText;
    cache[twitchBlobUrl] = text;
    return text;
  }

  // src/shared/hook.ts
  function installHook(target, key, fn, label) {
    try {
      target[key] = fn;
    } catch {
    }
    if (target[key] !== fn) {
      try {
        const desc = Object.getOwnPropertyDescriptor(target, key);
        if (desc?.configurable) {
          Object.defineProperty(target, key, {
            value: fn,
            writable: true,
            configurable: true,
            enumerable: desc.enumerable
          });
        }
      } catch {
      }
    }
    let hooked2 = false;
    try {
      hooked2 = target[key] === fn;
    } catch {
    }
    if (!hooked2) {
      console.log(
        "[AD DEBUG] Could not hook " + label + ": the browser or another extension does not let it be replaced"
      );
    }
    return hooked2;
  }

  // src/worker/state.ts
  function createWorkerState() {
    return {
      ...defaultSharedConfig(),
      // Twitch's twitch-stitched-* DATERANGE classes; a bare 'stitched' gave false positives (PR #120).
      AdSignifiers: [
        "stitched-ad",
        "EXT-X-CUE-OUT",
        "twitch-stitched",
        'EXT-X-DATERANGE:CLASS="twitch-maf-ad"',
        'EXT-X-DATERANGE:CLASS="twitch-trigger"'
      ],
      // Twitch DATERANGE classes seen on non-ad playlists; the unknown-marker log skips them.
      KnownNonAdSignifiers: ["twitch-session", "twitch-stream-source", "twitch-ad-quartile", "twitch-assignment"],
      AdSegmentURLPatterns: ["/adsquared/", "/_404/", "/processing"],
      TwitchAdUrlRewriteRegex: /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g,
      UriAttributeRegex: /URI="([^"]+)"/,
      ClientID: "kimne78kx3ncx6brgo4mv6wki5h1ko",
      BackupPlayerTypes: [
        // First clean type wins. Twitch's GQL answers 'server error' to embed tokens requested
        // from twitch.tv, so embed goes last.
        "site",
        //Source
        "popout",
        //Source
        "mobile_web",
        //Mobile
        "embed"
        //Source
        // Not 'autoplay': committed as a backup, the player loops a loading circle once the
        // backup is released, since autoplay variants don't transition back to the main stream's.
      ],
      FallbackPlayerType: "site",
      // more reliable than embed when every Source type is ad-laden
      PlayerReloadMinimalRequestsTime: 1500,
      StreamInfos: /* @__PURE__ */ Object.create(null),
      StreamInfosByUrl: /* @__PURE__ */ Object.create(null),
      SimulatedAdsDepth: 0,
      V2API: false,
      AdSegmentCache: /* @__PURE__ */ new Map(),
      AllSegmentsAreAdSegments: false,
      StreamInfoMaxAgeMs: 30 * 60 * 1e3
    };
  }
  var state = createWorkerState();

  // src/worker/ads.ts
  function hasAdTags(textStr) {
    return state.AdSignifiers.some((s) => s && textStr.includes(s));
  }
  function getMatchedAdSignifiers(textStr) {
    return state.AdSignifiers.filter((s) => textStr.includes(s));
  }
  function matchesAdUrlPattern(url) {
    return state.AdSegmentURLPatterns.some((p) => url.includes(p));
  }
  function isKnownAdUrl(url) {
    return !!url && (state.AdSegmentCache.has(url) || matchesAdUrlPattern(url));
  }
  function isLowLatencyHint(line) {
    return line.startsWith("#EXT-X-TWITCH-PREFETCH:") || line.startsWith("#EXT-X-PRELOAD-HINT:");
  }
  function stripAdSegments(textStr, stripAllSegments, streamInfo, brk) {
    let hasStrippedAdSegments = false;
    let inCueOut = false;
    const liveSegments = [];
    const lines = textStr.split(/\r?\n/);
    const newAdUrl = "https://twitch.tv";
    if (!brk.LoggedAdAttributes) {
      const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
      if (adAttrs && adAttrs.length > 0) {
        brk.LoggedAdAttributes = true;
        console.log("[AD DEBUG] Ad tracking attributes seen: " + [...new Set(adAttrs)].join(", "));
      }
    }
    if (!brk.LoggedUnknownSignifiers) {
      const candidates = /* @__PURE__ */ new Set();
      for (const sm of textStr.matchAll(/EXT-X-DATERANGE:[^\n]*CLASS="(twitch-[^"]+)"/g)) {
        candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
      }
      for (const sm of textStr.matchAll(/(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g)) {
        candidates.add(sm[1]);
      }
      const unknown = [...candidates].filter(
        (c) => !state.AdSignifiers.some((s) => s && c.includes(s)) && !state.KnownNonAdSignifiers.some((s) => s && c.includes(s))
      );
      if (unknown.length > 0) {
        brk.LoggedUnknownSignifiers = true;
        console.log(
          "[AD DEBUG] Potential ad markers seen but not in AdSignifiers: " + unknown.join(", ") + " (candidates for future inclusion)"
        );
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("EXT-X-CUE-OUT")) {
        if (!inCueOut) {
          console.log("[AD DEBUG] SCTE-35 CUE-OUT — ad boundary entered");
        }
        inCueOut = true;
      } else if (line.includes("EXT-X-CUE-IN")) {
        if (inCueOut) {
          console.log("[AD DEBUG] SCTE-35 CUE-IN — ad boundary exited");
        }
        inCueOut = false;
      }
      if (line.includes("X-TV-TWITCH-AD")) {
        lines[i] = line.replaceAll(state.TwitchAdUrlRewriteRegex, `$1${newAdUrl}$2`);
      }
      if (i < lines.length - 1 && line.startsWith("#EXTINF")) {
        const segmentUrl = lines[i + 1];
        const isLiveSegment = line.includes(",live");
        if (!isLiveSegment || stripAllSegments || state.AllSegmentsAreAdSegments || inCueOut) {
          if (!state.AdSegmentCache.has(segmentUrl)) {
            brk.StrippedSegments++;
          }
          state.AdSegmentCache.set(segmentUrl, Date.now());
          hasStrippedAdSegments = true;
        } else if (matchesAdUrlPattern(segmentUrl)) {
          console.log("[AD DEBUG] Ad segment detected via URL pattern: " + segmentUrl);
          state.AdSegmentCache.set(segmentUrl, Date.now());
          hasStrippedAdSegments = true;
          brk.StrippedSegments++;
        } else {
          liveSegments.push({ extinf: line, url: segmentUrl });
        }
      } else if (line.startsWith("#EXT-X-PART:")) {
        const partUriMatch = line.match(state.UriAttributeRegex);
        const partUri = partUriMatch ? partUriMatch[1] : "";
        if (isKnownAdUrl(partUri)) {
          state.AdSegmentCache.set(partUri, Date.now());
          lines[i] = "";
          hasStrippedAdSegments = true;
        }
      } else if (isLowLatencyHint(line)) {
        let hintUrl = "";
        if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) {
          hintUrl = line.substring("#EXT-X-TWITCH-PREFETCH:".length).trim();
        } else {
          const hintMatch = line.match(state.UriAttributeRegex);
          hintUrl = hintMatch ? hintMatch[1] : "";
        }
        if (isKnownAdUrl(hintUrl)) {
          state.AdSegmentCache.set(hintUrl, Date.now());
          hasStrippedAdSegments = true;
        }
      }
    }
    if (!hasStrippedAdSegments && hasAdTags(textStr)) {
      hasStrippedAdSegments = true;
    }
    if (hasStrippedAdSegments) {
      for (let i = 0; i < lines.length; i++) {
        if (isLowLatencyHint(lines[i])) {
          lines[i] = "";
        }
      }
    }
    if (liveSegments.length > 0) {
      brk.RecoverySegments = liveSegments.slice(-6);
      const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1], 10);
      if (!Number.isNaN(seq)) {
        brk.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - brk.RecoverySegments.length);
      }
    }
    if (hasStrippedAdSegments && liveSegments.length === 0) {
      brk.ConsecutiveAllStrippedPolls++;
      brk.TotalAllStrippedPolls++;
      if (!brk.FreezeStartedAt) brk.FreezeStartedAt = Date.now();
      const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? Date.now() - streamInfo.LastCleanNativePlaylistAt : Infinity;
      const recentReloadReentry = streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < 8e3;
      if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !recentReloadReentry && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
        console.log(
          "[AD DEBUG] All segments stripped — reusing last clean native playlist (" + snapshotAge + "ms old)"
        );
        brk.IsStripping = hasStrippedAdSegments;
        return streamInfo.LastCleanNativeM3U8;
      }
      if (brk.RecoverySegments.length > 0) {
        console.log(
          "[AD DEBUG] All segments stripped — restoring " + brk.RecoverySegments.length + " recovery segments"
        );
        if (brk.RecoveryStartSeq !== void 0) {
          for (let j = 0; j < lines.length; j++) {
            if (lines[j].startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
              lines[j] = "#EXT-X-MEDIA-SEQUENCE:" + brk.RecoveryStartSeq;
              break;
            }
          }
        }
        for (let j = 0; j < brk.RecoverySegments.length; j++) {
          lines.push(brk.RecoverySegments[j].extinf);
          lines.push(brk.RecoverySegments[j].url);
        }
      }
    } else if (liveSegments.length > 0) {
      brk.ConsecutiveAllStrippedPolls = 0;
    }
    brk.IsStripping = hasStrippedAdSegments;
    const now = Date.now();
    if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 6e4) {
      streamInfo.LastAdCachePruneAt = now;
      state.AdSegmentCache.forEach((value, key, map) => {
        if (value < now - 12e4) {
          map.delete(key);
        }
      });
      if (state.AdSegmentCache.size > 1e3) {
        let evicted = 0;
        for (const url of state.AdSegmentCache.keys()) {
          state.AdSegmentCache.delete(url);
          if (++evicted >= 200) break;
        }
        if (!streamInfo.LoggedAdCacheSize1k) {
          streamInfo.LoggedAdCacheSize1k = true;
          console.log(
            "[AD DEBUG] AdSegmentCache exceeded 1000 entries — evicted oldest " + evicted + " (now " + state.AdSegmentCache.size + ")"
          );
        }
      }
    }
    return lines.join("\n");
  }

  // src/worker/ad-break.ts
  var AD_END_CLEAN_POLLS = 3;
  var AD_END_MAX_WAIT_MS = 12e3;
  function createAdBreak(textStr) {
    const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
    return {
      StartedAt: Date.now(),
      IsMidroll: false,
      PodLength: podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1,
      // Twitch sets these only on real ads, unlike some AdSignifiers matches.
      HasConfirmedAdAttrs: textStr.includes("X-TV-TWITCH-AD-AD-SESSION-ID") || textStr.includes("X-TV-TWITCH-AD-RADS-TOKEN"),
      End: null,
      Path: "probing",
      IsStripping: false,
      StrippedSegments: 0,
      RecoverySegments: [],
      RecoveryStartSeq: void 0,
      FreezeStartedAt: 0,
      ConsecutiveAllStrippedPolls: 0,
      TotalAllStrippedPolls: 0,
      ActiveBackupPlayerType: null,
      LastCommittedBackupPlayerType: null,
      FailedBackupPlayerTypes: /* @__PURE__ */ new Map(),
      ContaminatedTypes: /* @__PURE__ */ new Set(),
      CycleRescued: false,
      AutoplayFirst: null,
      EarlyReload: { phase: "armed" },
      EarlyReloadCount: 0,
      EarlyReloadAtPoll: 0,
      CodecSwapTried: false,
      RequestedAds: /* @__PURE__ */ new Set(),
      SpoofedAdIds: /* @__PURE__ */ new Set(),
      LoggedAdAttributes: false,
      LoggedUnknownSignifiers: false,
      LoggedContamReorder: false,
      LoggedAutoplayOrder: false
    };
  }
  function onAdPoll(brk) {
    if (brk.End && Date.now() - brk.End.since < AD_END_MAX_WAIT_MS) {
      brk.End.bounces++;
      brk.End.cleanPolls = 0;
    } else {
      brk.End = null;
    }
  }
  function onAdFreePoll(brk, hasLiveSegments) {
    if (!brk.End) {
      brk.End = { since: Date.now(), cleanPolls: 0, bounces: 0 };
    }
    brk.End.cleanPolls++;
    if (brk.End.cleanPolls >= AD_END_CLEAN_POLLS) return "clean-polls";
    if (!hasLiveSegments) return "no-live-segments";
    if (Date.now() - brk.End.since >= AD_END_MAX_WAIT_MS) return "max-wait";
    return null;
  }
  function decideBreakEndAction(streamInfo, brk, settings) {
    const codecSwapped = streamInfo.CodecSwap !== "native";
    if (brk.StrippedSegments === 0) {
      const committed = brk.LastCommittedBackupPlayerType;
      if (committed === "autoplay") {
        return { action: "reload", kind: "early", reason: "autoplay (360p) — restoring Source quality" };
      }
      if (committed || codecSwapped) {
        const what = committed || "codec swap";
        return settings.SoftReloadNoStrip ? {
          action: "reload",
          kind: "post-ad",
          reason: what + " — soft, nothing was stripped (SoftReloadNoStrip)"
        } : {
          action: "reload",
          kind: "early",
          reason: what + " — flushing MediaSource to prevent A/V desync accumulation"
        };
      }
      return { action: "none" };
    }
    if (codecSwapped) {
      return { action: "reload", kind: "early", reason: "leaving the codec swap" };
    }
    if (settings.ReloadPlayerAfterAd && !cycleRescuedCleanly(brk)) {
      return { action: "reload", kind: "early", reason: "segments were stripped — flushing MediaSource" };
    }
    return { action: "pause-play" };
  }
  function cycleRescuedCleanly(brk) {
    return brk.CycleRescued && brk.TotalAllStrippedPolls <= 2 && brk.EarlyReloadCount === 0;
  }

  // src/worker/post.ts
  function postToPage(message) {
    postMessage(message);
  }

  // src/worker/reload.ts
  var nextRequestId = 1;
  var pendingReloads = /* @__PURE__ */ new Map();
  function requestReload(kind, onOutcome2) {
    if (!onOutcome2) {
      postToPage({ key: "ReloadPlayer", kind });
      return 0;
    }
    const requestId = nextRequestId++;
    pendingReloads.set(requestId, onOutcome2);
    postToPage({ key: "ReloadPlayer", kind, requestId });
    return requestId;
  }
  function settleReload(requestId, outcome) {
    const onOutcome2 = pendingReloads.get(requestId);
    if (!onOutcome2) return;
    pendingReloads.delete(requestId);
    onOutcome2(outcome);
  }

  // src/worker/early-reload.ts
  var REQUEST_TIMEOUT_MS = 1e4;
  function stepEarlyReload(brk, pathLabel, canFire = true) {
    const er = brk.EarlyReload;
    if (er.phase === "reloaded") {
      if (!brk.IsStripping) {
        console.log("[AD DEBUG] Early reload result" + pathLabel + ": clean — freeze ended");
      } else if (brk.ConsecutiveAllStrippedPolls === 0) {
        console.log("[AD DEBUG] Early reload result" + pathLabel + ": partial — some live segments returned");
      } else {
        console.log("[AD DEBUG] Early reload result" + pathLabel + ": still ads — continuing recovery loop");
      }
      brk.EarlyReload = { phase: "armed" };
    } else if (er.phase === "requested" && Date.now() - er.at > REQUEST_TIMEOUT_MS) {
      console.log("[AD DEBUG] Early reload request unanswered — re-arming");
      brk.EarlyReload = { phase: "armed" };
    }
    if (canFire) {
      maybeFire(brk, pathLabel);
    }
  }
  function maybeFire(brk, pathLabel) {
    const recoverySize = brk.RecoverySegments.length;
    const recoveryThin = recoverySize < 3;
    const maxEarlyReloads = Math.max(recoveryThin ? 2 : 1, brk.PodLength);
    const effectiveThreshold = recoveryThin ? 1 : state.EarlyReloadPollThreshold;
    if (brk.EarlyReload.phase !== "armed" || state.EarlyReloadPollThreshold <= 0 || brk.ConsecutiveAllStrippedPolls < effectiveThreshold || brk.EarlyReloadCount >= maxEarlyReloads) {
      return;
    }
    brk.EarlyReloadCount++;
    brk.EarlyReloadAtPoll = brk.TotalAllStrippedPolls || brk.ConsecutiveAllStrippedPolls;
    const reason = recoveryThin ? " (thin recovery cache: " + recoverySize + " segments)" : "";
    console.log(
      "[AD DEBUG] Early reload triggered" + pathLabel + " — " + brk.ConsecutiveAllStrippedPolls + " consecutive all-stripped polls" + reason + " [" + brk.EarlyReloadCount + "/" + maxEarlyReloads + "]"
    );
    const at = Date.now();
    const pending = { phase: "requested", requestId: 0, at };
    brk.EarlyReload = pending;
    pending.requestId = requestReload("early", (outcome) => onOutcome(brk, pending.requestId, outcome));
  }
  function onOutcome(brk, requestId, outcome) {
    const er = brk.EarlyReload;
    if (er.phase !== "requested" || er.requestId !== requestId) return;
    if (outcome === "reloaded") {
      brk.EarlyReload = { phase: "reloaded" };
    } else if (outcome === "skipped-healthy") {
      brk.EarlyReloadCount = Math.max(0, brk.EarlyReloadCount - 1);
      brk.EarlyReload = { phase: "armed" };
      console.log("[AD DEBUG] Early reload skipped by main thread (player healthy) — re-armed, budget refunded");
    } else {
      brk.EarlyReload = { phase: "armed" };
    }
  }

  // src/worker/playlist.ts
  function parseAttributes(str) {
    if (!str) return {};
    if (str.charCodeAt(0) === 35) {
      const idx = str.indexOf(":");
      if (idx !== -1) str = str.slice(idx + 1);
    }
    return Object.fromEntries(
      str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/).filter(Boolean).map((x) => {
        const idx = x.indexOf("=");
        const key = x.substring(0, idx);
        const value = x.substring(idx + 1);
        const num = Number(value);
        return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
      })
    );
  }
  function getServerTimeFromM3u8(encodingsM3u8) {
    if (state.V2API) {
      const matches2 = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
      return matches2 && matches2.length > 1 ? matches2[1] : null;
    }
    const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
    return matches && matches.length > 1 ? matches[1] : null;
  }
  function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
    if (state.V2API) {
      return newServerTime ? encodingsM3u8.replace(
        /(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/,
        `$1${newServerTime}$2`
      ) : encodingsM3u8;
    }
    return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
  }
  function videoCodecFamily(codecs) {
    if (!codecs) return "unknown";
    const parts = String(codecs).toLowerCase().split(",");
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i].trim();
      if (c.startsWith("avc")) return "avc";
      if (c.startsWith("hev") || c.startsWith("hvc")) return "hevc";
      if (c.startsWith("av0")) return "av1";
    }
    return "unknown";
  }
  function isEnhancedCodec(codecs) {
    const family = videoCodecFamily(codecs);
    return family === "hevc" || family === "av1";
  }
  function resolutionArea(resolution) {
    const [width, height] = resolution.split("x").map(Number);
    return width * height;
  }
  function getStreamVariantForResolution(encodingsM3u8, resolutionInfo) {
    const encodingsLines = encodingsM3u8.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < encodingsLines.length - 1; i++) {
      const nextLine = encodingsLines[i + 1]?.trim();
      if (encodingsLines[i].startsWith("#EXT-X-STREAM-INF") && nextLine && !nextLine.startsWith("#") && (nextLine.includes(".m3u8") || nextLine.includes("://"))) {
        const attributes = parseAttributes(encodingsLines[i]);
        if (attributes["RESOLUTION"]) {
          variants.push({
            url: encodingsLines[i + 1],
            resolution: attributes["RESOLUTION"],
            frameRate: attributes["FRAME-RATE"],
            codecs: attributes["CODECS"] || ""
          });
        }
      }
    }
    const family = videoCodecFamily(resolutionInfo.Codecs);
    const sameFamily = family === "unknown" ? [] : variants.filter((v) => videoCodecFamily(v.codecs) === family);
    const candidates = sameFamily.length > 0 ? sameFamily : variants;
    const targetArea = resolutionArea(resolutionInfo.Resolution);
    let closest = null;
    let closestDifference = Infinity;
    for (const v of candidates) {
      if (v.resolution === resolutionInfo.Resolution && v.frameRate === resolutionInfo.FrameRate) {
        return { url: v.url, codecs: v.codecs };
      }
      const difference = Math.abs(resolutionArea(v.resolution) - targetArea);
      if (difference < closestDifference) {
        closest = v;
        closestDifference = difference;
      }
    }
    return closest ? { url: closest.url, codecs: closest.codecs } : null;
  }
  function isCodecMismatch(playerCodecs, backupCodecs) {
    if (isEnhancedCodec(playerCodecs)) {
      return videoCodecFamily(backupCodecs) !== videoCodecFamily(playerCodecs);
    }
    return isEnhancedCodec(backupCodecs);
  }
  function* parseMasterVariants(encodingsM3u8) {
    const lines = encodingsM3u8.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF") || !lines[i + 1].includes(".m3u8")) {
        continue;
      }
      const attributes = parseAttributes(lines[i]);
      const resolution = attributes["RESOLUTION"];
      yield {
        url: lines[i + 1],
        resolution: resolution ? {
          Resolution: resolution,
          FrameRate: attributes["FRAME-RATE"],
          Codecs: attributes["CODECS"] || "",
          // Copied onto the rewritten line by buildAvcOnlyMaster, so it references media
          // groups the AVC variant carries.
          Audio: attributes["AUDIO"] || "",
          Video: attributes["VIDEO"] || "",
          Subtitles: attributes["SUBTITLES"] || "",
          Url: lines[i + 1]
        } : null
      };
    }
  }
  function replaceOrAppendStreamInfAttr(line, key, value) {
    if (typeof value !== "string" || !value) return line;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const next = key + '="' + escaped + '"';
    const pattern = new RegExp("(^|,)" + key + '=("[^"]*"|[^,]*)');
    return pattern.test(line) ? line.replace(pattern, "$1" + next) : line + "," + next;
  }
  function buildAvcOnlyMaster(encodingsM3u8, variants) {
    const avcVariants = variants.filter((v) => videoCodecFamily(v.Codecs) === "avc");
    if (avcVariants.length === 0 || !variants.some((v) => isEnhancedCodec(v.Codecs))) {
      return null;
    }
    const lines = encodingsM3u8.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) {
        continue;
      }
      const attributes = parseAttributes(lines[i]);
      if (!isEnhancedCodec(attributes["CODECS"])) {
        continue;
      }
      const oldResolution = attributes["RESOLUTION"];
      const targetArea = resolutionArea(oldResolution);
      let target = null;
      let closestDiff = Infinity;
      for (const candidate of avcVariants) {
        const diff = Math.abs(resolutionArea(candidate.Resolution) - targetArea);
        if (diff < closestDiff) {
          closestDiff = diff;
          target = candidate;
        }
      }
      if (!target) continue;
      console.log(
        "ModifiedM3U8 swap " + attributes["CODECS"] + " to " + target.Codecs + " oldRes:" + oldResolution + " newRes:" + target.Resolution
      );
      lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${target.Codecs}"`);
      lines[i] = replaceOrAppendStreamInfAttr(lines[i], "AUDIO", target.Audio);
      lines[i] = replaceOrAppendStreamInfAttr(lines[i], "VIDEO", target.Video);
      lines[i] = replaceOrAppendStreamInfAttr(lines[i], "SUBTITLES", target.Subtitles);
      lines[i + 1] = target.Url + " ".repeat(i + 1);
    }
    return lines.join("\n");
  }

  // src/worker/gql.ts
  var pendingFetchRequests = /* @__PURE__ */ new Map();
  function getAccessToken(channelName, playerType) {
    const body = {
      operationName: "PlaybackAccessToken",
      variables: {
        isLive: true,
        login: channelName,
        isVod: false,
        vodID: "",
        playerType,
        platform: playerType === "autoplay" ? "android" : "web"
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
        }
      }
    };
    return gqlRequest(body);
  }
  function gqlRequest(body) {
    if (!state.GQLDeviceID) {
      state.GQLDeviceID = "";
      const dcharacters = "abcdefghijklmnopqrstuvwxyz0123456789";
      const dcharactersLength = dcharacters.length;
      for (let i = 0; i < 32; i++) {
        state.GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
      }
    }
    const headers = {
      "Client-ID": state.ClientID,
      "X-Device-Id": state.GQLDeviceID,
      // Omitted when logged out: an undefined value would go out as the literal header "Authorization: undefined".
      ...state.AuthorizationHeader && { Authorization: state.AuthorizationHeader },
      ...state.ClientIntegrityHeader && { "Client-Integrity": state.ClientIntegrityHeader },
      ...state.ClientVersion && { "Client-Version": state.ClientVersion },
      ...state.ClientSession && { "Client-Session-Id": state.ClientSession }
    };
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).substring(2, 15);
      const fetchRequest = {
        id: requestId,
        url: "https://gql.twitch.tv/gql",
        options: {
          method: "POST",
          body: JSON.stringify(body),
          headers
        }
      };
      const timeoutId = setTimeout(() => {
        if (pendingFetchRequests.has(requestId)) {
          pendingFetchRequests.delete(requestId);
          reject(new Error("FetchRequest timed out"));
        }
      }, 15e3);
      pendingFetchRequests.set(requestId, {
        resolve,
        reject,
        timeoutId
      });
      postToPage({
        key: "FetchRequest",
        value: fetchRequest
      });
    });
  }

  // src/worker/spoof.ts
  var loggedNoMatch = false;
  var loggedNoToken = false;
  var loggedBadStatus = false;
  function notifyAdComplete(textStr, brk) {
    try {
      const matches = [...textStr.matchAll(/#EXT-X-DATERANGE:(ID="stitched-ad-[^\n]+)\n/g)];
      if (matches.length === 0) {
        if (!loggedNoMatch) {
          loggedNoMatch = true;
          const dateRangeLine = textStr.match(/#EXT-X-DATERANGE:[^\n]{0,200}/);
          console.log(
            "[AD DEBUG] notifyAdComplete: no stitched-ad DATERANGE match. Sample DATERANGE: " + (dateRangeLine ? dateRangeLine[0] : "none found")
          );
        }
        return;
      }
      const spoofedSet = brk.SpoofedAdIds;
      const podLenMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
      const podLength = podLenMatch ? parseInt(podLenMatch[1], 10) : matches.length;
      if (spoofedSet.size >= podLength) {
        return;
      }
      let newSpoofed = 0;
      let firstRollType = "";
      let podCompleteSent = false;
      for (let i = 0; i < matches.length; i++) {
        const idMatch = matches[i][1].match(/^ID="([^"]+)"/);
        const stitchedAdId = idMatch ? idMatch[1] : "";
        if (stitchedAdId && spoofedSet.has(stitchedAdId)) {
          continue;
        }
        const attr = parseAttributes(matches[i][1]);
        const radToken = attr["X-TV-TWITCH-AD-RADS-TOKEN"];
        if (!radToken) {
          if (i === 0 && !loggedNoToken) {
            loggedNoToken = true;
            console.log(
              "[AD DEBUG] notifyAdComplete: matched DATERANGE but no RADS token. Attributes: " + Object.keys(attr).join(", ")
            );
          }
          continue;
        }
        const rollType = (attr["X-TV-TWITCH-AD-ROLL-TYPE"] || "").toLowerCase();
        if (!firstRollType) firstRollType = rollType;
        const adPosition = parseInt(attr["X-TV-TWITCH-AD-POD-POSITION"] || String(i), 10);
        const adDuration = parseInt(attr["X-TV-TWITCH-AD-DURATION"] || "0", 10) || 0;
        const payload = {
          stitched: true,
          ad_id: stitchedAdId,
          roll_type: rollType,
          creative_id: attr["X-TV-TWITCH-AD-CREATIVE-ID"] || "",
          order_id: attr["X-TV-TWITCH-AD-ORDER-ID"] || "",
          line_item_id: attr["X-TV-TWITCH-AD-LINE-ITEM-ID"] || "",
          player_mute: false,
          player_volume: 1,
          visible: true,
          duration: adDuration,
          ad_position: adPosition,
          total_ads: podLength
        };
        const makePacket = (event, extra) => ({
          operationName: "ClientSideAdEventHandling_RecordAdEvent",
          variables: {
            input: { eventName: event, eventPayload: JSON.stringify({ ...payload, ...extra }), radToken }
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: "7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b"
            }
          }
        });
        if (stitchedAdId) spoofedSet.add(stitchedAdId);
        const batch = [
          makePacket("video_ad_impression"),
          makePacket("video_ad_quartile_complete", { quartile: 1 }),
          makePacket("video_ad_quartile_complete", { quartile: 2 }),
          makePacket("video_ad_quartile_complete", { quartile: 3 }),
          makePacket("video_ad_quartile_complete", { quartile: 4 })
        ];
        if (spoofedSet.size === podLength) {
          batch.push(makePacket("video_ad_pod_complete"));
          podCompleteSent = true;
        }
        gqlRequest(batch).then((response) => {
          if (response && response.status !== 200 && !loggedBadStatus) {
            loggedBadStatus = true;
            console.log(
              "[AD DEBUG] notifyAdComplete: GQL response status " + response.status + " — spoof may be rejected/rate-limited"
            );
          }
        }).catch(() => {
        });
        newSpoofed++;
      }
      if (newSpoofed > 0) {
        const total = spoofedSet.size;
        const src = brk.ActiveBackupPlayerType || "primary";
        console.log(
          "[AD DEBUG] Spoofed ad completion for " + newSpoofed + " new ad(s) (" + total + "/" + podLength + " pod) — roll: " + firstRollType + ", src: " + src + ", pod-complete: " + (podCompleteSent ? "yes" : "no")
        );
      }
    } catch (err) {
      console.log("[AD DEBUG] Ad completion spoof failed: " + err.message);
    }
  }

  // src/worker/m3u8.ts
  var POST_AD_REENTRY_GUARD_MS = 8e3;
  var STICKY_ESCAPE_POLLS = 4;
  var FAST_AUTOPLAY_REPROBE_INTERVAL = 5;
  async function processM3U8(url, textStr, realFetch) {
    const streamInfo = state.StreamInfosByUrl[url];
    if (!streamInfo) {
      return textStr;
    }
    streamInfo.LastSeenAt = Date.now();
    if (streamInfo.ReloadPending) {
      streamInfo.ReloadPending = false;
      streamInfo.LastPlayerReload = Date.now();
    }
    if (!streamInfo.LoggedOfflineTransition && textStr.includes("#EXT-X-ENDLIST") && !textStr.includes("#EXTINF:")) {
      streamInfo.LoggedOfflineTransition = true;
      console.log(
        "[AD DEBUG] Stream ended / offline shape detected — m3u8 has #EXT-X-ENDLIST with no segments. Possible Twitch detection response, broadcaster ended stream, or natural end-of-broadcast"
      );
    }
    if (!streamInfo.HasCheckedUnknownTags) {
      streamInfo.HasCheckedUnknownTags = true;
      const unknownAdTags = textStr.match(/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi);
      if (unknownAdTags) {
        const unknown = unknownAdTags.filter((t) => !state.AdSignifiers.some((s) => s && t.includes(s)));
        if (unknown.length > 0) {
          console.log("[AD DEBUG] Unknown ad-related tags found: " + [...new Set(unknown)].join(", "));
        }
      }
    }
    const haveAdTags = hasAdTags(textStr) || state.SimulatedAdsDepth > 0;
    if (haveAdTags) {
      return handleAdPoll(streamInfo, url, textStr, realFetch);
    }
    const brk = streamInfo.Break;
    if (brk) {
      handleAdFreePoll(streamInfo, brk, textStr);
    } else if (textStr.indexOf("#EXTINF") !== -1) {
      streamInfo.LastCleanNativeM3U8 = textStr;
      streamInfo.LastCleanNativePlaylistAt = Date.now();
    }
    postBanner(streamInfo);
    return textStr;
  }
  async function handleAdPoll(streamInfo, url, textStr, realFetch) {
    let brk = streamInfo.Break;
    const isMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
    if (brk) {
      onAdPoll(brk);
      brk.IsMidroll = isMidroll;
    } else {
      brk = streamInfo.Break = createAdBreak(textStr);
      brk.IsMidroll = isMidroll;
      console.log(
        "[AD DEBUG] Ad detected — type: " + (isMidroll ? "midroll" : "preroll") + ", channel: " + streamInfo.ChannelName + ", pod: " + brk.PodLength + " ad(s) (~" + brk.PodLength * 30 + "s expected), signifiers: " + getMatchedAdSignifiers(textStr).join(", ")
      );
      postToPage({
        key: "UpdateAdBlockBanner",
        isMidroll,
        hasAds: true,
        isStrippingAdSegments: false
      });
    }
    if (!state.DisableAdSpoofing) {
      const spoofBreak = brk;
      setTimeout(() => notifyAdComplete(textStr, spoofBreak), 0);
    }
    const lines = textStr.split(/\r?\n/);
    if (!brk.IsMidroll) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#EXTINF") && lines.length > i + 1) {
          if (!line.includes(",live") && !brk.RequestedAds.has(lines[i + 1])) {
            brk.RequestedAds.add(lines[i + 1]);
            fetch(lines[i + 1]).then((response) => response.blob()).catch(() => {
            });
            break;
          }
        }
      }
    }
    const currentResolution = streamInfo.Urls[url];
    if (!currentResolution) {
      console.log("Ads will leak due to missing resolution info for " + url);
      return stripAdSegments(textStr, false, streamInfo, brk);
    }
    const isEnhanced = isEnhancedCodec(currentResolution.Codecs);
    const codecSwapStarted = isEnhanced && maybeStartCodecSwap(streamInfo, brk);
    if (state.PreferLowQualityBackup && brk.Path === "sticky-csai" && brk.ConsecutiveAllStrippedPolls >= STICKY_ESCAPE_POLLS) {
      const stuckPolls = brk.ConsecutiveAllStrippedPolls;
      const earlyReloadInfo = brk.EarlyReloadCount + "/" + Math.max(1, brk.PodLength);
      console.log(
        "[AD DEBUG] Sticky CSAI escape hatch — stuck " + stuckPolls + " polls (~" + stuckPolls * 2 + "s), EarlyReloadCount=" + earlyReloadInfo + ", recovery cache=" + brk.RecoverySegments.length + " segments, falling through to backup search"
      );
      brk.Path = "escaped";
    }
    if (brk.Path === "sticky-csai" && streamInfo.CodecSwap === "native") {
      textStr = stripAdSegments(textStr, false, streamInfo, brk);
      stepEarlyReload(brk, " (sticky path)");
      postBanner(streamInfo, null);
      return textStr;
    }
    const hasNonLiveSegment = lines.some((line) => line.startsWith("#EXTINF") && !line.includes(",live"));
    if (brk.Path === "probing" && !hasNonLiveSegment && streamInfo.CodecSwap === "native" && !state.BackupSwapFirst) {
      brk.Path = "sticky-csai";
      console.log("[AD DEBUG] CSAI fast path — all segments live, skipping backup search");
      textStr = stripAdSegments(textStr, false, streamInfo, brk);
      postBanner(streamInfo, null);
      return textStr;
    }
    const backup = await searchBackup(streamInfo, brk, currentResolution, realFetch);
    if (streamInfo.Break !== brk) {
      if (backup) {
        console.log(
          "[AD DEBUG] Discarded stale backup commit (" + backup.playerType + ", " + (Date.now() - backup.searchStartedAt) + "ms) — break ended during search"
        );
      }
      textStr = stripAdSegments(textStr, false, streamInfo, brk);
      postBanner(streamInfo);
      return textStr;
    }
    if (backup) {
      textStr = backup.m3u8;
      commitBackup(streamInfo, brk, backup.playerType, backup.searchStartedAt, backup.coldTokenFetches);
    }
    const stripAll = backup ? isCodecMismatch(currentResolution.Codecs, backup.codecs) : isEnhanced && !!streamInfo.ModifiedM3U8;
    textStr = stripAdSegments(textStr, stripAll, streamInfo, brk);
    stepEarlyReload(brk, "", !codecSwapStarted);
    postBanner(streamInfo);
    return textStr;
  }
  function maybeStartCodecSwap(streamInfo, brk) {
    if (!streamInfo.ModifiedM3U8 || streamInfo.CodecSwap !== "native" || brk.CodecSwapTried || streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < POST_AD_REENTRY_GUARD_MS) {
      return false;
    }
    brk.CodecSwapTried = true;
    streamInfo.CodecSwap = "switching";
    streamInfo.LastPlayerReload = Date.now();
    requestReload("codec-swap", (outcome) => {
      if (streamInfo.CodecSwap !== "switching") return;
      if (outcome === "reloaded") {
        streamInfo.CodecSwap = "swapped";
      } else {
        streamInfo.CodecSwap = "native";
        console.log(
          "[AD DEBUG] Codec-swap reload not done by the page (" + outcome + ") — staying on native codec"
        );
      }
    });
    return true;
  }
  function backupOrder(streamInfo, brk) {
    const types = state.PreferLowQualityBackup ? [...state.BackupPlayerTypes, "autoplay"] : [...state.BackupPlayerTypes];
    const moveToFront = (t) => {
      const index = types.indexOf(t);
      if (index > 0) {
        types.splice(index, 1);
        types.unshift(t);
        return true;
      }
      return false;
    };
    if (streamInfo.PinnedBackupPlayerType) {
      moveToFront(streamInfo.PinnedBackupPlayerType);
    }
    if (brk.AutoplayFirst === null) {
      brk.AutoplayFirst = decideAutoplayFirst(streamInfo);
    }
    if (brk.AutoplayFirst && moveToFront("autoplay") && !brk.LoggedAutoplayOrder) {
      brk.LoggedAutoplayOrder = true;
      console.log("[AD DEBUG] Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first");
    }
    if (brk.ContaminatedTypes.size > 0) {
      const clean = types.filter((t) => !brk.ContaminatedTypes.has(t));
      const contam = types.filter((t) => brk.ContaminatedTypes.has(t));
      if (contam.length > 0 && clean.length > 0) {
        types.length = 0;
        types.push(...clean, ...contam);
        if (!brk.LoggedContamReorder) {
          brk.LoggedContamReorder = true;
          console.log(
            "[AD DEBUG] Contamination-aware reorder — trying [" + clean.join(", ") + "] before known-contaminated [" + contam.join(", ") + "]"
          );
        }
      }
    }
    return types;
  }
  function decideAutoplayFirst(streamInfo) {
    if (!state.FastAutoplayFirstTry || !state.PreferLowQualityBackup || !streamInfo.SourceTierExhausted) {
      return false;
    }
    if (streamInfo.FastAutoplayWins >= FAST_AUTOPLAY_REPROBE_INTERVAL) {
      console.log(
        "[AD DEBUG] Fast-autoplay re-probe — testing Source-tier after " + streamInfo.FastAutoplayWins + " consecutive fast-autoplay breaks (channel-recovery check)"
      );
      streamInfo.FastAutoplayWins = 0;
      return false;
    }
    return true;
  }
  async function searchBackup(streamInfo, brk, currentResolution, realFetch) {
    const backupSearchStart = Date.now();
    let backupColdTokenFetches = 0;
    let found = null;
    let fallback = null;
    const isDoingMinimalRequests = streamInfo.LastPlayerReload > Date.now() - state.PlayerReloadMinimalRequestsTime;
    const playerTypesToTry = backupOrder(streamInfo, brk);
    for (let playerTypeIndex = 0; !found && playerTypeIndex < playerTypesToTry.length; playerTypeIndex++) {
      const playerType = playerTypesToTry[playerTypeIndex];
      const failedAt = brk.FailedBackupPlayerTypes.get(playerType);
      if (failedAt && Date.now() - failedAt < 5e3) {
        continue;
      }
      const isLastType = playerTypeIndex >= playerTypesToTry.length - 1;
      for (let i = 0; i < 2; i++) {
        let isFreshM3u8 = false;
        let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
        if (!encodingsM3u8) {
          isFreshM3u8 = true;
          backupColdTokenFetches++;
          const fetched = await fetchBackupEncodings(streamInfo, brk, playerType, realFetch);
          if (fetched === "missing-token") {
            continue;
          }
          encodingsM3u8 = fetched;
        }
        const candidate = encodingsM3u8 ? await fetchBackupPlaylist(encodingsM3u8, playerType, currentResolution, realFetch) : null;
        if (candidate) {
          if (playerType === state.FallbackPlayerType) {
            fallback = candidate;
          }
          const backupHasAds = hasAdTags(candidate.m3u8);
          if (!backupHasAds && (state.SimulatedAdsDepth === 0 || playerTypeIndex >= state.SimulatedAdsDepth - 1) || !fallback && isLastType) {
            if (brk.ConsecutiveAllStrippedPolls >= 1 && !backupHasAds) {
              noteCleanDuringFreeze(brk, playerType);
            }
            found = candidate;
            break;
          }
          if (backupHasAds && !brk.ContaminatedTypes.has(playerType)) {
            brk.ContaminatedTypes.add(playerType);
            console.log("[AD DEBUG] Backup stream (" + playerType + ") also has ads");
          }
          if (isDoingMinimalRequests) {
            found = candidate;
            break;
          }
          if (backupHasAds && isLastType) {
            console.log(
              "[AD DEBUG] All backup player types ad-laden — taking " + playerType + " as last-resort fallback (strip+recovery path will engage)"
            );
            found = candidate;
            break;
          }
        }
        streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
        if (isFreshM3u8) {
          break;
        }
      }
    }
    if (!found && fallback) {
      if (brk.ContaminatedTypes.has(state.FallbackPlayerType)) {
        console.log(
          "[AD DEBUG] Skipping fallback to " + state.FallbackPlayerType + " — marked contaminated this break (" + [...brk.ContaminatedTypes].join(", ") + " all ad-laden)"
        );
      } else {
        found = fallback;
      }
    }
    if (found) {
      return { ...found, searchStartedAt: backupSearchStart, coldTokenFetches: backupColdTokenFetches };
    }
    console.log("[AD DEBUG] No ad-free backup stream found — ads may leak. Tried: " + playerTypesToTry.join(", "));
    return null;
  }
  async function fetchBackupEncodings(streamInfo, brk, playerType, realFetch) {
    try {
      const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType);
      if (accessTokenResponse.status !== 200) {
        let errorBody = "";
        try {
          errorBody = " — " + (await accessTokenResponse.text()).substring(0, 200);
        } catch {
        }
        console.log(
          "[AD DEBUG] Access token HTTP " + accessTokenResponse.status + " for " + playerType + (accessTokenResponse.status === 403 ? " (integrity: " + (state.ClientIntegrityHeader ? "present" : "missing") + ")" : "") + errorBody
        );
        recordTokenFetchFailure(streamInfo, brk, playerType);
        return null;
      }
      const accessToken = await accessTokenResponse.json();
      const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
      if (!spat) {
        const errInfo = accessToken?.errors ? " errors: " + JSON.stringify(accessToken.errors).substring(0, 300) : "";
        console.log(
          "[AD DEBUG] GQL response missing streamPlaybackAccessToken for " + playerType + ". Response keys: " + JSON.stringify(Object.keys(accessToken || {})) + errInfo
        );
        recordTokenFetchFailure(streamInfo, brk, playerType);
        return "missing-token";
      }
      const urlInfo = new URL(
        "https://usher.ttvnw.net/api/" + (state.V2API ? "v2/" : "") + "channel/hls/" + streamInfo.ChannelName + ".m3u8" + streamInfo.UsherParams
      );
      urlInfo.searchParams.set("sig", spat.signature);
      urlInfo.searchParams.set("token", spat.value);
      const encodingsM3u8Response = await realFetch(urlInfo.href);
      if (encodingsM3u8Response.status !== 200) {
        console.log("[AD DEBUG] Usher HTTP " + encodingsM3u8Response.status + " for " + playerType);
        return null;
      }
      const encodingsM3u8 = await encodingsM3u8Response.text();
      streamInfo.BackupEncodingsM3U8Cache[playerType] = encodingsM3u8;
      streamInfo.ConsecutiveTokenFetchFailures = 0;
      streamInfo.LoggedTokenFailureStreak = false;
      return encodingsM3u8;
    } catch (err) {
      console.log("[AD DEBUG] Access token failed for " + playerType + ": " + err.message);
      recordTokenFetchFailure(streamInfo, brk, playerType);
      return null;
    }
  }
  async function fetchBackupPlaylist(encodingsM3u8, playerType, currentResolution, realFetch) {
    try {
      const variant = getStreamVariantForResolution(encodingsM3u8, currentResolution);
      const streamM3u8Url = variant?.url;
      if (!variant || !streamM3u8Url) {
        throw new Error("no variant playlist in the backup encodings");
      }
      const streamM3u8Response = await realFetch(streamM3u8Url);
      if (streamM3u8Response.status !== 200) {
        console.log(
          "[AD DEBUG] Backup stream fetch failed for " + playerType + " (status " + streamM3u8Response.status + ")"
        );
        return null;
      }
      const m3u8 = await streamM3u8Response.text();
      return m3u8 ? { playerType, m3u8, codecs: variant.codecs } : null;
    } catch (err) {
      console.log("[AD DEBUG] Backup stream error for " + playerType + ": " + err.message);
      return null;
    }
  }
  function noteCleanDuringFreeze(brk, playerType) {
    const prevType = brk.LastCommittedBackupPlayerType;
    if (prevType && prevType !== playerType) {
      console.log(
        "[AD DEBUG] Cycle switched to different clean type (" + playerType + ", was " + prevType + ") during freeze — recovered without reload"
      );
      brk.CycleRescued = true;
    } else {
      console.log("[AD DEBUG] Same backup type (" + playerType + ") became clean during freeze — natural recovery");
    }
  }
  function commitBackup(streamInfo, brk, backupPlayerType, searchStartedAt, coldTokenFetches) {
    brk.LastCommittedBackupPlayerType = backupPlayerType;
    if (brk.ActiveBackupPlayerType === backupPlayerType) {
      return;
    }
    brk.ActiveBackupPlayerType = backupPlayerType;
    if (state.PinBackupPlayerType && backupPlayerType !== "autoplay") {
      streamInfo.PinnedBackupPlayerType = backupPlayerType;
    }
    console.log(
      `[AD DEBUG] Blocking${brk.IsMidroll ? " midroll " : " "}ads (${backupPlayerType}) — backup found in ${Date.now() - searchStartedAt}ms${coldTokenFetches > 0 ? ` (cold cache: ${coldTokenFetches} token fetch${coldTokenFetches > 1 ? "es" : ""})` : " (warm cache)"}`
    );
    if (brk.Path === "escaped") {
      const qualityTier = backupPlayerType === "autoplay" ? "360p" : "Source";
      console.log(
        "[AD DEBUG] Post-escape backup: " + backupPlayerType + " (" + qualityTier + ") — recovered from sticky-path freeze"
      );
    } else if (backupPlayerType === "autoplay" && state.PreferLowQualityBackup) {
      const sourceTried = brk.ContaminatedTypes.size;
      if (sourceTried === 0) {
        console.log("[AD DEBUG] Autoplay backup committed — 360p first-try (PreferLowQualityBackup)");
        streamInfo.FastAutoplayWins++;
      } else {
        console.log(
          "[AD DEBUG] Autoplay backup committed — 360p fallback after " + sourceTried + " Source type(s) ad-laden (PreferLowQualityBackup)"
        );
      }
      if (state.FastAutoplayFirstTry && sourceTried >= 4) {
        streamInfo.SourceTierExhausted = true;
        streamInfo.FastAutoplayWins = 0;
      }
    } else if (state.FastAutoplayFirstTry && backupPlayerType !== "autoplay") {
      streamInfo.SourceTierExhausted = false;
      streamInfo.FastAutoplayWins = 0;
    }
  }
  function handleAdFreePoll(streamInfo, brk, textStr) {
    const reason = onAdFreePoll(brk, textStr.includes(",live"));
    if (!reason) {
      return;
    }
    if (reason === "max-wait" && brk.End) {
      console.log(
        "[AD DEBUG] Slow-path ad-end escalation — " + brk.End.bounces + " marker bounces, " + ((Date.now() - brk.End.since) / 1e3).toFixed(1) + "s since first clean poll"
      );
    } else if (reason === "no-live-segments") {
      console.log("[AD DEBUG] Backup stream has no live segments — forcing immediate reload");
    }
    endBreak(streamInfo, brk);
  }
  function endBreak(streamInfo, brk) {
    console.log(
      "[AD DEBUG] Finished blocking ads — stripped " + brk.StrippedSegments + " ad segments, duration: " + ((Date.now() - brk.StartedAt) / 1e3).toFixed(1) + "s"
    );
    if (brk.TotalAllStrippedPolls > 0) {
      const reloadInfo = brk.EarlyReloadAtPoll ? ", early reload at poll " + brk.EarlyReloadAtPoll : "";
      const wallClockFreeze = brk.FreezeStartedAt ? ((Date.now() - brk.FreezeStartedAt) / 1e3).toFixed(1) + "s wall-clock" : "unknown";
      console.log(
        "[AD DEBUG] Ad break stats: " + brk.TotalAllStrippedPolls + " all-stripped polls, freeze duration: " + wallClockFreeze + reloadInfo
      );
    }
    const hadStrippedSegments = brk.StrippedSegments > 0;
    if (!hadStrippedSegments && !brk.HasConfirmedAdAttrs) {
      streamInfo.ConsecutiveZeroStripBreaks++;
      if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
        console.log(
          "[AD DEBUG] Warning: " + streamInfo.ConsecutiveZeroStripBreaks + " consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers"
        );
      }
    } else {
      streamInfo.ConsecutiveZeroStripBreaks = 0;
    }
    const action = decideBreakEndAction(streamInfo, brk, state);
    streamInfo.Break = null;
    streamInfo.CodecSwap = "native";
    if (!hadStrippedSegments) {
      console.log("[AD DEBUG] CSAI-only ad break (stripped 0) — no MediaSource flush needed");
    }
    if (action.action === "reload") {
      console.log("[AD DEBUG] End-of-break reload: " + action.reason);
      streamInfo.LastPlayerReload = Date.now();
      requestReload(action.kind);
    } else if (action.action === "pause-play") {
      if (hadStrippedSegments && state.ReloadPlayerAfterAd) {
        console.log("[AD DEBUG] Cycle rescue handled the break cleanly — skipping end-of-break reload");
      }
      postToPage({ key: "PauseResumePlayer" });
    }
  }
  function postBanner(streamInfo, activeBackupPlayerType) {
    const brk = streamInfo.Break;
    postToPage({
      key: "UpdateAdBlockBanner",
      isMidroll: brk ? brk.IsMidroll : false,
      hasAds: !!brk,
      isStrippingAdSegments: brk ? brk.IsStripping : false,
      numStrippedAdSegments: brk ? brk.StrippedSegments : 0,
      activeBackupPlayerType: activeBackupPlayerType === void 0 ? brk?.ActiveBackupPlayerType ?? null : activeBackupPlayerType
    });
  }
  function recordTokenFetchFailure(streamInfo, brk, playerType) {
    brk.FailedBackupPlayerTypes.set(playerType, Date.now());
    streamInfo.ConsecutiveTokenFetchFailures++;
    if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
      streamInfo.LoggedTokenFailureStreak = true;
      console.log(
        "[AD DEBUG] Token fetch failed " + streamInfo.ConsecutiveTokenFetchFailures + " times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting"
      );
    }
  }

  // src/worker/stream-info.ts
  function pruneStreamInfos() {
    const now = Date.now();
    for (const channelName in state.StreamInfos) {
      const streamInfo = state.StreamInfos[channelName];
      if (!streamInfo || !streamInfo.LastSeenAt || now - streamInfo.LastSeenAt > state.StreamInfoMaxAgeMs) {
        if (streamInfo && streamInfo.Urls) {
          for (const url in streamInfo.Urls) {
            delete state.StreamInfosByUrl[url];
          }
        }
        delete state.StreamInfos[channelName];
      }
    }
    for (const url in state.StreamInfosByUrl) {
      const streamInfo = state.StreamInfosByUrl[url];
      if (state.StreamInfos[streamInfo.ChannelName] !== streamInfo) {
        delete state.StreamInfosByUrl[url];
      }
    }
  }
  function createStreamInfo(channelName, encodingsM3u8, usherParams) {
    return {
      ChannelName: channelName,
      LastSeenAt: Date.now(),
      EncodingsM3U8: encodingsM3u8,
      UsherParams: usherParams,
      Urls: /* @__PURE__ */ Object.create(null),
      ModifiedM3U8: null,
      CodecSwap: "native",
      Break: null,
      ConsecutiveZeroStripBreaks: 0,
      LastAdCachePruneAt: 0,
      LastCleanNativeM3U8: null,
      LastCleanNativePlaylistAt: 0,
      BackupEncodingsM3U8Cache: /* @__PURE__ */ Object.create(null),
      PinnedBackupPlayerType: null,
      SourceTierExhausted: false,
      FastAutoplayWins: 0,
      LastPlayerReload: 0,
      ReloadPending: false,
      HasCheckedUnknownTags: false,
      LoggedOfflineTransition: false,
      ConsecutiveTokenFetchFailures: 0,
      LoggedTokenFailureStreak: false,
      LoggedAdCacheSize1k: false
    };
  }

  // src/worker/fetch-hook.ts
  async function passThroughOnError(kind, original, rewrite) {
    try {
      return new Response(await rewrite());
    } catch (err) {
      console.log(
        "[AD DEBUG] Failed to process " + kind + " — passing it through unmodified: " + err.message
      );
      return new Response(original);
    }
  }
  function hookWorkerFetch() {
    console.log("[AD DEBUG] hookWorkerFetch (vaft)");
    const BLANK_MP4 = new Blob(
      [
        Uint8Array.from(
          atob(
            "AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA"
          ),
          (c) => c.charCodeAt(0)
        )
      ],
      { type: "video/mp4" }
    );
    const realFetch = fetch;
    const hook = async function(url, options) {
      if (typeof url === "string") {
        if (state.AdSegmentCache.has(url)) {
          return new Response(BLANK_MP4);
        }
        url = url.trimEnd();
        if (url.endsWith("m3u8")) {
          const response = await realFetch(url, options);
          if (response.status !== 200) {
            return response;
          }
          const text = await response.text();
          return passThroughOnError(
            "media playlist",
            text,
            async () => processM3U8(url, text, realFetch)
          );
        } else if (url.includes("/channel/hls/") && !url.includes("picture-by-picture")) {
          state.V2API = url.includes("/api/v2/");
          const parsedUrl = new URL(url);
          const channelName = parsedUrl.pathname.match(/([^/]+)(?=\.\w+$)/)?.[0];
          if (state.ForceAccessTokenPlayerType) {
            parsedUrl.searchParams.delete("parent_domains");
            url = parsedUrl.toString();
          }
          const response = await realFetch(url, options);
          if (response.status !== 200) {
            return response;
          }
          const encodingsM3u8 = await response.text();
          return passThroughOnError("master playlist", encodingsM3u8, async () => {
            const serverTime = getServerTimeFromM3u8(encodingsM3u8);
            let streamInfo = state.StreamInfos[channelName];
            if (streamInfo != null) {
              const probeUrl = streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m)?.[0] || streamInfo.EncodingsM3U8.match(/^https:\/\/\S+$/m)?.[0];
              let cacheAlive = false;
              if (probeUrl) {
                try {
                  cacheAlive = (await realFetch(probeUrl)).status === 200;
                } catch {
                }
              }
              if (!cacheAlive) {
                streamInfo = null;
              }
            }
            if (streamInfo == null) {
              console.log(
                "[AD DEBUG] New stream session — channel: " + channelName + ", API: " + (state.V2API ? "v2" : "v1")
              );
              state.StreamInfos[channelName] = streamInfo = createStreamInfo(
                channelName,
                encodingsM3u8,
                parsedUrl.search
              );
              const resolutionList = [];
              for (const { url: url2, resolution } of parseMasterVariants(encodingsM3u8)) {
                if (resolution) {
                  streamInfo.Urls[url2] = resolution;
                  resolutionList.push(resolution);
                }
                state.StreamInfosByUrl[url2] = streamInfo;
              }
              if (resolutionList.length === 0) {
                console.log(
                  "[AD DEBUG] No resolutions parsed from encodings m3u8 — Twitch may have changed the format"
                );
              }
              streamInfo.ModifiedM3U8 = buildAvcOnlyMaster(encodingsM3u8, resolutionList);
            }
            streamInfo.LastSeenAt = Date.now();
            return replaceServerTimeInM3u8(
              streamInfo.CodecSwap !== "native" && streamInfo.ModifiedM3U8 || streamInfo.EncodingsM3U8,
              serverTime
            );
          });
        }
      }
      return realFetch.apply(this, arguments);
    };
    return installHook(self, "fetch", hook, "worker fetch");
  }

  // src/worker/index.ts
  var workerString = getWasmWorkerJs(__vaftInit.twitchBlobUrl);
  if (!self.__tasPruneInterval) {
    self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1e3);
  }
  Object.assign(state, __vaftInit.config);
  self.addEventListener("message", function(e) {
    const headerRelay = GQL_HEADER_RELAYS.find((relay) => relay.key === e.data.key);
    if (headerRelay) {
      state[headerRelay.field] = e.data.value;
    } else if (e.data.key === "UpdateClientId") {
      state.ClientID = e.data.value;
    } else if (e.data.key === "FetchResponse") {
      const responseData = e.data.value;
      const pending = pendingFetchRequests.get(responseData.id);
      if (pending) {
        const { resolve, reject, timeoutId } = pending;
        clearTimeout(timeoutId);
        pendingFetchRequests.delete(responseData.id);
        if (responseData.error) {
          reject(new Error(responseData.error));
        } else {
          const ok = responseData;
          const response = new Response(ok.body, {
            status: ok.status,
            statusText: ok.statusText,
            headers: ok.headers
          });
          try {
            Object.defineProperty(response, "url", { value: ok.url || "", configurable: true });
            Object.defineProperty(response, "redirected", {
              value: !!ok.redirected,
              configurable: true
            });
            Object.defineProperty(response, "type", {
              value: ok.type || "basic",
              configurable: true
            });
          } catch {
          }
          resolve(response);
        }
      }
    } else if (e.data.key === "TriggeredPlayerReload") {
      for (const channel in state.StreamInfos) {
        state.StreamInfos[channel].ReloadPending = true;
      }
    } else if (e.data.key === "ReloadResult") {
      settleReload(e.data.value.requestId, e.data.value.outcome);
    } else if (e.data.key === "SimulateAds") {
      state.SimulatedAdsDepth = e.data.value;
      console.log("SimulatedAdsDepth: " + state.SimulatedAdsDepth);
    } else if (e.data.key === "AllSegmentsAreAdSegments") {
      state.AllSegmentsAreAdSegments = !state.AllSegmentsAreAdSegments;
      console.log("AllSegmentsAreAdSegments: " + state.AllSegmentsAreAdSegments);
    }
  });
  var hooked = false;
  try {
    hooked = hookWorkerFetch();
  } catch (e) {
    console.error("[AD DEBUG] Worker fetch hook setup failed:", e);
  }
  if (!hooked) {
    console.log("[AD DEBUG] Worker fetch not hooked: ads will not be blocked in this worker");
  }
  try {
    (0, eval)(workerString);
  } catch (e) {
    console.error("[AD DEBUG] Worker eval failed — Twitch player logic not loaded:", e);
  }
})();
  }

  // src/page/worker-hook.ts
  var workerStringConflicts = [
    "twitch",
    "isVariantA"
    // TwitchNoSub
  ];
  var workerStringReinsert = [
    "isVariantA",
    // TwitchNoSub (prior to (0.9))
    "besuper/",
    // TwitchNoSub (0.9)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal marker string from TwitchNoSub's worker source
    "${patch_url}"
    // TwitchNoSub (0.9.1)
  ];
  function getCleanWorker(worker) {
    let root = null;
    let parent = null;
    let proto = worker;
    while (proto) {
      const workerString = proto.toString();
      if (workerStringConflicts.some((x) => workerString.includes(x))) {
        if (parent !== null) {
          try {
            Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
          } catch {
          }
        }
      } else {
        if (root === null) {
          root = proto;
        }
        parent = proto;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return root;
  }
  function getWorkersForReinsert(worker) {
    const result = [];
    let proto = worker;
    while (proto) {
      const workerString = proto.toString();
      if (workerStringReinsert.some((x) => workerString.includes(x))) {
        result.push(proto);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return result;
  }
  function reinsertWorkers(worker, reinsert) {
    let parent = worker;
    for (let i = 0; i < reinsert.length; i++) {
      try {
        Object.setPrototypeOf(reinsert[i], parent);
      } catch {
      }
      parent = reinsert[i];
    }
    return parent;
  }
  function isValidWorker(worker) {
    const workerString = worker.toString();
    const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
    const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
    if (hasConflict && !hasReinsert) {
      console.log(
        "[AD DEBUG] Worker rejected — conflict string found: " + workerStringConflicts.filter((x) => workerString.includes(x)).join(", ")
      );
    }
    return !hasConflict || hasReinsert;
  }
  var injectedBlobUrl = null;
  var originalRevokeObjectURL = null;
  function hookWindowWorker() {
    if (!URL.revokeObjectURL.__tasMasked) {
      const realRevokeObjectURL = URL.revokeObjectURL;
      originalRevokeObjectURL = realRevokeObjectURL;
      const hook = maskAsNative(function(url) {
        if (url === injectedBlobUrl) return;
        return realRevokeObjectURL.call(this, url);
      }, "revokeObjectURL");
      hook.__tasMasked = true;
      installHook(URL, "revokeObjectURL", hook, "URL.revokeObjectURL");
    }
    const reinsert = getWorkersForReinsert(window.Worker);
    const cleanWorker = getCleanWorker(window.Worker) || window.Worker;
    const newWorker = class Worker extends cleanWorker {
      constructor(twitchBlobUrl, options) {
        twitchBlobUrl = String(twitchBlobUrl);
        let isTwitchWorker = false;
        try {
          isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith(".twitch.tv");
        } catch {
        }
        if (!isTwitchWorker) {
          super(twitchBlobUrl, options);
          console.log("[AD DEBUG] Non-Twitch worker skipped: " + twitchBlobUrl);
          return;
        }
        let prefetchedWorkerJs = null;
        try {
          prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl);
        } catch {
        }
        if (!prefetchedWorkerJs) {
          super(twitchBlobUrl, options);
          console.log("[AD DEBUG] Failed to fetch worker JS — falling back to unmodified worker");
          return;
        }
        const alreadyHooked = prefetchedWorkerJs.includes("hookWorkerFetch");
        if (alreadyHooked) {
          super(twitchBlobUrl, options);
          console.log("[AD DEBUG] Worker already hooked — reusing without re-injection");
        } else {
          console.log("[AD DEBUG] Worker intercepted — injecting ad-block hooks");
          if (injectedBlobUrl && originalRevokeObjectURL) {
            try {
              originalRevokeObjectURL.call(URL, injectedBlobUrl);
            } catch {
            }
          }
          const init = { twitchBlobUrl, config: pickSharedConfig(state) };
          const newBlobStr = `(${runWorker.toString()})(${JSON.stringify(init)});`;
          injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
          super(injectedBlobUrl, options);
        }
        twitchWorkers.length = 0;
        twitchWorkers.push(this);
        this.addEventListener("message", (e) => {
          if (e.data.key === "UpdateAdBlockBanner") {
            onAdBreakUpdate(e.data);
          } else if (e.data.key === "PauseResumePlayer") {
            doTwitchPlayerTask("pausePlay");
          } else if (e.data.key === "ReloadPlayer") {
            const { kind, requestId } = e.data;
            let outcome = "not-done";
            try {
              outcome = doTwitchPlayerTask("reload", kind);
            } finally {
              if (requestId) {
                this.postMessage({
                  key: "ReloadResult",
                  value: { requestId, outcome: outcome === "done" ? "reloaded" : outcome }
                });
              }
            }
          }
        });
        this.addEventListener("message", async (event) => {
          if (event.data.key === "FetchRequest") {
            const fetchRequest = event.data.value;
            const responseData = await handleWorkerFetchRequest(fetchRequest);
            this.postMessage({
              key: "FetchResponse",
              value: responseData
            });
          }
        });
        let crashed = false;
        this.addEventListener("error", (e) => {
          if (crashed) return;
          crashed = true;
          console.log(
            "[AD DEBUG] IVS WASM worker crashed: " + (e && e.message || "unknown error") + " — triggering hard reload to recover"
          );
          try {
            doTwitchPlayerTask("reload", "early");
          } catch (err) {
            console.log("[AD DEBUG] Worker crash recovery failed: " + err.message);
          }
        });
      }
    };
    let workerInstance = reinsertWorkers(newWorker, reinsert);
    Object.defineProperty(window, "Worker", {
      get: function() {
        return workerInstance;
      },
      set: function(value) {
        if (isValidWorker(value)) {
          workerInstance = value;
        } else {
          console.log("Attempt to set twitch worker denied");
        }
      }
    });
  }
  function onAdBreakUpdate(data) {
    runtime.isActivelyStrippingAds = !!data.isStrippingAdSegments;
    if (data.hasAds !== playerBufferState.inAdBreak) {
      playerBufferState.lastBackupSwitchAt = Date.now();
      if (!data.hasAds) {
        playerBufferState.position = 0;
      }
    }
    playerBufferState.inAdBreak = !!data.hasAds;
    if (data.hasAds) {
      cancelDriftCorrection();
    }
    updateAdblockBanner(data);
  }
  async function handleWorkerFetchRequest(fetchRequest) {
    const controller = new AbortController();
    const timeoutMs = 5e3;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await window.realFetch(fetchRequest.url, {
        ...fetchRequest.options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const responseBody = await response.text();
      const responseObject = {
        id: fetchRequest.id,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        type: response.type,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody
      };
      return responseObject;
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        id: fetchRequest.id,
        error: error.name === "AbortError" ? "GQL fetch timeout (" + timeoutMs / 1e3 + "s)" : error.message
      };
    }
  }

  // src/page/index.ts
  var ourTwitchAdSolutionsVersion = 99;
  function main() {
    let _isNested = false;
    try {
      _isNested = window.frameElement !== null || window.top?.location.href !== document.location.href;
    } catch (_e) {
      _isNested = true;
    }
    if (_isNested) {
      const _host = document.location.hostname;
      const _isEmbedContext = _host === "player.twitch.tv" || _host === "embed.twitch.tv" || document.location.pathname.startsWith("/embed/");
      if (!_isEmbedContext) {
        console.log(
          "[AD DEBUG] vaft skipped — nested frame on " + _host + document.location.pathname + " (not a Twitch embed). If you see this on twitch.tv/CHANNEL top frame, please report."
        );
        return;
      }
    }
    {
      const _clipHost = document.location.hostname;
      const _clipPath = document.location.pathname || "";
      if (_clipHost === "clips.twitch.tv" || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
        console.log("[AD DEBUG] vaft skipped — clip editor page (" + _clipHost + _clipPath + ").");
        return;
      }
    }
    console.log("[AD DEBUG] TwitchAdSolutions vaft v" + ourTwitchAdSolutionsVersion + " loading");
    if (typeof window.twitchAdSolutionsVersion !== "undefined" && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
      console.log(
        "[AD DEBUG] CONFLICT: vaft v" + ourTwitchAdSolutionsVersion + " skipped — another script already active (v" + window.twitchAdSolutionsVersion + "). Remove duplicate scripts."
      );
      return;
    }
    installHook(window, "twitchAdSolutionsVersion", ourTwitchAdSolutionsVersion, "window.twitchAdSolutionsVersion");
    installHook(
      window,
      "reloadTwitchPlayer",
      () => {
        doTwitchPlayerTask("reload");
      },
      "window.reloadTwitchPlayer"
    );
    loadLocalStorageConfig();
    console.log(
      "[AD DEBUG] Config: ReloadPlayerAfterAd = " + state.ReloadPlayerAfterAd + ", ForceAccessTokenPlayerType = " + state.ForceAccessTokenPlayerType + ", PinBackupPlayerType = " + state.PinBackupPlayerType
    );
    hookWindowWorker();
    hookFetch();
    hookXhr();
    startBufferMonitor();
    if (document.readyState === "complete" || document.readyState === "interactive") {
      onContentLoaded();
    } else {
      window.addEventListener("DOMContentLoaded", function() {
        onContentLoaded();
      });
    }
    installHook(
      window,
      "simulateAds",
      (depth) => {
        if (depth === void 0 || depth < 0) {
          console.log(
            "Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)"
          );
          return;
        }
        postTwitchWorkerMessage("SimulateAds", depth);
      },
      "window.simulateAds"
    );
    installHook(
      window,
      "allSegmentsAreAdSegments",
      () => {
        postTwitchWorkerMessage("AllSegmentsAreAdSegments");
      },
      "window.allSegmentsAreAdSegments"
    );
  }
  main();
})();
