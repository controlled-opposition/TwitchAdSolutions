// ==UserScript==
// @name         TwitchAdSolutions (vaft)
// @namespace    https://github.com/controlled-opposition/TwitchAdSolutions
// @version      69.0.0
// @description  Multiple solutions for blocking Twitch ads (vaft)
// @updateURL    https://github.com/controlled-opposition/TwitchAdSolutions/raw/master/vaft/vaft.user.js
// @downloadURL  https://github.com/controlled-opposition/TwitchAdSolutions/raw/master/vaft/vaft.user.js
// @author       https://github.com/cleanlock/VideoAdBlockForTwitch#credits
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  // src/page/twitch.ts
  var cachedRootNode = null;
  var firstPlayerNullAt = 0;
  var loggedNoPlayer = false;
  var firstStateNullAt = 0;
  var loggedNoState = false;
  function getPlayerAndState() {
    function findReactNode(root, constraint) {
      if (root.stateNode && constraint(root.stateNode)) {
        return root.stateNode;
      }
      let node = root.child;
      while (node) {
        const result = findReactNode(node, constraint);
        if (result) {
          return result;
        }
        node = node.sibling;
      }
      return null;
    }
    function findReactRootNode() {
      let reactRootNode2 = null;
      if (!cachedRootNode) {
        cachedRootNode = document.querySelector("#root");
      }
      const rootNode = cachedRootNode;
      if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
        reactRootNode2 = rootNode._reactRootContainer._internalRoot.current;
      }
      if (reactRootNode2 == null && rootNode != null) {
        const containerName = Object.keys(rootNode).find(
          (x) => x.startsWith("__reactContainer") || x.startsWith("__reactFiber")
        );
        if (containerName != null) {
          reactRootNode2 = rootNode[containerName];
        }
      }
      return reactRootNode2;
    }
    const reactRootNode = findReactRootNode();
    if (!reactRootNode) {
      return null;
    }
    let player = findReactNode(
      reactRootNode,
      (node) => node.setPlayerActive && node.props && node.props.mediaPlayerInstance
    );
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
    const playerState = findReactNode(reactRootNode, (node) => node.setSrc && node.setInitialPlaybackSettings);
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
      // After the ad finishes do a player reload instead of pause/play
      ReloadCooldownSeconds: 30,
      // Minimum seconds between reloads — breaks CSAI cascades triggered by reload
      EarlyReloadPollThreshold: 3,
      // Number of consecutive all-stripped polls before triggering early reload (each poll ~2s, so 3 = ~6s, 5 = ~10s, 10 = ~20s; 0 = disable). Lowered from 5 to 3 to match the testing variant — field reports indicate faster early-reload recovers heavier SSAI breaks more cleanly. Override via localStorage twitchAdSolutions_earlyReloadPollThreshold.
      PinBackupPlayerType: true,
      // Remember which backup player type worked and try it first on next ad break
      PreferLowQualityBackup: true,
      // Hybrid safety net for SSAI-heavy breaks: sticky escape hatch (fires after ~8s stuck in all-stripped state) + autoplay (360p) as last-resort backup when all Source types are ad-laden. Default on; set twitchAdSolutions_preferLowQualityBackup=false to disable.
      FastAutoplayFirstTry: true,
      // When the prior break committed autoplay-via-escape-hatch, prepend autoplay (360p) to position 0 of playerTypesToTry on the next break — autoplay wins on first probe (~340ms) instead of cycling through 4 Source types (~1.5-2s). Auto-resets when a Source-tier type wins (channel recovered), so quality returns to full automatically if Twitch ever brings back non-ad-laden Source backups. Default on as of v67.1.0 — field data (project_all_channels_csai_only_marked) confirms every observed channel exhausts Source-tier on every break. Opt-out via localStorage twitchAdSolutions_fastAutoplayFirstTry=false.
      BackupSwapFirst: true,
      // On ad detect, immediately swap to a backup player-type m3u8 (TTV-AB-style). Avoids MediaSource mixing from strip activity — fewer loading circles in field. Cost: extra fetches on every ad break. Default on; set twitchAdSolutions_backupSwapFirst=false to disable.
      DisableAdSpoofing: true,
      // Default OFF (was ON through v68.2.0). The always-100%-watched + audible + visible spoof beacon pattern may itself fingerprint as anomalous and trigger detection escalation (CSAI reaching the committed backup) — observed correlation in field + TTV-AB maintainer hypothesis. Spoof-accepted (no GQL rejection) does NOT prove not-fingerprinted; Twitch can 200-OK while using the beacon pattern as silent detection input. Opt in by setting twitchAdSolutions_disableAdSpoofing=false to re-enable the GQL ad-tracking beacons (video_ad_impression, video_ad_quartile_complete x 4, video_ad_pod_complete).
      SoftReloadNoStrip: true,
      // Issue #129 (mode D): post-ad reload uses SOFT reload when the break stripped no segments (BackupSwapFirst CSAI swap). Hard reload's MediaSource flush is only needed after strip injection (BLANK_MP4/recovery) — on a no-strip break it just pays the desktop black-screen + play-icon teardown for nothing. Default on; set twitchAdSolutions_softReloadNoStrip=false to force the old always-hard behavior.
      ForceAccessTokenPlayerType: "popout",
      GQLDeviceID: null,
      AuthorizationHeader: void 0,
      ClientIntegrityHeader: null,
      ClientVersion: null,
      ClientSession: null
    };
  }
  function pickSharedConfig(source) {
    const config = defaultSharedConfig();
    for (const key of Object.keys(config)) {
      config[key] = source[key];
    }
    return config;
  }

  // src/page/state.ts
  function createPageState() {
    return {
      ...defaultSharedConfig(),
      RecoverFromSilentMute: true,
      // On hard reload, if the element is already muted but vaft has successfully unmuted at any point earlier this session, treat it as a silent Twitch re-mute and recover via the backstop. Default on; set twitchAdSolutions_recoverFromSilentMute=false to disable (useful for users who deliberately mute mid-session).
      DisablePostBreakWedge: false,
      // Post-break video-wedge recovery (mirrors GosuDRM/TTV-AB _checkPostBreakWedge, v12.0.0). Detects "audio running, video frozen" after an ad break — playhead advancing while the decoder emits no new frames — via getVideoPlaybackQuality().totalVideoFrames, which the currentTime-based freeze checks can't see. Default on. Set twitchAdSolutions_disablePostBreakWedge=true to turn it OFF.
      DisableReloadCap: false,
      // If true, buffer monitor reloads unlimited times (pre-v47 behavior, risk of cascade)
      DriftCorrectionRate: 1.1,
      // Playback rate for catching up to live edge after reload (0 = disable drift correction)
      PlayerBufferingFix: true,
      // If true this will pause/play the player when it gets stuck buffering
      PlayerBufferingDelay: 600,
      // How often should we check the player state (in milliseconds)
      PlayerBufferingSameStateCount: 3,
      // How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
      PlayerBufferingDangerZone: 0.5,
      // Lowered 1 → 0.5: at the live edge with thin-but-functional buffer (~0.7-0.95s), the AND check (positionFrozen + bufferDuration < DangerZone) was firing on real momentary stalls — but the pause/play "fix" interacts badly with Twitch's playback-monitor (snaps to "buffered region 0.04xxx"), creating a self-sustaining cascade where each fix degrades currentTime. Lower threshold confines firing to truly-drained buffer states (<0.5s) where intervention is unambiguously needed.
      PlayerBufferingDoPlayerReload: false,
      // If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
      PlayerBufferingMinRepeatDelay: 8e3,
      // Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
      PlayerBufferingPrerollCheckEnabled: false,
      // Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
      PlayerBufferingPrerollCheckOffset: 5
      // How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
    };
  }
  var state = createPageState();
  var runtime = {
    /** Set from the worker's banner updates; the buffer monitor stands down while true. */
    isActivelyStrippingAds: false,
    /** Firefox doesn't allow hooking localStorage; reloads then write the volume/mute keys directly. */
    localStorageHookFailed: false,
    /** Re-acquired on every monitor tick. */
    playerForMonitoringBuffering: null
  };
  var playerBufferState = {
    channelName: null,
    hasStreamStarted: false,
    position: 0,
    bufferedPosition: 0,
    bufferDuration: 0,
    numSame: 0,
    fixAttempts: 0,
    lastFixTime: 0,
    isLive: true,
    lastBackupSwitchAt: 0,
    lastReloadAt: 0,
    recoveryReloadUsed: false,
    userPauseIntent: false,
    loggedPauseIntent: false,
    weJustPaused: 0,
    inAdBreak: false,
    vaftEverUnmuted: false
  };

  // src/page/drift.ts
  var driftCatchUpInterval = null;
  var driftCatchUpTimeout = null;
  function startDriftCorrection(videoElement) {
    if (state.DriftCorrectionRate <= 1) return;
    if (driftCatchUpInterval) {
      clearInterval(driftCatchUpInterval);
      driftCatchUpInterval = null;
    }
    if (driftCatchUpTimeout) {
      clearTimeout(driftCatchUpTimeout);
      driftCatchUpTimeout = null;
    }
    videoElement.playbackRate = state.DriftCorrectionRate;
    console.log("[AD DEBUG] Drift correction: catching up at " + state.DriftCorrectionRate + "x");
    driftCatchUpInterval = setInterval(() => {
      try {
        const vid = getPlayerVideoElement();
        if (vid && vid.buffered.length > 0) {
          if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= 1) {
            vid.playbackRate = 1;
            console.log("[AD DEBUG] Drift correction complete — resumed normal playback speed");
            clearInterval(driftCatchUpInterval ?? void 0);
            driftCatchUpInterval = null;
            if (driftCatchUpTimeout) {
              clearTimeout(driftCatchUpTimeout);
              driftCatchUpTimeout = null;
            }
          }
        }
      } catch {
        clearInterval(driftCatchUpInterval ?? void 0);
        driftCatchUpInterval = null;
      }
    }, 500);
    driftCatchUpTimeout = setTimeout(() => {
      try {
        videoElement.playbackRate = 1;
      } catch {
      }
      if (driftCatchUpInterval) {
        clearInterval(driftCatchUpInterval);
        driftCatchUpInterval = null;
      }
      driftCatchUpTimeout = null;
    }, 3e4);
  }
  function cancelDriftCorrection() {
    if (driftCatchUpInterval || driftCatchUpTimeout) {
      if (driftCatchUpInterval) {
        clearInterval(driftCatchUpInterval);
        driftCatchUpInterval = null;
      }
      if (driftCatchUpTimeout) {
        clearTimeout(driftCatchUpTimeout);
        driftCatchUpTimeout = null;
      }
      try {
        const v = getPlayerVideoElement();
        if (v) v.playbackRate = 1;
      } catch {
      }
    }
  }

  // src/page/workers.ts
  var twitchWorkers = [];
  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach((worker) => {
      worker.postMessage({ key, value });
    });
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
  function doTwitchPlayerTask(isPausePlay, isReload, reloadKind) {
    const playerAndState = getPlayerAndState();
    if (!playerAndState) {
      console.log("Could not find react root");
      return;
    }
    const player = playerAndState.player;
    const playerState = playerAndState.state;
    if (!player) {
      console.log("Could not find player");
      return;
    }
    if (!playerState) {
      console.log("Could not find player state");
      return;
    }
    const wasPaused = player.isPaused() || player.core?.paused;
    if (wasPaused) {
      if (playerBufferState.userPauseIntent) {
        if (!playerBufferState.loggedPauseIntent) {
          playerBufferState.loggedPauseIntent = true;
          console.log("[AD DEBUG] Respecting user pause intent — skipping auto-resume");
        }
        return;
      }
      if (playerBufferState.weJustPaused && Date.now() - playerBufferState.weJustPaused < 1e4) {
        try {
          player.play()?.catch?.(() => {
          });
        } catch {
        }
      }
      return;
    }
    if (!wasPaused) {
      playerBufferState.weJustPaused = 0;
    }
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.numSame = 0;
    if (isPausePlay) {
      player.pause();
      player.play()?.catch?.(() => {
      });
      playerBufferState.weJustPaused = Date.now();
      return;
    }
    if (isReload && document.pictureInPictureElement) {
      player.pause();
      player.play()?.catch?.(() => {
      });
      console.log("[AD DEBUG] Downgraded reload to pause/play to preserve PiP");
      return;
    }
    if (isReload) {
      const video = player.getHTMLVideoElement?.();
      if (video && video.readyState >= 3 && !video.paused && !video.ended) {
        let latencySec = 0;
        let latencyKnown = false;
        try {
          if (video.seekable && video.seekable.length > 0) {
            const seekableEnd = video.seekable.end(video.seekable.length - 1);
            if (Number.isFinite(seekableEnd)) {
              const calc = Math.max(0, seekableEnd - video.currentTime);
              if (calc < 3600) {
                latencySec = calc;
                latencyKnown = true;
              }
            }
          }
        } catch {
        }
        if (!latencyKnown) {
          console.log("[AD DEBUG] Latency unknown (seekable unavailable) — proceeding with reload");
        } else if (latencySec > 7) {
          console.log(
            "[AD DEBUG] Player playing but " + latencySec.toFixed(1) + "s behind live — proceeding with reload to reset latency"
          );
        } else {
          console.log(
            "[AD DEBUG] Skipping reload — player healthy (readyState=" + video.readyState + ", playing, latency=" + latencySec.toFixed(1) + "s)"
          );
          postTwitchWorkerMessage("ReloadSkipped");
          return;
        }
      }
    }
    if (isReload) {
      const lsKeyQuality = "video-quality";
      const lsKeyMuted = "video-muted";
      const lsKeyVolume = "volume";
      const lsKeyLowLatency = "lowLatencyModeEnabled";
      const lsKeyPersistence = "persistenceEnabled";
      let currentQualityLS = null;
      let currentMutedLS = null;
      let currentVolumeLS = null;
      let currentLowLatencyLS = null;
      let currentPersistenceLS = null;
      try {
        currentQualityLS = localStorage.getItem(lsKeyQuality);
        currentMutedLS = localStorage.getItem(lsKeyMuted);
        currentVolumeLS = localStorage.getItem(lsKeyVolume);
        currentLowLatencyLS = localStorage.getItem(lsKeyLowLatency);
        currentPersistenceLS = localStorage.getItem(lsKeyPersistence);
        if (runtime.localStorageHookFailed && player?.core?.state) {
          localStorage.setItem(lsKeyMuted, JSON.stringify({ default: player.core.state.muted }));
          localStorage.setItem(lsKeyVolume, String(player.core.state.volume));
        }
        if (player?.core?.state?.quality?.group) {
          localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
        }
      } catch {
      }
      playerBufferState.lastReloadAt = Date.now();
      playerBufferState.adStallStartAt = 0;
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
          const v = getPlayerVideoElement();
          const wasInitiallyUnmuted = v && !v.muted;
          const shouldRecover = playerBufferState.vaftEverUnmuted && state.RecoverFromSilentMute;
          if (v && (wasInitiallyUnmuted || shouldRecover)) {
            if (wasInitiallyUnmuted) {
              v.muted = true;
            }
            let done = false;
            const restore = () => {
              if (done) return;
              done = true;
              document.removeEventListener("canplay", listener, true);
              document.removeEventListener("playing", listener, true);
              document.removeEventListener("loadeddata", listener, true);
              try {
                const cur = getPlayerVideoElement();
                if (cur) {
                  cur.muted = false;
                  playerBufferState.vaftEverUnmuted = true;
                }
                if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted) {
                  v.muted = false;
                  console.log(
                    "[AD DEBUG] Restore — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248"
                  );
                }
              } catch {
              }
            };
            const listener = (e) => {
              if (e.target && e.target.tagName === "VIDEO") restore();
            };
            document.addEventListener("canplay", listener, true);
            document.addEventListener("playing", listener, true);
            document.addEventListener("loadeddata", listener, true);
            setTimeout(restore, 4e3);
            setTimeout(() => {
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
                if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted && !playerBufferState.userPauseIntent) {
                  v.muted = false;
                  console.log(
                    "[AD DEBUG] Backstop — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248"
                  );
                }
              } catch {
              }
            }, 5500);
          }
        } catch {
        }
      }
      if (hardReload || refreshToken) {
        playerBufferState.weJustPaused = Date.now();
      }
      playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: refreshToken });
      postTwitchWorkerMessage("TriggeredPlayerReload");
      player.play()?.catch?.(() => {
      });
      setTimeout(() => {
        try {
          if (currentQualityLS) {
            localStorage.setItem(lsKeyQuality, currentQualityLS);
          }
          if (currentMutedLS) {
            localStorage.setItem(lsKeyMuted, currentMutedLS);
          }
          if (currentVolumeLS) {
            localStorage.setItem(lsKeyVolume, currentVolumeLS);
          }
          if (currentLowLatencyLS !== null) {
            localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
          }
          if (currentPersistenceLS !== null) {
            localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
          }
          const videos = document.getElementsByTagName("video");
          const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
          if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
            videos[0].muted = false;
          }
          if (videos.length > 0 && videos[0].buffered.length > 0 && videos[0].readyState >= 3) {
            const liveEdge = videos[0].buffered.end(videos[0].buffered.length - 1);
            const drift = liveEdge - videos[0].currentTime;
            if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
              console.log(
                "[AD DEBUG] Post-hard-reload seek to live — " + drift.toFixed(1) + "s behind, jumping to live edge to flush A/V drift"
              );
              videos[0].currentTime = liveEdge;
            } else if (drift > 2) {
              console.log("[AD DEBUG] Post-reload live drift correction: " + drift.toFixed(1) + "s behind");
              startDriftCorrection(videos[0]);
            }
          }
        } catch {
        }
      }, 3e3);
      return;
    }
  }

  // src/page/overlay.ts
  var cachedPlayerRootDiv = null;
  var loggedSdaHide = false;
  function hideTwitchAdOverlays() {
    if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
    const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
    for (let i = 0; i < sdaElements.length; i++) {
      if (!sdaElements[i].dataset.tasHidden) {
        sdaElements[i].dataset.tasHidden = "";
        sdaElements[i].style.setProperty("display", "none", "important");
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
      let adBlockDiv = null;
      adBlockDiv = playerRootDiv.querySelector(".tas-adblock-overlay");
      if (adBlockDiv == null) {
        adBlockDiv = document.createElement("div");
        adBlockDiv.className = "tas-adblock-overlay";
        adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
        adBlockDiv.style.display = "none";
        adBlockDiv.P = adBlockDiv.querySelector("p");
        playerRootDiv.appendChild(adBlockDiv);
      }
      if (adBlockDiv != null) {
        runtime.isActivelyStrippingAds = !!data.isStrippingAdSegments;
        if (adBlockDiv.P)
          adBlockDiv.P.textContent = "Blocking" + (data.isMidroll ? " midroll" : "") + " ads" + (data.isStrippingAdSegments ? " (stripping)" : "") + (data.activeBackupPlayerType ? " (" + data.activeBackupPlayerType + ")" : "");
        adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? "block" : "none";
      }
      if (data.hasAds) {
        hideTwitchAdOverlays();
      }
    }
  }

  // src/page/buffer-monitor.ts
  var visibilityHooked = false;
  var pendingTick = false;
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
            if (!playerBufferState.weJustPaused || Date.now() - playerBufferState.weJustPaused > 2e3) {
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
        const player = runtime.playerForMonitoringBuffering.player;
        const twitchState = runtime.playerForMonitoringBuffering.state;
        if (!player.core) {
          runtime.playerForMonitoringBuffering = null;
        } else if (twitchState.props?.content?.type === "live" && !player.isPaused() && !player.getHTMLVideoElement()?.ended && (player.getHTMLVideoElement()?.readyState ?? 0) >= 1 && playerBufferState.lastFixTime <= Date.now() - state.PlayerBufferingMinRepeatDelay && !runtime.isActivelyStrippingAds && !playerBufferState.inAdBreak && (!playerBufferState.lastReloadAt || Date.now() - playerBufferState.lastReloadAt >= 15e3) && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 1e4)) {
          const m3u8Url = player.core?.state?.path;
          if (m3u8Url) {
            const lastSlash = m3u8Url.lastIndexOf("/");
            const queryStart = m3u8Url.indexOf("?", lastSlash);
            const fileName = m3u8Url.substring(lastSlash + 1, queryStart !== -1 ? queryStart : void 0);
            if (fileName?.endsWith(".m3u8")) {
              const channelName = fileName.slice(0, -5);
              if (playerBufferState.channelName !== channelName) {
                playerBufferState.channelName = channelName;
                playerBufferState.hasStreamStarted = false;
                playerBufferState.numSame = 0;
                playerBufferState.fixAttempts = 0;
                playerBufferState.recoveryReloadUsed = false;
                playerBufferState.userPauseIntent = false;
                playerBufferState.loggedPauseIntent = false;
              }
            }
          }
          if (player.getState() === "Playing") {
            playerBufferState.hasStreamStarted = true;
          }
          const position = player.core?.state?.position;
          const bufferedPosition = player.core?.state?.bufferedPosition;
          const bufferDuration = player.getBufferDuration();
          const videoEl = player.getHTMLVideoElement?.();
          const videoCurrentTime = videoEl?.currentTime;
          if (position !== void 0 && bufferedPosition !== void 0) {
            const playerNotActivelyPlaying = videoEl && (videoEl.readyState < 2 || videoEl.paused);
            if (videoEl && playerBufferState.videoElement && playerBufferState.videoElement !== videoEl) {
              playerBufferState.numSame = 0;
              playerBufferState.fixAttempts = 0;
              playerBufferState.recoveryReloadUsed = false;
            }
            playerBufferState.videoElement = videoEl;
            const positionFrozen = playerBufferState.position === position && (playerBufferState.videoCurrentTime === void 0 || playerBufferState.videoCurrentTime === videoCurrentTime);
            if (playerNotActivelyPlaying) {
            } else if (playerBufferState.hasStreamStarted && (!state.PlayerBufferingPrerollCheckEnabled || position > state.PlayerBufferingPrerollCheckOffset) && // Tighten to AND: a real stall is BOTH frozen position AND a draining buffer.
            // Field reports on Firefox at live edge showed the OR form firing during normal
            // thin-buffer breathing (~1-2s buffered, currentTime briefly idle waiting on a
            // segment fetch) — pause/play would then knock the player back to readyState=1
            // and currentTime=0, snowballing into a self-reinforcing reload cascade. With
            // AND, real stalls (frozen + buffer drained below DangerZone) still fire on the
            // same poll cadence; healthy thin-buffer feeds no longer trip it.
            positionFrozen && bufferDuration < state.PlayerBufferingDangerZone && playerBufferState.bufferedPosition === bufferedPosition && playerBufferState.bufferDuration >= bufferDuration && (position !== 0 || bufferedPosition !== 0 || bufferDuration !== 0)) {
              playerBufferState.numSame++;
              if (playerBufferState.numSame === state.PlayerBufferingSameStateCount) {
                playerBufferState.fixAttempts++;
                const wouldEscalate = playerBufferState.fixAttempts >= 3;
                const escalateToReload = wouldEscalate && (state.DisableReloadCap || !playerBufferState.recoveryReloadUsed);
                const reloadCapNote = wouldEscalate && !escalateToReload ? " (reload cap reached, pause/play only — set twitchAdSolutions_disableReloadCap=true to bypass)" : escalateToReload ? " (escalating to reload)" : "";
                console.log(
                  "Attempt to fix buffering position:" + playerBufferState.position + " bufferedPosition:" + playerBufferState.bufferedPosition + " bufferDuration:" + playerBufferState.bufferDuration + reloadCapNote
                );
                const video = player.getHTMLVideoElement?.();
                if (video && video.buffered.length > 1) {
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
                if (video) {
                  console.log(
                    "[AD DEBUG] Video state: readyState=" + video.readyState + " networkState=" + video.networkState + " buffered=" + (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0) + " currentTime=" + video.currentTime.toFixed(1) + " paused=" + video.paused
                  );
                }
                const isPausePlay = escalateToReload ? false : !state.PlayerBufferingDoPlayerReload;
                const isReload = escalateToReload ? true : state.PlayerBufferingDoPlayerReload;
                doTwitchPlayerTask(isPausePlay, isReload);
                playerBufferState.lastFixTime = Date.now();
                playerBufferState.numSame = 0;
                if (escalateToReload) {
                  playerBufferState.fixAttempts = 0;
                  playerBufferState.recoveryReloadUsed = true;
                }
              }
            } else {
              playerBufferState.numSame = 0;
              playerBufferState.fixAttempts = 0;
              playerBufferState.recoveryReloadUsed = false;
            }
            if (playerBufferState.position > 0 && position - playerBufferState.position > 5 && !playerBufferState.inAdBreak && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 1e4) && (!playerBufferState.lastDriftStartedAt || Date.now() - playerBufferState.lastDriftStartedAt >= 3e4)) {
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
          } else {
            playerBufferState.numSame = 0;
          }
        }
      } catch (err) {
        console.error("error when monitoring player for buffering: " + err);
        runtime.playerForMonitoringBuffering = null;
      }
    }
    {
      const wedgeInAd = !!playerBufferState.inAdBreak;
      if (playerBufferState.wedgePrevInAdBreak && !wedgeInAd) {
        playerBufferState.wedgeEvalsRemaining = 40;
        playerBufferState.wedgeLastTime = -1;
        playerBufferState.wedgeLastFrames = -1;
        playerBufferState.wedgeEvidence = 0;
        playerBufferState.wedgeHealthy = 0;
        playerBufferState.wedgeActions = 0;
      }
      playerBufferState.wedgePrevInAdBreak = wedgeInAd;
      if (!state.DisablePostBreakWedge && !wedgeInAd && (playerBufferState.wedgeEvalsRemaining || 0) > 0 && !playerBufferState.userPauseIntent && runtime.playerForMonitoringBuffering && runtime.playerForMonitoringBuffering.state?.props?.content?.type === "live") {
        try {
          const wv = runtime.playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
          if (wv && !wv.ended && !wv.paused && wv.videoWidth > 0 && (wv.readyState ?? 0) >= 2 && typeof wv.getVideoPlaybackQuality === "function") {
            let totalFrames = -1;
            try {
              totalFrames = Number(wv.getVideoPlaybackQuality()?.totalVideoFrames);
            } catch {
            }
            if (Number.isFinite(totalFrames) && totalFrames >= 0) {
              const t = wv.currentTime || 0;
              const prevT = playerBufferState.wedgeLastTime ?? -1;
              const prevF = playerBufferState.wedgeLastFrames ?? -1;
              playerBufferState.wedgeLastTime = t;
              playerBufferState.wedgeLastFrames = totalFrames;
              if (prevT >= 0 && prevF >= 0 && t > prevT + 0.3) {
                playerBufferState.wedgeEvalsRemaining = (playerBufferState.wedgeEvalsRemaining || 0) - 1;
                const framesDelta = totalFrames - prevF;
                if (framesDelta < 0) {
                  playerBufferState.wedgeEvidence = 0;
                  playerBufferState.wedgeHealthy = 0;
                } else if (framesDelta >= 5) {
                  playerBufferState.wedgeEvidence = 0;
                  playerBufferState.wedgeHealthy = (playerBufferState.wedgeHealthy || 0) + 1;
                  if (playerBufferState.wedgeHealthy >= 3) playerBufferState.wedgeEvalsRemaining = 0;
                } else if (framesDelta <= 1) {
                  playerBufferState.wedgeHealthy = 0;
                  playerBufferState.wedgeEvidence = (playerBufferState.wedgeEvidence || 0) + 1;
                  if (playerBufferState.wedgeEvidence >= 6) {
                    playerBufferState.wedgeEvidence = 0;
                    playerBufferState.wedgeActions = (playerBufferState.wedgeActions || 0) + 1;
                    const wedgeReload = playerBufferState.wedgeActions >= 2;
                    const recentReload = playerBufferState.lastReloadAt && Date.now() - playerBufferState.lastReloadAt < 15e3;
                    console.log(
                      "[AD DEBUG] Post-break video wedge — playhead advancing at " + t.toFixed(1) + "s but only " + Math.max(0, framesDelta) + " decoded frame(s) over " + (t - prevT).toFixed(1) + "s (audio-alive/video-frozen after break) — " + (wedgeReload ? "hard reload" : "pause/play nudge") + " (mirrors TTV-AB v12.0.0)"
                    );
                    if (wedgeReload) {
                      playerBufferState.wedgeEvalsRemaining = 0;
                      if (!recentReload) {
                        doTwitchPlayerTask(false, true, "early");
                      } else {
                        console.log(
                          "[AD DEBUG] Post-break wedge reload SUPPRESSED — a reload fired <15s ago; relying on it"
                        );
                      }
                    } else {
                      doTwitchPlayerTask(true, false);
                    }
                    playerBufferState.lastFixTime = Date.now();
                  }
                } else {
                  playerBufferState.wedgeHealthy = 0;
                }
              }
            }
          }
        } catch {
        }
      }
    }
    if (runtime.isActivelyStrippingAds && runtime.playerForMonitoringBuffering) {
      try {
        const player = runtime.playerForMonitoringBuffering.player;
        const video = player?.getHTMLVideoElement?.();
        if (video && !video.ended && !playerBufferState.userPauseIntent) {
          if (video.readyState >= 3) {
            playerBufferState.hasHadData = true;
          }
          const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
          const stallReloadCooldown = 15e3;
          const cooldownExpired = !playerBufferState.lastAdStallReloadAt || Date.now() - playerBufferState.lastAdStallReloadAt > stallReloadCooldown;
          const recentReload = playerBufferState.lastReloadAt && Date.now() - playerBufferState.lastReloadAt < stallReloadCooldown;
          if (isStalled && cooldownExpired && !recentReload && playerBufferState.hasHadData) {
            if (!playerBufferState.adStallStartAt) {
              playerBufferState.adStallStartAt = Date.now();
            } else if (Date.now() - playerBufferState.adStallStartAt > 3e3) {
              console.log(
                "[AD DEBUG] Loading circle detected during ad break (" + ((Date.now() - playerBufferState.adStallStartAt) / 1e3).toFixed(1) + "s stall, readyState=" + video.readyState + ") — early reload"
              );
              playerBufferState.lastAdStallReloadAt = Date.now();
              playerBufferState.adStallStartAt = 0;
              doTwitchPlayerTask(false, true, "early");
            }
          } else if (!isStalled) {
            playerBufferState.adStallStartAt = 0;
          }
        }
      } catch {
      }
    } else if (!runtime.isActivelyStrippingAds && playerBufferState.adStallStartAt) {
      playerBufferState.adStallStartAt = 0;
    }
    const isLive = runtime.playerForMonitoringBuffering?.state?.props?.content?.type === "live";
    if (playerBufferState.isLive && !isLive) {
      updateAdblockBanner({
        hasAds: false
      });
    }
    playerBufferState.isLive = isLive;
    if (typeof document !== "undefined" && !visibilityHooked) {
      visibilityHooked = true;
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
    try {
      hideTwitchAdOverlays();
    } catch {
    }
    const shouldThrottle = typeof document !== "undefined" && document.hidden && !document.pictureInPictureElement && !playerBufferState.inAdBreak;
    const nextDelay = shouldThrottle ? state.PlayerBufferingDelay * 3 : state.PlayerBufferingDelay;
    setTimeout(monitorPlayerBuffering, nextDelay);
  }

  // src/page/mask.ts
  function maskAsNative(fn, name) {
    fn.toString = () => "function " + name + "() { [native code] }";
    return fn;
  }

  // src/page/fetch-hook.ts
  var csaiRequestCounts = /* @__PURE__ */ Object.create(null);
  function countCsaiRequest(csaiType, transport) {
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
  function hookFetch() {
    console.log("[AD DEBUG] Window fetch hook installed");
    let hasLoggedHeaders = false;
    const realFetch = window.fetch;
    window.realFetch = realFetch;
    window.fetch = maskAsNative(function(url, init) {
      if (typeof url === "string") {
        if (url.includes("gql")) {
          const headers = init?.headers || {};
          let deviceId = headers["X-Device-Id"];
          if (typeof deviceId !== "string") {
            deviceId = headers["Device-ID"];
          }
          if (typeof deviceId === "string" && state.GQLDeviceID !== deviceId) {
            state.GQLDeviceID = deviceId;
            postTwitchWorkerMessage("UpdateDeviceId", state.GQLDeviceID);
          }
          const headerClientVersion = headers["Client-Version"];
          if (typeof headerClientVersion === "string" && headerClientVersion !== state.ClientVersion) {
            state.ClientVersion = headerClientVersion;
            postTwitchWorkerMessage("UpdateClientVersion", state.ClientVersion);
          }
          const headerClientSession = headers["Client-Session-Id"];
          if (typeof headerClientSession === "string" && headerClientSession !== state.ClientSession) {
            state.ClientSession = headerClientSession;
            postTwitchWorkerMessage("UpdateClientSession", state.ClientSession);
          }
          const headerClientIntegrityHeader = headers["Client-Integrity"];
          if (typeof headerClientIntegrityHeader === "string" && headerClientIntegrityHeader !== state.ClientIntegrityHeader) {
            state.ClientIntegrityHeader = headerClientIntegrityHeader;
            postTwitchWorkerMessage("UpdateClientIntegrityHeader", state.ClientIntegrityHeader);
          }
          const headerAuthorizationHeader = headers["Authorization"];
          if (typeof headerAuthorizationHeader === "string" && headerAuthorizationHeader !== state.AuthorizationHeader) {
            state.AuthorizationHeader = headerAuthorizationHeader;
            postTwitchWorkerMessage("UpdateAuthorizationHeader", state.AuthorizationHeader);
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
          const csaiType = url.includes("bp=midroll") ? "midroll" : url.includes("bp=preroll") ? "preroll" : "unknown";
          countCsaiRequest(csaiType, "fetch");
        }
      }
      return realFetch.apply(this, arguments);
    }, "fetch");
  }
  function hookXhr() {
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function(_method, url) {
      if (typeof url === "string" && url.includes("edge.ads.twitch.tv")) {
        const csaiType = url.includes("bp=midroll") ? "midroll" : url.includes("bp=preroll") ? "preroll" : "unknown";
        countCsaiRequest(csaiType, "xhr");
      }
      return realXHROpen.apply(this, arguments);
    }, "open");
  }

  // src/page/storage.ts
  function onContentLoaded() {
    if (document.getElementById("seventv-extension")) {
      console.log(
        "[AD DEBUG] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV."
      );
    }
    let wasVideoPlaying = true;
    const visibilityChange = () => {
      const videos = document.getElementsByTagName("video");
      if (videos.length === 0) return;
      if (document.hidden) {
        wasVideoPlaying = !videos[0].paused && !videos[0].ended;
        return;
      }
      if (!playerBufferState.hasStreamStarted) {
        playerBufferState.hasStreamStarted = true;
      }
      if (wasVideoPlaying && !videos[0].ended && videos[0].paused) {
        videos[0].play()?.catch?.(() => {
        });
      }
    };
    document.addEventListener("visibilitychange", visibilityChange);
    try {
      const keysToCache = [
        "video-quality",
        "video-muted",
        "volume",
        "lowLatencyModeEnabled",
        // Low Latency
        "persistenceEnabled"
        // Mini Player
      ];
      const cachedValues = /* @__PURE__ */ new Map();
      for (let i = 0; i < keysToCache.length; i++) {
        cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
      }
      const realSetItem = localStorage.setItem;
      localStorage.setItem = maskAsNative(function(key, value) {
        if (cachedValues.has(key)) {
          cachedValues.set(key, value);
        }
        realSetItem.apply(this, arguments);
      }, "setItem");
      const realGetItem = localStorage.getItem;
      localStorage.getItem = maskAsNative(function(key) {
        if (cachedValues.has(key)) {
          return cachedValues.get(key);
        }
        return realGetItem.apply(this, arguments);
      }, "getItem");
      if (localStorage.getItem === realGetItem) {
        runtime.localStorageHookFailed = true;
      }
    } catch (err) {
      console.log("localStorageHooks failed " + err);
      runtime.localStorageHookFailed = true;
    }
  }
  function loadLocalStorageConfig() {
    try {
      const lsReloadAfterAd = localStorage.getItem("twitchAdSolutions_reloadPlayerAfterAd");
      if (lsReloadAfterAd !== null) {
        state.ReloadPlayerAfterAd = lsReloadAfterAd === "true";
      }
      const lsReloadCooldown = parseInt(localStorage.getItem("twitchAdSolutions_reloadCooldownSeconds") ?? "", 10);
      if (!Number.isNaN(lsReloadCooldown) && lsReloadCooldown >= 0) {
        state.ReloadCooldownSeconds = lsReloadCooldown;
      }
      const lsDisableReloadCap = localStorage.getItem("twitchAdSolutions_disableReloadCap");
      if (lsDisableReloadCap !== null) {
        state.DisableReloadCap = lsDisableReloadCap === "true";
      }
      const lsDriftRate = parseFloat(localStorage.getItem("twitchAdSolutions_driftCorrectionRate") ?? "");
      if (!Number.isNaN(lsDriftRate) && lsDriftRate >= 0) {
        state.DriftCorrectionRate = lsDriftRate;
      }
      const lsEarlyReload = parseInt(localStorage.getItem("twitchAdSolutions_earlyReloadPollThreshold") ?? "", 10);
      if (!Number.isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
        state.EarlyReloadPollThreshold = lsEarlyReload;
      }
      const lsPlayerType = localStorage.getItem("twitchAdSolutions_playerType");
      if (lsPlayerType !== null) {
        state.ForceAccessTokenPlayerType = lsPlayerType;
      }
      const lsPinBackup = localStorage.getItem("twitchAdSolutions_pinBackupPlayerType");
      if (lsPinBackup !== null) {
        state.PinBackupPlayerType = lsPinBackup === "true";
      }
      const lsPreferLow = localStorage.getItem("twitchAdSolutions_preferLowQualityBackup");
      if (lsPreferLow === "false") {
        state.PreferLowQualityBackup = false;
        console.log(
          "[AD DEBUG] PreferLowQualityBackup disabled via localStorage — sticky CSAI path only, no autoplay fallback or escape hatch"
        );
      }
      const lsFastAutoplay = localStorage.getItem("twitchAdSolutions_fastAutoplayFirstTry");
      if (lsFastAutoplay === "false") {
        state.FastAutoplayFirstTry = false;
        console.log(
          "[AD DEBUG] FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)"
        );
      }
      const lsBackupSwapFirst = localStorage.getItem("twitchAdSolutions_backupSwapFirst");
      if (lsBackupSwapFirst === "false") {
        state.BackupSwapFirst = false;
        console.log(
          "[AD DEBUG] BackupSwapFirst disabled via localStorage — using sticky CSAI path (strip on native stream)"
        );
      }
      const lsDisableAdSpoofing = localStorage.getItem("twitchAdSolutions_disableAdSpoofing");
      if (lsDisableAdSpoofing === "false") {
        state.DisableAdSpoofing = false;
        console.log(
          "[AD DEBUG] AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect"
        );
      }
      const lsRecoverFromSilentMute = localStorage.getItem("twitchAdSolutions_recoverFromSilentMute");
      if (lsRecoverFromSilentMute === "false") {
        state.RecoverFromSilentMute = false;
        console.log(
          "[AD DEBUG] RecoverFromSilentMute disabled via localStorage — hard-reload backstop respects already-muted state, mid-session manual mutes preserved across reloads"
        );
      }
      const lsSoftReloadNoStrip = localStorage.getItem("twitchAdSolutions_softReloadNoStrip");
      if (lsSoftReloadNoStrip === "false") {
        state.SoftReloadNoStrip = false;
        console.log(
          "[AD DEBUG] SoftReloadNoStrip disabled via localStorage — post-ad reload always hard, even on no-strip CSAI breaks (issue #129)"
        );
      }
      const lsDisablePostBreakWedge = localStorage.getItem("twitchAdSolutions_disablePostBreakWedge");
      if (lsDisablePostBreakWedge === "true") {
        state.DisablePostBreakWedge = true;
        console.log(
          "[AD DEBUG] Post-break video-wedge recovery DISABLED via localStorage — audio-alive/video-frozen after a break will not be auto-recovered"
        );
      }
      const lsHideAdOverlay = localStorage.getItem("twitchAdSolutions_hideAdOverlay");
      if (lsHideAdOverlay === "true") {
        const style = document.createElement("style");
        style.textContent = ".tas-adblock-overlay { display: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      }
    } catch {
    }
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

  // src/shared/config.ts
  function defaultSharedConfig() {
    return {
      ReloadPlayerAfterAd: true,
      // After the ad finishes do a player reload instead of pause/play
      ReloadCooldownSeconds: 30,
      // Minimum seconds between reloads — breaks CSAI cascades triggered by reload
      EarlyReloadPollThreshold: 3,
      // Number of consecutive all-stripped polls before triggering early reload (each poll ~2s, so 3 = ~6s, 5 = ~10s, 10 = ~20s; 0 = disable). Lowered from 5 to 3 to match the testing variant — field reports indicate faster early-reload recovers heavier SSAI breaks more cleanly. Override via localStorage twitchAdSolutions_earlyReloadPollThreshold.
      PinBackupPlayerType: true,
      // Remember which backup player type worked and try it first on next ad break
      PreferLowQualityBackup: true,
      // Hybrid safety net for SSAI-heavy breaks: sticky escape hatch (fires after ~8s stuck in all-stripped state) + autoplay (360p) as last-resort backup when all Source types are ad-laden. Default on; set twitchAdSolutions_preferLowQualityBackup=false to disable.
      FastAutoplayFirstTry: true,
      // When the prior break committed autoplay-via-escape-hatch, prepend autoplay (360p) to position 0 of playerTypesToTry on the next break — autoplay wins on first probe (~340ms) instead of cycling through 4 Source types (~1.5-2s). Auto-resets when a Source-tier type wins (channel recovered), so quality returns to full automatically if Twitch ever brings back non-ad-laden Source backups. Default on as of v67.1.0 — field data (project_all_channels_csai_only_marked) confirms every observed channel exhausts Source-tier on every break. Opt-out via localStorage twitchAdSolutions_fastAutoplayFirstTry=false.
      BackupSwapFirst: true,
      // On ad detect, immediately swap to a backup player-type m3u8 (TTV-AB-style). Avoids MediaSource mixing from strip activity — fewer loading circles in field. Cost: extra fetches on every ad break. Default on; set twitchAdSolutions_backupSwapFirst=false to disable.
      DisableAdSpoofing: true,
      // Default OFF (was ON through v68.2.0). The always-100%-watched + audible + visible spoof beacon pattern may itself fingerprint as anomalous and trigger detection escalation (CSAI reaching the committed backup) — observed correlation in field + TTV-AB maintainer hypothesis. Spoof-accepted (no GQL rejection) does NOT prove not-fingerprinted; Twitch can 200-OK while using the beacon pattern as silent detection input. Opt in by setting twitchAdSolutions_disableAdSpoofing=false to re-enable the GQL ad-tracking beacons (video_ad_impression, video_ad_quartile_complete x 4, video_ad_pod_complete).
      SoftReloadNoStrip: true,
      // Issue #129 (mode D): post-ad reload uses SOFT reload when the break stripped no segments (BackupSwapFirst CSAI swap). Hard reload's MediaSource flush is only needed after strip injection (BLANK_MP4/recovery) — on a no-strip break it just pays the desktop black-screen + play-icon teardown for nothing. Default on; set twitchAdSolutions_softReloadNoStrip=false to force the old always-hard behavior.
      ForceAccessTokenPlayerType: "popout",
      GQLDeviceID: null,
      AuthorizationHeader: void 0,
      ClientIntegrityHeader: null,
      ClientVersion: null,
      ClientSession: null
    };
  }

  // src/worker/state.ts
  function createWorkerState() {
    return {
      ...defaultSharedConfig(),
      // 'twitch-stitched' catches the twitch-stitched-* DATERANGE class family
      // (-ad, -mid, -pod, etc.) without requiring an exact -ad suffix. Twitch-
      // prefixed so we don't re-introduce the PR #120 false-positive from bare
      // 'stitched' substring match. The specific twitch-stitched-ad DATERANGE
      // marker is a subset of this prefix.
      /** Substrings that mark an m3u8 as carrying ads. */
      AdSignifiers: [
        "stitched-ad",
        "EXT-X-CUE-OUT",
        "twitch-stitched",
        'EXT-X-DATERANGE:CLASS="twitch-maf-ad"',
        'EXT-X-DATERANGE:CLASS="twitch-trigger"'
      ],
      // DATERANGE classes confirmed as session/source metadata over weeks of field
      // observation — surface as "candidates" otherwise. Filtered out by the candidate
      // logger so the diagnostic stays focused on genuinely new markers.
      KnownNonAdSignifiers: ["twitch-session", "twitch-stream-source", "twitch-ad-quartile", "twitch-assignment"],
      /** Segment URL substrings that identify ad segments. */
      AdSegmentURLPatterns: ["/adsquared/", "/_404/", "/processing"],
      // Precompiled regexes shared across the stripAdSegments hot path, so literals
      // inside the per-line strip loop don't recompile on every iteration — for
      // a 100-line m3u8 at ~2 polls/sec during an ad break, hoisting the URL
      // rewrite alone saves ~200 regex compilations per second.
      TwitchAdUrlRewriteRegex: /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g,
      UriAttributeRegex: /URI="([^"]+)"/,
      ClientID: "kimne78kx3ncx6brgo4mv6wki5h1ko",
      /** Player types tried, in order, when searching for an ad-free backup stream. */
      BackupPlayerTypes: [
        // Order matters: first clean type wins. 'embed' moved to end — field-observed
        // Twitch returns GQL 'server error' for streamPlaybackAccessToken on embed when
        // requested from twitch.tv origin, wasting ~200-400ms per break as first-try.
        // Kept in case it ever succeeds on some channel/user combo.
        "site",
        //Source
        "popout",
        //Source
        "mobile_web",
        //Mobile
        "embed"
        //Source (unreliable — see note above)
        // 'autoplay' (360p) removed: when committed as cycle backup, the player gets stuck
        // in an endless loading circle after the CSAI-only path releases the backup —
        // autoplay variants don't transition cleanly back to main stream variants.
      ],
      FallbackPlayerType: "site",
      // was 'embed' — site is more reliable when all Source types end up ad-laden
      SkipPlayerReloadOnHevc: false,
      // If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers). Despite the name, gates BOTH enhanced families (HEVC and AV1) since v68.5.3.
      AlwaysReloadPlayerOnAd: false,
      // Always pause/play when entering/leaving ads
      PlayerReloadMinimalRequestsTime: 1500,
      PlayerReloadMinimalRequestsPlayerIndex: 2,
      //autoplay
      HasTriggeredPlayerReload: false,
      /** Channel name -> stream state. */
      StreamInfos: /* @__PURE__ */ Object.create(null),
      /** Variant playlist URL -> owning stream state. */
      StreamInfosByUrl: /* @__PURE__ */ Object.create(null),
      SimulatedAdsDepth: 0,
      V2API: false,
      IsAdStrippingEnabled: true,
      /** Ad segment URL -> time it was cached (ms). The worker fetch hook answers these with a blank MP4. */
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
  function stripAdSegments(textStr, stripAllSegments, streamInfo) {
    let hasStrippedAdSegments = false;
    let inCueOut = false;
    const liveSegments = [];
    const lines = textStr.split(/\r?\n/);
    const newAdUrl = "https://twitch.tv";
    if (!streamInfo.HasLoggedAdAttributes) {
      const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
      if (adAttrs && adAttrs.length > 0) {
        streamInfo.HasLoggedAdAttributes = true;
        console.log("[AD DEBUG] Ad tracking attributes seen: " + [...new Set(adAttrs)].join(", "));
      }
    }
    if (!streamInfo.HasLoggedUnknownSignifiers) {
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
        streamInfo.HasLoggedUnknownSignifiers = true;
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
      lines[i] = line.replaceAll(state.TwitchAdUrlRewriteRegex, `$1${newAdUrl}$2`);
      const isLiveSegment = line.includes(",live");
      if (i < lines.length - 1 && line.startsWith("#EXTINF") && (!isLiveSegment || stripAllSegments || state.AllSegmentsAreAdSegments || inCueOut)) {
        const segmentUrl = lines[i + 1];
        if (!state.AdSegmentCache.has(segmentUrl)) {
          streamInfo.NumStrippedAdSegments++;
        }
        state.AdSegmentCache.set(segmentUrl, Date.now());
        hasStrippedAdSegments = true;
      } else if (i < lines.length - 1 && line.startsWith("#EXTINF") && state.AdSegmentURLPatterns.some((p) => lines[i + 1].includes(p))) {
        console.log("[AD DEBUG] Ad segment detected via URL pattern: " + lines[i + 1]);
        state.AdSegmentCache.set(lines[i + 1], Date.now());
        hasStrippedAdSegments = true;
        streamInfo.NumStrippedAdSegments++;
      } else if (i < lines.length - 1 && line.startsWith("#EXTINF") && isLiveSegment) {
        liveSegments.push({ extinf: line, url: lines[i + 1] });
      } else if (line.startsWith("#EXT-X-PART:")) {
        const partUriMatch = line.match(state.UriAttributeRegex);
        const partUri = partUriMatch ? partUriMatch[1] : "";
        if (partUri && (state.AdSegmentCache.has(partUri) || state.AdSegmentURLPatterns.some((p) => partUri.includes(p)))) {
          state.AdSegmentCache.set(partUri, Date.now());
          lines[i] = "";
          hasStrippedAdSegments = true;
        }
      } else if (line.startsWith("#EXT-X-TWITCH-PREFETCH:") || line.startsWith("#EXT-X-PRELOAD-HINT:")) {
        let hintUrl = "";
        if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) {
          hintUrl = line.substring("#EXT-X-TWITCH-PREFETCH:".length).trim();
        } else {
          const hintMatch = line.match(/URI="([^"]+)"/);
          hintUrl = hintMatch ? hintMatch[1] : "";
        }
        if (hintUrl && (state.AdSegmentCache.has(hintUrl) || state.AdSegmentURLPatterns.some((p) => hintUrl.includes(p)))) {
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
        if (lines[i].startsWith("#EXT-X-TWITCH-PREFETCH:") || lines[i].startsWith("#EXT-X-PRELOAD-HINT:")) {
          lines[i] = "";
        }
      }
    } else {
      streamInfo.NumStrippedAdSegments = 0;
    }
    if (liveSegments.length > 0) {
      streamInfo.RecoverySegments = liveSegments.slice(-6);
      const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1], 10);
      if (!Number.isNaN(seq)) {
        streamInfo.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - streamInfo.RecoverySegments.length);
      }
    }
    if (hasStrippedAdSegments && liveSegments.length === 0) {
      streamInfo.ConsecutiveAllStrippedPolls = (streamInfo.ConsecutiveAllStrippedPolls || 0) + 1;
      streamInfo.TotalAllStrippedPolls = (streamInfo.TotalAllStrippedPolls || 0) + 1;
      if (!streamInfo.FreezeStartedAt) streamInfo.FreezeStartedAt = Date.now();
      const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? Date.now() - streamInfo.LastCleanNativePlaylistAt : Infinity;
      const recentReloadReentry = streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < 8e3;
      if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !recentReloadReentry && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
        console.log(
          "[AD DEBUG] All segments stripped — reusing last clean native playlist (" + snapshotAge + "ms old)"
        );
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        return streamInfo.LastCleanNativeM3U8;
      }
      if (streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
        console.log(
          "[AD DEBUG] All segments stripped — restoring " + streamInfo.RecoverySegments.length + " recovery segments"
        );
        if (streamInfo.RecoveryStartSeq !== void 0) {
          for (let j = 0; j < lines.length; j++) {
            if (lines[j].startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
              lines[j] = "#EXT-X-MEDIA-SEQUENCE:" + streamInfo.RecoveryStartSeq;
              break;
            }
          }
        }
        for (let j = 0; j < streamInfo.RecoverySegments.length; j++) {
          lines.push(streamInfo.RecoverySegments[j].extinf);
          lines.push(streamInfo.RecoverySegments[j].url);
        }
      }
    } else if (liveSegments.length > 0) {
      streamInfo.ConsecutiveAllStrippedPolls = 0;
    }
    streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
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
  function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
    const encodingsLines = encodingsM3u8.split(/\r?\n/);
    const [targetWidth, targetHeight] = resolutionInfo.Resolution.split("x").map(Number);
    let matchedResolutionUrl = null;
    let matchedFrameRate = false;
    let closestResolutionUrl = null;
    let closestResolutionDifference = Infinity;
    for (let i = 0; i < encodingsLines.length - 1; i++) {
      const nextLine = encodingsLines[i + 1]?.trim();
      if (encodingsLines[i].startsWith("#EXT-X-STREAM-INF") && nextLine && !nextLine.startsWith("#") && (nextLine.includes(".m3u8") || nextLine.includes("://"))) {
        const attributes = parseAttributes(encodingsLines[i]);
        const resolution = attributes["RESOLUTION"];
        const frameRate = attributes["FRAME-RATE"];
        if (resolution) {
          if (resolution === resolutionInfo.Resolution && (!matchedResolutionUrl || !matchedFrameRate && frameRate === resolutionInfo.FrameRate)) {
            matchedResolutionUrl = encodingsLines[i + 1];
            matchedFrameRate = frameRate === resolutionInfo.FrameRate;
            if (matchedFrameRate) {
              return matchedResolutionUrl;
            }
          }
          const [width, height] = resolution.split("x").map(Number);
          const difference = Math.abs(width * height - targetWidth * targetHeight);
          if (difference < closestResolutionDifference) {
            closestResolutionUrl = encodingsLines[i + 1];
            closestResolutionDifference = difference;
          }
        }
      }
    }
    return closestResolutionUrl;
  }

  // src/worker/post.ts
  function postToPage(message) {
    postMessage(message);
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
  function notifyAdComplete(textStr, streamInfo) {
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
      const spoofedSet = streamInfo && streamInfo.SpoofedAdIds || null;
      const podLenMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
      const podLength = podLenMatch ? parseInt(podLenMatch[1], 10) : matches.length;
      if (spoofedSet && spoofedSet.size >= podLength) {
        return;
      }
      let newSpoofed = 0;
      let firstRollType = "";
      let podCompleteSent = false;
      for (let i = 0; i < matches.length; i++) {
        const idMatch = matches[i][1].match(/^ID="([^"]+)"/);
        const stitchedAdId = idMatch ? idMatch[1] : "";
        if (spoofedSet && stitchedAdId && spoofedSet.has(stitchedAdId)) {
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
        if (spoofedSet && stitchedAdId) spoofedSet.add(stitchedAdId);
        const batch = [
          makePacket("video_ad_impression"),
          makePacket("video_ad_quartile_complete", { quartile: 1 }),
          makePacket("video_ad_quartile_complete", { quartile: 2 }),
          makePacket("video_ad_quartile_complete", { quartile: 3 }),
          makePacket("video_ad_quartile_complete", { quartile: 4 })
        ];
        if (!spoofedSet || spoofedSet.size === podLength) {
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
        const total = spoofedSet ? spoofedSet.size : newSpoofed;
        const src = streamInfo && streamInfo.ActiveBackupPlayerType || "primary";
        console.log(
          "[AD DEBUG] Spoofed ad completion for " + newSpoofed + " new ad(s) (" + total + "/" + podLength + " pod) — roll: " + firstRollType + ", src: " + src + ", pod-complete: " + (podCompleteSent ? "yes" : "no")
        );
      }
    } catch (err) {
      console.log("[AD DEBUG] Ad completion spoof failed: " + err.message);
    }
  }

  // src/worker/m3u8.ts
  async function processM3U8(url, textStr, realFetch) {
    const streamInfo = state.StreamInfosByUrl[url];
    if (!streamInfo) {
      return textStr;
    }
    streamInfo.LastSeenAt = Date.now();
    if (state.HasTriggeredPlayerReload) {
      state.HasTriggeredPlayerReload = false;
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
    if (!haveAdTags && !streamInfo.IsShowingAd && textStr.indexOf("#EXTINF") !== -1) {
      streamInfo.LastCleanNativeM3U8 = textStr;
      streamInfo.LastCleanNativePlaylistAt = Date.now();
    }
    if (haveAdTags) {
      const adEndStalenessMs = 12e3;
      if (streamInfo.PendingAdEndAt && Date.now() - streamInfo.PendingAdEndAt < adEndStalenessMs) {
        streamInfo.AdEndBounceCount = (streamInfo.AdEndBounceCount || 0) + 1;
      } else {
        streamInfo.PendingAdEndAt = 0;
        streamInfo.AdEndBounceCount = 0;
      }
      streamInfo.CleanPlaylistCount = 0;
      streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
      if (!streamInfo.IsShowingAd) {
        streamInfo.IsShowingAd = true;
        streamInfo.AdBreakStartedAt = Date.now();
        const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
        const podLength = podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1;
        streamInfo.PodLength = podLength;
        streamInfo.EarlyReloadTriggered = false;
        streamInfo.EarlyReloadCount = 0;
        streamInfo.EarlyReloadAtPoll = 0;
        streamInfo.HasConfirmedAdAttrs = textStr.includes("X-TV-TWITCH-AD-AD-SESSION-ID") || textStr.includes("X-TV-TWITCH-AD-RADS-TOKEN");
        streamInfo.CycleRescuedThisBreak = false;
        streamInfo.LastCommittedBackupPlayerType = null;
        streamInfo.FreezeStartedAt = 0;
        streamInfo.CsaiOnlyThisBreak = false;
        console.log(
          "[AD DEBUG] Ad detected — type: " + (streamInfo.IsMidroll ? "midroll" : "preroll") + ", channel: " + streamInfo.ChannelName + ", pod: " + podLength + " ad(s) (~" + podLength * 30 + "s expected), signifiers: " + getMatchedAdSignifiers(textStr).join(", ")
        );
        postToPage({
          key: "UpdateAdBlockBanner",
          isMidroll: streamInfo.IsMidroll,
          hasAds: streamInfo.IsShowingAd,
          isStrippingAdSegments: false
        });
      }
      if (!state.DisableAdSpoofing) {
        setTimeout(() => notifyAdComplete(textStr, streamInfo), 0);
      }
      if (!streamInfo.IsMidroll) {
        const lines = textStr.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("#EXTINF") && lines.length > i + 1) {
            if (!line.includes(",live") && !streamInfo.RequestedAds.has(lines[i + 1])) {
              streamInfo.RequestedAds.add(lines[i + 1]);
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
        return stripAdSegments(textStr, false, streamInfo);
      }
      const currentCodecFamily = videoCodecFamily(currentResolution.Codecs);
      const isEnhanced = currentCodecFamily === "hevc" || currentCodecFamily === "av1";
      const postAdReentryGuardMs = 8e3;
      const recentlyReloaded = streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < postAdReentryGuardMs;
      if ((isEnhanced && !state.SkipPlayerReloadOnHevc || state.AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8 && !recentlyReloaded) {
        streamInfo.IsUsingModifiedM3U8 = true;
        streamInfo.LastPlayerReload = Date.now();
        postToPage({
          key: "ReloadPlayer"
        });
      }
      if (state.PreferLowQualityBackup && streamInfo.CsaiOnlyThisBreak && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= 4) {
        const stuckPolls = streamInfo.ConsecutiveAllStrippedPolls;
        const recoveryCacheSize = streamInfo.RecoverySegments?.length || 0;
        const earlyReloadInfo = (streamInfo.EarlyReloadCount || 0) + "/" + Math.max(1, streamInfo.PodLength || 1);
        console.log(
          "[AD DEBUG] Sticky CSAI escape hatch — stuck " + stuckPolls + " polls (~" + stuckPolls * 2 + "s), EarlyReloadCount=" + earlyReloadInfo + ", recovery cache=" + recoveryCacheSize + " segments, falling through to backup search"
        );
        streamInfo.CsaiOnlyThisBreak = false;
        streamInfo.EscapeHatchFired = true;
      }
      if (streamInfo.CsaiOnlyThisBreak && !streamInfo.IsUsingModifiedM3U8) {
        if (state.IsAdStrippingEnabled) {
          textStr = stripAdSegments(textStr, false, streamInfo);
        }
        if (streamInfo.EarlyReloadAwaitingResult) {
          streamInfo.EarlyReloadAwaitingResult = false;
          console.log("[AD DEBUG] Early reload result (sticky path): still ads — continuing recovery loop");
          streamInfo.EarlyReloadTriggered = false;
        }
        const stickyRecoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
        const stickyMaxEarlyReloads = stickyRecoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
        const stickyEffectiveThreshold = stickyRecoveryThin ? 1 : state.EarlyReloadPollThreshold;
        if (state.EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= stickyEffectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < stickyMaxEarlyReloads) {
          streamInfo.EarlyReloadTriggered = true;
          streamInfo.EarlyReloadAwaitingResult = true;
          streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
          streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
          const stickyReason = stickyRecoveryThin ? " (thin recovery cache: " + (streamInfo.RecoverySegments?.length || 0) + " segments)" : "";
          console.log(
            "[AD DEBUG] Early reload triggered (sticky path) — " + streamInfo.ConsecutiveAllStrippedPolls + " consecutive all-stripped polls" + stickyReason + " [" + streamInfo.EarlyReloadCount + "/" + stickyMaxEarlyReloads + "]"
          );
          postToPage({ key: "ReloadPlayer", kind: "early" });
        }
        postToPage({
          key: "UpdateAdBlockBanner",
          isMidroll: streamInfo.IsMidroll,
          hasAds: streamInfo.IsShowingAd,
          isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
          numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
          activeBackupPlayerType: null
        });
        return textStr;
      }
      const mainStreamLines = textStr.split(/\r?\n/);
      let hasNonLiveSegment = false;
      for (let i = 0; i < mainStreamLines.length; i++) {
        if (mainStreamLines[i].startsWith("#EXTINF") && !mainStreamLines[i].includes(",live")) {
          hasNonLiveSegment = true;
          break;
        }
      }
      if (!hasNonLiveSegment && !streamInfo.IsUsingModifiedM3U8 && !state.BackupSwapFirst) {
        streamInfo.CsaiOnlyThisBreak = true;
        console.log("[AD DEBUG] CSAI fast path — all segments live, skipping backup search");
        if (state.IsAdStrippingEnabled) {
          textStr = stripAdSegments(textStr, false, streamInfo);
        }
        postToPage({
          key: "UpdateAdBlockBanner",
          isMidroll: streamInfo.IsMidroll,
          hasAds: streamInfo.IsShowingAd,
          isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
          numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
          activeBackupPlayerType: null
        });
        return textStr;
      }
      const backupSearchStart = Date.now();
      let backupColdTokenFetches = 0;
      let backupPlayerType = null;
      let backupM3u8 = null;
      let fallbackM3u8 = null;
      let startIndex = 0;
      let isDoingMinimalRequests = false;
      if (streamInfo.LastPlayerReload > Date.now() - state.PlayerReloadMinimalRequestsTime) {
        startIndex = state.PlayerReloadMinimalRequestsPlayerIndex;
        isDoingMinimalRequests = true;
      }
      const playerTypesToTry = state.PreferLowQualityBackup ? [...state.BackupPlayerTypes, "autoplay"] : [...state.BackupPlayerTypes];
      if (streamInfo.PinnedBackupPlayerType) {
        const pinnedIndex = playerTypesToTry.indexOf(streamInfo.PinnedBackupPlayerType);
        if (pinnedIndex > 0) {
          playerTypesToTry.splice(pinnedIndex, 1);
          playerTypesToTry.unshift(streamInfo.PinnedBackupPlayerType);
        }
      }
      if (state.FastAutoplayFirstTry && streamInfo.LastBreakUsedEscapeHatch && state.PreferLowQualityBackup) {
        const FastAutoplayReprobeInterval = 5;
        const consecutive = streamInfo.FastAutoplayConsecutive || 0;
        if (consecutive >= FastAutoplayReprobeInterval) {
          streamInfo.FastAutoplayConsecutive = 0;
          if (!streamInfo.LoggedFastAutoplayReprobeThisBreak) {
            streamInfo.LoggedFastAutoplayReprobeThisBreak = true;
            console.log(
              "[AD DEBUG] Fast-autoplay re-probe — testing Source-tier after " + consecutive + " consecutive fast-autoplay breaks (channel-recovery check)"
            );
          }
        } else {
          const autoplayIdx = playerTypesToTry.indexOf("autoplay");
          if (autoplayIdx > 0) {
            playerTypesToTry.splice(autoplayIdx, 1);
            playerTypesToTry.unshift("autoplay");
            if (!streamInfo.LoggedFastAutoplayThisBreak) {
              streamInfo.LoggedFastAutoplayThisBreak = true;
              console.log(
                "[AD DEBUG] Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first"
              );
            }
          }
        }
      }
      if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.size > 0) {
        const clean = [];
        const contam = [];
        for (const t of playerTypesToTry) {
          if (streamInfo.LoggedBackupAdsByType.has(t)) contam.push(t);
          else clean.push(t);
        }
        if (contam.length > 0 && clean.length > 0) {
          playerTypesToTry.length = 0;
          playerTypesToTry.push(...clean, ...contam);
          if (!streamInfo.LoggedContamReorderThisBreak) {
            streamInfo.LoggedContamReorderThisBreak = true;
            console.log(
              "[AD DEBUG] Contamination-aware reorder — trying [" + clean.join(", ") + "] before known-contaminated [" + contam.join(", ") + "]"
            );
          }
        }
      }
      for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < playerTypesToTry.length; playerTypeIndex++) {
        const playerType = playerTypesToTry[playerTypeIndex];
        const realPlayerType = playerType.replace("-CACHED", "");
        const failedAt = streamInfo.FailedBackupPlayerTypes.get(realPlayerType);
        if (failedAt && Date.now() - failedAt < 5e3) {
          continue;
        }
        const isFullyCachedPlayerType = playerType !== realPlayerType;
        for (let i = 0; i < 2; i++) {
          let isFreshM3u8 = false;
          let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
          if (!encodingsM3u8) {
            isFreshM3u8 = true;
            backupColdTokenFetches++;
            try {
              const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
              if (accessTokenResponse.status === 200) {
                const accessToken = await accessTokenResponse.json();
                const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
                if (!spat) {
                  const errInfo = accessToken?.errors ? " errors: " + JSON.stringify(accessToken.errors).substring(0, 300) : "";
                  console.log(
                    "[AD DEBUG] GQL response missing streamPlaybackAccessToken for " + realPlayerType + ". Response keys: " + JSON.stringify(Object.keys(accessToken || {})) + errInfo
                  );
                  streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                  streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                  if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                    streamInfo.LoggedTokenFailureStreak = true;
                    console.log(
                      "[AD DEBUG] Token fetch failed " + streamInfo.ConsecutiveTokenFetchFailures + " times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting"
                    );
                  }
                  continue;
                }
                const urlInfo = new URL(
                  "https://usher.ttvnw.net/api/" + (state.V2API ? "v2/" : "") + "channel/hls/" + streamInfo.ChannelName + ".m3u8" + streamInfo.UsherParams
                );
                urlInfo.searchParams.set("sig", spat.signature);
                urlInfo.searchParams.set("token", spat.value);
                const encodingsM3u8Response = await realFetch(urlInfo.href);
                if (encodingsM3u8Response.status === 200) {
                  encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                  streamInfo.ConsecutiveTokenFetchFailures = 0;
                  streamInfo.LoggedTokenFailureStreak = false;
                } else {
                  console.log(
                    "[AD DEBUG] Usher HTTP " + encodingsM3u8Response.status + " for " + realPlayerType
                  );
                }
              } else {
                let errorBody = "";
                try {
                  errorBody = " — " + (await accessTokenResponse.text()).substring(0, 200);
                } catch {
                }
                console.log(
                  "[AD DEBUG] Access token HTTP " + accessTokenResponse.status + " for " + realPlayerType + (accessTokenResponse.status === 403 ? " (integrity: " + (state.ClientIntegrityHeader ? "present" : "missing") + ")" : "") + errorBody
                );
                streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                  streamInfo.LoggedTokenFailureStreak = true;
                  console.log(
                    "[AD DEBUG] Token fetch failed " + streamInfo.ConsecutiveTokenFetchFailures + " times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting"
                  );
                }
              }
            } catch (err) {
              console.log(
                "[AD DEBUG] Access token failed for " + realPlayerType + ": " + err.message
              );
              streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
              streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
              if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                streamInfo.LoggedTokenFailureStreak = true;
                console.log(
                  "[AD DEBUG] Token fetch failed " + streamInfo.ConsecutiveTokenFetchFailures + " times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting"
                );
              }
            }
          }
          if (encodingsM3u8) {
            try {
              const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
              if (!streamM3u8Url) {
                throw new Error("no variant playlist in the backup encodings");
              }
              const streamM3u8Response = await realFetch(streamM3u8Url);
              if (streamM3u8Response.status === 200) {
                const m3u8Text = await streamM3u8Response.text();
                if (m3u8Text) {
                  if (playerType === state.FallbackPlayerType) {
                    fallbackM3u8 = m3u8Text;
                  }
                  if (!hasAdTags(m3u8Text) && (state.SimulatedAdsDepth === 0 || playerTypeIndex >= state.SimulatedAdsDepth - 1) || !fallbackM3u8 && playerTypeIndex >= playerTypesToTry.length - 1) {
                    if ((streamInfo.ConsecutiveAllStrippedPolls || 0) >= 1 && !hasAdTags(m3u8Text)) {
                      const prevType = streamInfo.LastCommittedBackupPlayerType;
                      if (prevType && prevType !== playerType) {
                        console.log(
                          "[AD DEBUG] Cycle switched to different clean type (" + playerType + ", was " + prevType + ") during freeze — recovered without reload"
                        );
                        streamInfo.CycleRescuedThisBreak = true;
                      } else {
                        console.log(
                          "[AD DEBUG] Same backup type (" + playerType + ") became clean during freeze — natural recovery"
                        );
                      }
                    }
                    backupPlayerType = playerType;
                    backupM3u8 = m3u8Text;
                    break;
                  }
                  if (hasAdTags(m3u8Text)) {
                    if (!streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType = /* @__PURE__ */ new Set();
                    if (!streamInfo.LoggedBackupAdsByType.has(playerType)) {
                      streamInfo.LoggedBackupAdsByType.add(playerType);
                      console.log("[AD DEBUG] Backup stream (" + playerType + ") also has ads");
                    }
                  }
                  if (isFullyCachedPlayerType || isDoingMinimalRequests) {
                    backupPlayerType = playerType;
                    backupM3u8 = m3u8Text;
                    break;
                  }
                  if (hasAdTags(m3u8Text) && playerTypeIndex >= playerTypesToTry.length - 1) {
                    console.log(
                      "[AD DEBUG] All backup player types ad-laden — taking " + playerType + " as last-resort fallback (strip+recovery path will engage)"
                    );
                    backupPlayerType = playerType;
                    backupM3u8 = m3u8Text;
                    break;
                  }
                }
              } else {
                console.log(
                  "[AD DEBUG] Backup stream fetch failed for " + playerType + " (status " + streamM3u8Response.status + ")"
                );
              }
            } catch (err) {
              console.log("[AD DEBUG] Backup stream error for " + playerType + ": " + err.message);
            }
          }
          streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
          if (isFreshM3u8) {
            break;
          }
        }
      }
      if (!backupM3u8 && fallbackM3u8) {
        if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.has(state.FallbackPlayerType)) {
          console.log(
            "[AD DEBUG] Skipping fallback to " + state.FallbackPlayerType + " — marked contaminated this break (" + [...streamInfo.LoggedBackupAdsByType].join(", ") + " all ad-laden)"
          );
        } else {
          backupPlayerType = state.FallbackPlayerType;
          backupM3u8 = fallbackM3u8;
        }
      }
      if (backupM3u8 && backupPlayerType && streamInfo.IsShowingAd) {
        textStr = backupM3u8;
        streamInfo.LastCommittedBackupPlayerType = backupPlayerType;
        if (streamInfo.ActiveBackupPlayerType !== backupPlayerType) {
          streamInfo.ActiveBackupPlayerType = backupPlayerType;
          const sourceQualityTypes = ["embed", "site", "popout"];
          if (state.PinBackupPlayerType && backupPlayerType !== "autoplay" || sourceQualityTypes.includes(backupPlayerType)) {
            streamInfo.PinnedBackupPlayerType = backupPlayerType;
          }
          console.log(
            `[AD DEBUG] Blocking${streamInfo.IsMidroll ? " midroll " : " "}ads (${backupPlayerType}) — backup found in ${Date.now() - backupSearchStart}ms${backupColdTokenFetches > 0 ? ` (cold cache: ${backupColdTokenFetches} token fetch${backupColdTokenFetches > 1 ? "es" : ""})` : " (warm cache)"}`
          );
          if (streamInfo.EscapeHatchFired) {
            const qualityTier = backupPlayerType === "autoplay" ? "360p" : "Source";
            console.log(
              "[AD DEBUG] Post-escape backup: " + backupPlayerType + " (" + qualityTier + ") — recovered from sticky-path freeze"
            );
          } else if (backupPlayerType === "autoplay" && state.PreferLowQualityBackup) {
            const sourceTried = streamInfo.LoggedBackupAdsByType?.size || 0;
            if (sourceTried === 0) {
              console.log(
                "[AD DEBUG] Autoplay backup committed — 360p pinned from prior break (PreferLowQualityBackup)"
              );
              streamInfo.FastAutoplayConsecutive = (streamInfo.FastAutoplayConsecutive || 0) + 1;
            } else {
              console.log(
                "[AD DEBUG] Autoplay backup committed — 360p fallback after " + sourceTried + " Source type(s) ad-laden (PreferLowQualityBackup)"
              );
            }
            if (state.FastAutoplayFirstTry && sourceTried >= 4) {
              streamInfo.LastBreakUsedEscapeHatch = true;
              streamInfo.FastAutoplayConsecutive = 0;
            }
          } else if (state.FastAutoplayFirstTry && backupPlayerType !== "autoplay") {
            streamInfo.LastBreakUsedEscapeHatch = false;
            streamInfo.FastAutoplayConsecutive = 0;
          }
        }
      } else if (backupM3u8 && !streamInfo.IsShowingAd) {
        console.log(
          "[AD DEBUG] Discarded stale backup commit (" + backupPlayerType + ", " + (Date.now() - backupSearchStart) + "ms) — break ended during search"
        );
      } else {
        console.log(
          "[AD DEBUG] No ad-free backup stream found — ads may leak. Tried: " + playerTypesToTry.slice(startIndex).join(", ")
        );
      }
      const stripEnhanced = !!(isEnhanced && streamInfo.ModifiedM3U8);
      if (state.IsAdStrippingEnabled || stripEnhanced) {
        textStr = stripAdSegments(textStr, stripEnhanced, streamInfo);
      } else if (!backupM3u8) {
        console.log("[AD DEBUG] Ad stripping disabled and no backup — ads WILL show");
      }
      if (streamInfo.EarlyReloadAwaitingResult) {
        streamInfo.EarlyReloadAwaitingResult = false;
        if (textStr.includes(",live") && streamInfo.IsStrippingAdSegments) {
          console.log("[AD DEBUG] Early reload result: partial — some live segments returned");
        } else if (!streamInfo.IsStrippingAdSegments) {
          console.log("[AD DEBUG] Early reload result: clean — freeze ended");
          streamInfo.EarlyReloadTriggered = false;
        } else {
          console.log("[AD DEBUG] Early reload result: still ads — continuing recovery loop");
          streamInfo.EarlyReloadTriggered = false;
        }
      }
      const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
      const maxEarlyReloads = recoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
      const effectiveThreshold = recoveryThin ? 1 : state.EarlyReloadPollThreshold;
      if (state.EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= effectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < maxEarlyReloads) {
        streamInfo.EarlyReloadTriggered = true;
        streamInfo.EarlyReloadAwaitingResult = true;
        streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
        streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
        const reason = recoveryThin ? " (thin recovery cache: " + (streamInfo.RecoverySegments?.length || 0) + " segments)" : "";
        console.log(
          "[AD DEBUG] Early reload triggered — " + streamInfo.ConsecutiveAllStrippedPolls + " consecutive all-stripped polls" + reason + " [" + streamInfo.EarlyReloadCount + "/" + maxEarlyReloads + "]"
        );
        postToPage({ key: "ReloadPlayer", kind: "early" });
      }
    } else if (streamInfo.IsShowingAd) {
      if (!streamInfo.PendingAdEndAt) {
        streamInfo.PendingAdEndAt = Date.now();
      }
      streamInfo.CleanPlaylistCount++;
      const hasLiveSegments = textStr.includes(",live");
      const adEndMaxWaitMs = 12e3;
      const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
      const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
      if (streamInfo.CleanPlaylistCount >= 3 || !hasLiveSegments || slowPathReady) {
        if (slowPathReady && streamInfo.CleanPlaylistCount < 3) {
          console.log(
            "[AD DEBUG] Slow-path ad-end escalation — " + (streamInfo.AdEndBounceCount || 0) + " marker bounces, " + (elapsedSinceCandidate / 1e3).toFixed(1) + "s since first clean poll"
          );
        }
        if (!hasLiveSegments) {
          console.log("[AD DEBUG] Backup stream has no live segments — forcing immediate reload");
        }
        const adBreakDurationSec = streamInfo.AdBreakStartedAt ? ((Date.now() - streamInfo.AdBreakStartedAt) / 1e3).toFixed(1) : "?";
        console.log(
          "[AD DEBUG] Finished blocking ads — stripped " + streamInfo.NumStrippedAdSegments + " ad segments, duration: " + adBreakDurationSec + "s"
        );
        if (streamInfo.TotalAllStrippedPolls > 0) {
          const reloadInfo = streamInfo.EarlyReloadAtPoll ? ", early reload at poll " + streamInfo.EarlyReloadAtPoll : "";
          const wallClockFreeze = streamInfo.FreezeStartedAt ? ((Date.now() - streamInfo.FreezeStartedAt) / 1e3).toFixed(1) + "s wall-clock" : "unknown";
          console.log(
            "[AD DEBUG] Ad break stats: " + streamInfo.TotalAllStrippedPolls + " all-stripped polls, freeze duration: " + wallClockFreeze + reloadInfo
          );
        }
        const hadStrippedSegments = streamInfo.NumStrippedAdSegments > 0;
        if (!hadStrippedSegments && !streamInfo.HasConfirmedAdAttrs) {
          streamInfo.ConsecutiveZeroStripBreaks++;
          if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
            console.log(
              "[AD DEBUG] Warning: " + streamInfo.ConsecutiveZeroStripBreaks + " consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers"
            );
          }
        } else if (hadStrippedSegments || streamInfo.HasConfirmedAdAttrs) {
          streamInfo.ConsecutiveZeroStripBreaks = 0;
        }
        streamInfo.IsShowingAd = false;
        streamInfo.IsStrippingAdSegments = false;
        streamInfo.NumStrippedAdSegments = 0;
        streamInfo.ActiveBackupPlayerType = null;
        streamInfo.RequestedAds?.clear?.();
        streamInfo.SpoofedAdIds?.clear?.();
        streamInfo.FailedBackupPlayerTypes?.clear?.();
        if (streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType.clear();
        streamInfo.LoggedContamReorderThisBreak = false;
        streamInfo.CleanPlaylistCount = 0;
        streamInfo.PendingAdEndAt = 0;
        streamInfo.AdEndBounceCount = 0;
        streamInfo.ConsecutiveAllStrippedPolls = 0;
        streamInfo.EarlyReloadTriggered = false;
        streamInfo.EarlyReloadAwaitingResult = false;
        streamInfo.EarlyReloadAtPoll = 0;
        streamInfo.TotalAllStrippedPolls = 0;
        streamInfo.CsaiOnlyThisBreak = false;
        streamInfo.EscapeHatchFired = false;
        streamInfo.HasLoggedAdAttributes = false;
        streamInfo.HasLoggedUnknownSignifiers = false;
        streamInfo.LoggedFastAutoplayThisBreak = false;
        streamInfo.LoggedFastAutoplayReprobeThisBreak = false;
        if (!hadStrippedSegments) {
          console.log("[AD DEBUG] CSAI-only ad break (stripped 0) — clearing backup without player action");
          streamInfo.IsUsingModifiedM3U8 = false;
          if (streamInfo.LastCommittedBackupPlayerType) {
            const isAutoplay = streamInfo.LastCommittedBackupPlayerType === "autoplay";
            const reason = isAutoplay ? "autoplay (360p) — restoring Source quality" : streamInfo.LastCommittedBackupPlayerType + " — flushing MediaSource to prevent A/V desync accumulation";
            console.log("[AD DEBUG] End-of-break reload: " + reason);
            streamInfo.LastPlayerReload = Date.now();
            if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
            streamInfo.ReloadTimestamps.push(Date.now());
            postToPage({ key: "ReloadPlayer", kind: "early" });
          }
        } else {
          if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
          streamInfo.ReloadTimestamps = streamInfo.ReloadTimestamps.filter((t) => Date.now() - t < 3e5);
          const recentReloads = streamInfo.ReloadTimestamps.filter((t) => Date.now() - t < 3e5).length;
          const effectiveCooldown = recentReloads >= 3 ? state.ReloadCooldownSeconds * 3 : state.ReloadCooldownSeconds;
          const tooSoonSinceLastReload = streamInfo.LastPlayerReload && Date.now() - streamInfo.LastPlayerReload < effectiveCooldown * 1e3;
          const cycleRescuedCleanly = streamInfo.CycleRescuedThisBreak && (streamInfo.TotalAllStrippedPolls || 0) <= 2 && (streamInfo.EarlyReloadCount || 0) === 0;
          if (cycleRescuedCleanly) {
            console.log("[AD DEBUG] Cycle rescue handled the break cleanly — skipping end-of-break reload");
          }
          const shouldReload = streamInfo.IsUsingModifiedM3U8 || state.ReloadPlayerAfterAd && hadStrippedSegments && !cycleRescuedCleanly;
          if (shouldReload) {
            streamInfo.ReloadTimestamps.push(Date.now());
            streamInfo.IsUsingModifiedM3U8 = false;
            streamInfo.LastPlayerReload = Date.now();
            const reloadKind = state.SoftReloadNoStrip && !hadStrippedSegments ? "post-ad" : "early";
            postToPage({
              key: "ReloadPlayer",
              kind: reloadKind
            });
          } else {
            if (tooSoonSinceLastReload) {
              console.log(
                "[AD DEBUG] Skipping reload — last reload was " + ((Date.now() - streamInfo.LastPlayerReload) / 1e3).toFixed(0) + "s ago (cooldown: " + effectiveCooldown + "s" + (recentReloads >= 3 ? ", auto-escalated from " + recentReloads + " reloads in 5min" : "") + ")"
              );
            }
            postToPage({
              key: "PauseResumePlayer"
            });
          }
        }
      }
    }
    postToPage({
      key: "UpdateAdBlockBanner",
      isMidroll: streamInfo.IsMidroll,
      hasAds: streamInfo.IsShowingAd,
      isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
      numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
      activeBackupPlayerType: streamInfo.ActiveBackupPlayerType
    });
    return textStr;
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
  }
  function createStreamInfo(channelName, encodingsM3u8, usherParams) {
    return {
      // Identity / lifecycle
      ChannelName: channelName,
      LastSeenAt: Date.now(),
      EncodingsM3U8: encodingsM3u8,
      UsherParams: usherParams,
      // Resolutions / URL map
      Urls: /* @__PURE__ */ Object.create(null),
      // xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
      ResolutionList: [],
      RequestedAds: /* @__PURE__ */ new Set(),
      SpoofedAdIds: /* @__PURE__ */ new Set(),
      // notifyAdComplete: stitched-ad IDs already spoofed this break (multi-poll dedup). Cleared at break end.
      // Modified m3u8 state
      ModifiedM3U8: null,
      IsUsingModifiedM3U8: false,
      // Ad-break state
      IsShowingAd: false,
      IsMidroll: false,
      AdBreakStartedAt: 0,
      PodLength: 1,
      HasConfirmedAdAttrs: false,
      CleanPlaylistCount: 0,
      PendingAdEndAt: 0,
      // Timestamp of first clean poll seen this break — drives the bounce-tolerant max-wait escalation gate (TTV-AB v6.6.7 #1/#4)
      AdEndBounceCount: 0,
      // Count of ad-marker bounces while PendingAdEndAt is alive — telemetry only
      ConsecutiveZeroStripBreaks: 0,
      CsaiOnlyThisBreak: false,
      // Strip state
      IsStrippingAdSegments: false,
      NumStrippedAdSegments: 0,
      RecoverySegments: [],
      RecoveryStartSeq: void 0,
      // LOAD-BEARING: explicitly checked with `!== undefined`
      FreezeStartedAt: 0,
      ConsecutiveAllStrippedPolls: 0,
      TotalAllStrippedPolls: 0,
      LastAdCachePruneAt: 0,
      // stripAdSegments: last AdSegmentCache prune (throttled to once per 60s)
      // Clean playlist snapshot for all-stripped recovery (mirrors TTV-AB)
      LastCleanNativeM3U8: null,
      LastCleanNativePlaylistAt: 0,
      // Backup player type cycling
      BackupEncodingsM3U8Cache: /* @__PURE__ */ Object.create(null),
      // player type -> encodings m3u8 (null once used)
      ActiveBackupPlayerType: null,
      PinnedBackupPlayerType: null,
      LastCommittedBackupPlayerType: null,
      FailedBackupPlayerTypes: /* @__PURE__ */ new Map(),
      // Map<playerType, timestamp> — failures expire after 15s for retry
      LoggedBackupAdsByType: null,
      // lazy-init to Set on first "backup has ads" log
      CycleRescuedThisBreak: false,
      // Early reload
      EarlyReloadCount: 0,
      EarlyReloadAtPoll: 0,
      EarlyReloadTriggered: false,
      EarlyReloadAwaitingResult: false,
      // Hybrid-mode state (PreferLowQualityBackup)
      EscapeHatchFired: false,
      LastBreakUsedEscapeHatch: false,
      // FastAutoplayFirstTry: set when a break commits autoplay via PreferLowQualityBackup escape hatch (= all 4 Source types contaminated this break). Read at next break's backup-search entry to prepend autoplay first. Reset when a Source-tier type wins (channel recovered).
      FastAutoplayConsecutive: 0,
      // Count of consecutive breaks won by fast-autoplay without testing Source-tier. Triggers periodic re-probe to detect channel recovery (Twitch reversing CSAI delivery). Reset when full Source-tier probe runs or Source-tier wins.
      // Reload cooldown
      LastPlayerReload: 0,
      ReloadTimestamps: [],
      // Diagnostic flags (once-per-session)
      HasCheckedUnknownTags: false,
      HasLoggedAdAttributes: false,
      HasLoggedUnknownSignifiers: false,
      LoggedOfflineTransition: false,
      // Detection diagnostic: set when m3u8 transitions to offline-shape mid-session.
      ConsecutiveTokenFetchFailures: 0,
      // Detection diagnostic: counter for consecutive failed access-token fetches across player types. Logged at threshold, reset on success.
      LoggedTokenFailureStreak: false,
      // Once-per-streak guard for the threshold log.
      LoggedAdCacheSize1k: false,
      LoggedContamReorderThisBreak: false,
      LoggedFastAutoplayThisBreak: false,
      LoggedFastAutoplayReprobeThisBreak: false
    };
  }

  // src/worker/fetch-hook.ts
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
    self.fetch = async function(url, options) {
      if (typeof url === "string") {
        if (state.AdSegmentCache.has(url)) {
          return new Response(BLANK_MP4);
        }
        url = url.trimEnd();
        if (url.endsWith("m3u8")) {
          return new Promise(function(resolve, reject) {
            const processAfter = async function(response) {
              if (response.status === 200) {
                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
              } else {
                resolve(response);
              }
            };
            realFetch(url, options).then(function(response) {
              processAfter(response);
            })["catch"](function(err) {
              reject(err);
            });
          });
        } else if (url.includes("/channel/hls/") && !url.includes("picture-by-picture")) {
          state.V2API = url.includes("/api/v2/");
          const parsedUrl = new URL(url);
          const channelName = parsedUrl.pathname.match(/([^/]+)(?=\.\w+$)/)?.[0];
          if (state.ForceAccessTokenPlayerType) {
            parsedUrl.searchParams.delete("parent_domains");
            url = parsedUrl.toString();
          }
          return new Promise(function(resolve, reject) {
            const processAfter = async function(response) {
              if (response.status === 200) {
                const encodingsM3u8 = await response.text();
                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                let streamInfo = state.StreamInfos[channelName];
                if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
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
                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                  state.HasTriggeredPlayerReload = false;
                  console.log(
                    "[AD DEBUG] New stream session — channel: " + channelName + ", API: " + (state.V2API ? "v2" : "v1")
                  );
                  state.StreamInfos[channelName] = streamInfo = createStreamInfo(
                    channelName,
                    encodingsM3u8,
                    parsedUrl.search
                  );
                  const lines = encodingsM3u8.split(/\r?\n/);
                  for (let i = 0; i < lines.length - 1; i++) {
                    if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i + 1].includes(".m3u8")) {
                      const attributes = parseAttributes(lines[i]);
                      const resolution = attributes["RESOLUTION"];
                      if (resolution) {
                        const resolutionInfo = {
                          Resolution: resolution,
                          FrameRate: attributes["FRAME-RATE"],
                          // || '' like the three below: CODECS is optional on a STREAM-INF line,
                          // and this entry is pushed whenever RESOLUTION is present. Leaving it
                          // undefined is what let a direct .startsWith() reader throw and hang the
                          // master-playlist fetch. Keep every field in this object string-valued.
                          Codecs: attributes["CODECS"] || "",
                          // AUDIO/VIDEO/SUBTITLES groups are copied onto the rewritten STREAM-INF
                          // line during HEVC→AVC fallback so the variant references matching media
                          // groups (mirrors TTV-AB v6.7.5 parser fix). Without these, the rewritten
                          // line keeps the original HEVC variant's group ids, which point at audio
                          // tracks the AVC backup may not carry — black screen / audio desync.
                          Audio: attributes["AUDIO"] || "",
                          Video: attributes["VIDEO"] || "",
                          Subtitles: attributes["SUBTITLES"] || "",
                          Url: lines[i + 1]
                        };
                        streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                        streamInfo.ResolutionList.push(resolutionInfo);
                      }
                      state.StreamInfosByUrl[lines[i + 1]] = streamInfo;
                    }
                  }
                  if (streamInfo.ResolutionList.length === 0) {
                    console.log(
                      "[AD DEBUG] No resolutions parsed from encodings m3u8 — Twitch may have changed the format"
                    );
                  }
                  const decodableResolutionList = streamInfo.ResolutionList.filter(
                    (element) => videoCodecFamily(element.Codecs) === "avc"
                  );
                  if (state.AlwaysReloadPlayerOnAd || decodableResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => {
                    const f = videoCodecFamily(element.Codecs);
                    return f === "hevc" || f === "av1";
                  }) && !state.SkipPlayerReloadOnHevc) {
                    const replaceOrAppendStreamInfAttr = (line, key, value) => {
                      if (typeof value !== "string" || !value) return line;
                      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                      const next = key + '="' + escaped + '"';
                      const pattern = new RegExp("(^|,)" + key + '=("[^"]*"|[^,]*)');
                      return pattern.test(line) ? line.replace(pattern, "$1" + next) : line + "," + next;
                    };
                    if (decodableResolutionList.length > 0) {
                      for (let i = 0; i < lines.length - 1; i++) {
                        if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                          const resSettings = parseAttributes(
                            lines[i].substring(lines[i].indexOf(":") + 1)
                          );
                          const codecsKey = "CODECS";
                          const lineFamily = videoCodecFamily(resSettings[codecsKey]);
                          if (lineFamily === "hevc" || lineFamily === "av1") {
                            const oldResolution = resSettings["RESOLUTION"];
                            const [targetWidth, targetHeight] = oldResolution.split("x").map(Number);
                            const targetArea = targetWidth * targetHeight;
                            let newResolutionInfo = null;
                            let closestDiff = Infinity;
                            for (let j = 0; j < decodableResolutionList.length; j++) {
                              const candidate = decodableResolutionList[j];
                              const [streamWidth, streamHeight] = candidate.Resolution.split("x").map(Number);
                              const diff = Math.abs(streamWidth * streamHeight - targetArea);
                              if (diff < closestDiff) {
                                closestDiff = diff;
                                newResolutionInfo = candidate;
                              }
                            }
                            if (!newResolutionInfo) continue;
                            console.log(
                              "ModifiedM3U8 swap " + resSettings[codecsKey] + " to " + newResolutionInfo.Codecs + " oldRes:" + oldResolution + " newRes:" + newResolutionInfo.Resolution
                            );
                            lines[i] = lines[i].replace(
                              /CODECS="[^"]+"/,
                              `CODECS="${newResolutionInfo.Codecs}"`
                            );
                            lines[i] = replaceOrAppendStreamInfAttr(
                              lines[i],
                              "AUDIO",
                              newResolutionInfo.Audio
                            );
                            lines[i] = replaceOrAppendStreamInfAttr(
                              lines[i],
                              "VIDEO",
                              newResolutionInfo.Video
                            );
                            lines[i] = replaceOrAppendStreamInfAttr(
                              lines[i],
                              "SUBTITLES",
                              newResolutionInfo.Subtitles
                            );
                            lines[i + 1] = newResolutionInfo.Url + " ".repeat(i + 1);
                          }
                        }
                      }
                    }
                    if (decodableResolutionList.length > 0 || state.AlwaysReloadPlayerOnAd) {
                      streamInfo.ModifiedM3U8 = lines.join("\n");
                    }
                  }
                }
                streamInfo.LastSeenAt = Date.now();
                resolve(
                  new Response(
                    replaceServerTimeInM3u8(
                      streamInfo.IsUsingModifiedM3U8 && streamInfo.ModifiedM3U8 || streamInfo.EncodingsM3U8,
                      serverTime
                    )
                  )
                );
              } else {
                resolve(response);
              }
            };
            realFetch(url, options).then(function(response) {
              processAfter(response);
            })["catch"](function(err) {
              reject(err);
            });
          });
        }
      }
      return realFetch.apply(this, arguments);
    };
  }

  // src/worker/index.ts
  var workerString = getWasmWorkerJs(__vaftInit.twitchBlobUrl);
  if (!self.__tasPruneInterval) {
    self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1e3);
  }
  Object.assign(state, __vaftInit.config);
  self.addEventListener("message", function(e) {
    if (e.data.key === "UpdateClientVersion") {
      state.ClientVersion = e.data.value;
    } else if (e.data.key === "UpdateClientSession") {
      state.ClientSession = e.data.value;
    } else if (e.data.key === "UpdateClientId") {
      state.ClientID = e.data.value;
    } else if (e.data.key === "UpdateDeviceId") {
      state.GQLDeviceID = e.data.value;
    } else if (e.data.key === "UpdateClientIntegrityHeader") {
      state.ClientIntegrityHeader = e.data.value;
    } else if (e.data.key === "UpdateAuthorizationHeader") {
      state.AuthorizationHeader = e.data.value;
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
      state.HasTriggeredPlayerReload = true;
    } else if (e.data.key === "ReloadSkipped") {
      let cleared = false;
      for (const channel in state.StreamInfos) {
        const si = state.StreamInfos[channel];
        if (si && si.EarlyReloadTriggered) {
          si.EarlyReloadTriggered = false;
          si.EarlyReloadAwaitingResult = false;
          si.EarlyReloadCount = Math.max(0, (si.EarlyReloadCount || 0) - 1);
          cleared = true;
        }
      }
      if (cleared) {
        console.log(
          "[AD DEBUG] Reload skipped by main thread (player healthy) — early reload state cleared, can retry"
        );
      }
    } else if (e.data.key === "SimulateAds") {
      state.SimulatedAdsDepth = e.data.value;
      console.log("SimulatedAdsDepth: " + state.SimulatedAdsDepth);
    } else if (e.data.key === "AllSegmentsAreAdSegments") {
      state.AllSegmentsAreAdSegments = !state.AllSegmentsAreAdSegments;
      console.log("AllSegmentsAreAdSegments: " + state.AllSegmentsAreAdSegments);
    }
  });
  hookWorkerFetch();
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
      URL.revokeObjectURL = maskAsNative(function(url) {
        if (url === injectedBlobUrl) return;
        return realRevokeObjectURL.call(this, url);
      }, "revokeObjectURL");
      URL.revokeObjectURL.__tasMasked = true;
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
        const init = { twitchBlobUrl, config: pickSharedConfig(state) };
        const newBlobStr = `(${runWorker.toString()})(${JSON.stringify(init)});`;
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
          injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
          super(injectedBlobUrl, options);
        }
        twitchWorkers.length = 0;
        twitchWorkers.push(this);
        this.addEventListener("message", (e) => {
          if (e.data.key === "UpdateAdBlockBanner") {
            updateAdblockBanner(e.data);
            if (e.data.hasAds !== !!playerBufferState.inAdBreak) {
              playerBufferState.lastBackupSwitchAt = Date.now();
              if (!e.data.hasAds) {
                playerBufferState.position = 0;
              }
            }
            playerBufferState.inAdBreak = !!e.data.hasAds;
            if (e.data.hasAds) {
              cancelDriftCorrection();
            }
          } else if (e.data.key === "PauseResumePlayer") {
            doTwitchPlayerTask(true, false);
          } else if (e.data.key === "ReloadPlayer") {
            doTwitchPlayerTask(false, true, e.data.kind);
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
            doTwitchPlayerTask(false, true, "early");
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
  var ourTwitchAdSolutionsVersion = 95;
  function main() {
    let _isNested = false;
    try {
      _isNested = window.frameElement !== null;
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
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    window.reloadTwitchPlayer = () => {
      doTwitchPlayerTask(false, true);
    };
    loadLocalStorageConfig();
    console.log(
      "[AD DEBUG] Config: ReloadPlayerAfterAd = " + state.ReloadPlayerAfterAd + ", ForceAccessTokenPlayerType = " + state.ForceAccessTokenPlayerType + ", PinBackupPlayerType = " + state.PinBackupPlayerType
    );
    hookWindowWorker();
    hookFetch();
    hookXhr();
    if (state.PlayerBufferingFix) {
      monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "interactive") {
      onContentLoaded();
    } else {
      window.addEventListener("DOMContentLoaded", function() {
        onContentLoaded();
      });
    }
    window.simulateAds = (depth) => {
      if (depth === void 0 || depth < 0) {
        console.log("Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)");
        return;
      }
      postTwitchWorkerMessage("SimulateAds", depth);
    };
    window.allSegmentsAreAdSegments = () => {
      postTwitchWorkerMessage("AllSegmentsAreAdSegments");
    };
  }
  main();
})();
