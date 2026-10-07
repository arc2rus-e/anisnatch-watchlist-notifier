importScripts("settings.js");

const CHECK_ALARM = "checkWatchlist";
const SITE_ORIGIN = "https://anisnatch.top";
const WATCHLIST_URL = `${SITE_ORIGIN}/watchlist`;
const animePageUrl = (aniId) => `${SITE_ORIGIN}/anime/${aniId}`;
const LOOKUP_BUDGET_MS = 5 * 60 * 1000; // soft deadline for the next-release lookups in one check
// Re-lookup backoff for shows that aren't finished: once their cached date has
// passed, look again fairly soon (the next episode's date should be up); with
// no date announced at all, only try every few hours instead of every check.
const PAST_DATE_RETRY_MS = 30 * 60 * 1000;
const NO_DATE_RETRY_MS = 6 * 60 * 60 * 1000;
// After a lookup fails outright (page never answered), leave that show alone
// for a while instead of retrying it on every single check.
const FAILED_LOOKUP_RETRY_MS = 60 * 60 * 1000;
// A check that read the watchlist just before a show was marked completed
// would otherwise put it back; ignore such shows in check results for a while.
const RECENTLY_COMPLETED_MS = 10 * 60 * 1000;
const recentlyCompleted = new Map(); // aniId -> when it was marked completed

// (Re)creates the check alarm from the settings. Leaves an existing alarm
// alone when its period already matches, so a browser restart or an unrelated
// settings change doesn't reset the countdown to the next check.
async function scheduleChecks() {
  const settings = await getSettings();
  if (!settings.checkEnabled) {
    await chrome.alarms.clear(CHECK_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(CHECK_ALARM);
  if (existing && existing.periodInMinutes === settings.checkIntervalMinutes) return;
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: settings.checkIntervalMinutes });
}

// A bulk run or check that was cut short (worker killed, browser closed)
// would otherwise leave its progress marker behind forever.
const RUN_MARKERS = ["bulkProgress", "checkRunning"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(RUN_MARKERS);
  scheduleChecks();
  refreshBadgeFromStorage();
});

// Service workers get unloaded between checks; repaint the badge from the
// last saved state as soon as Chrome restarts, rather than waiting for the
// next alarm to fire.
chrome.runtime.onStartup.addListener(async () => {
  chrome.storage.local.remove(RUN_MARKERS);
  refreshBadgeFromStorage();
  scheduleChecks();
  const settings = await getSettings();
  if (settings.checkEnabled && settings.checkOnStartup) {
    await sleep(15000); // give Chrome a moment to restore its session and network
    runCheck();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    scheduleChecks();
    refreshBadgeFromStorage();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) runCheck();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const match = notificationId.match(/^anisnatch-(\d+)-/);
  if (!match) return;
  const [{ watchState = {} }, settings] = await Promise.all([chrome.storage.local.get("watchState"), getSettings()]);
  const entry = watchState[match[1]];
  const animeUrl = entry?.url || animePageUrl(match[1]);
  const url = settings.notificationClick === "anime" ? animeUrl : entry?.watchUrl || animeUrl;
  chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Checks and bulk runs can take minutes -- longer than Chrome lets a single
  // event stay open -- so those reply straight away and report progress and
  // results through storage (checkRunning / bulkProgress / bulkResult), which
  // the popup watches.
  if (msg.type === "MANUAL_CHECK") {
    runCheck();
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (msg.type === "MARK_ALL_COMPLETED") {
    sendResponse(startMarkAll(msg.aniIds));
    return false;
  }
  if (msg.type === "MARK_COMPLETED") {
    // One show takes seconds, so this one answers with the real result.
    markCompleted(msg.aniId).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

// --- watchState access -----------------------------------------------------
// Checks, lookups and "mark completed" all read-modify-write watchState from
// different async flows, so every write goes through this queue and re-reads
// the stored value first. That way one flow can't overwrite another's change
// (e.g. bring back a show that was just marked completed).
let stateLock = Promise.resolve();
function withStateLock(fn) {
  const run = stateLock.then(fn);
  stateLock = run.catch(() => {});
  return run;
}

function isValidAniId(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

// --- background tabs -------------------------------------------------------

// Opens `url` in a background tab, waits for it to finish loading, runs
// fn(tabId), and always closes the tab again.
async function withBackgroundTab(url, loadTimeoutMs, fn) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, loadTimeoutMs);
    return await fn(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// The listener is attached before the tab's current status is checked, so a
// page that finished loading before we got here isn't missed, and it's removed
// again on success, failure and timeout. The current-status shortcut only
// counts when the tab is actually on the site: a fresh tab can briefly report
// "complete" for its initial blank page before the real navigation starts.
// checkCurrent:false is for reloads, where the pre-reload "complete" status
// would resolve it too early.
function waitForTabComplete(tabId, timeoutMs, { checkCurrent = true } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (fn, value) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(value);
    };
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish(resolve);
    }
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(reject, new Error(`tab didn't finish loading within ${timeoutMs}ms`)), timeoutMs);
    if (checkCurrent) {
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === "complete" && tab.url?.startsWith(SITE_ORIGIN + "/")) finish(resolve);
        },
        (e) => finish(reject, e)
      );
    }
  });
}

async function reloadTab(tabId, timeoutMs) {
  const loaded = waitForTabComplete(tabId, timeoutMs, { checkCurrent: false });
  try {
    await chrome.tabs.reload(tabId);
  } catch (e) {
    loaded.catch(() => {}); // its timeout will still fire; don't leave it unhandled
    throw e;
  }
  await loaded;
}

// --- mark completed ---------------------------------------------------------

const marksInFlight = new Set();
let bulkRunning = false;

// Validates and kicks off a bulk run without waiting for it (see onMessage).
function startMarkAll(aniIds) {
  if (!Array.isArray(aniIds) || aniIds.length === 0 || !aniIds.every(isValidAniId)) {
    return { ok: false, error: "Invalid show ids" };
  }
  if (bulkRunning) return { ok: false, error: "Already running" };
  bulkRunning = true; // claimed synchronously so a second request can't slip in
  runMarkAll(aniIds);
  return { ok: true, started: true };
}

// Runs one at a time (each opens its own tab and edits watchState). Runs here
// rather than in the popup so it carries on if the popup is closed; progress
// and the final result go through storage so any open popup can show them.
async function runMarkAll(aniIds) {
  const failed = [];
  let done = 0;
  try {
    for (const aniId of aniIds) {
      await chrome.storage.local.set({ bulkProgress: { done, total: aniIds.length, at: Date.now() } });
      const res = await markCompleted(aniId, { fromBulk: true });
      if (res.ok) done++;
      else failed.push({ aniId, error: res.error });
      await sleep(800);
    }
  } catch (e) {
    console.error("[AniSnatch Notifier] bulk run failed:", e);
  } finally {
    bulkRunning = false;
    // Result first, then drop the progress marker: the popup re-renders on
    // the marker's removal and shows the result it finds.
    await chrome.storage.local.set({ bulkResult: { done, failed: failed.length, total: aniIds.length, at: Date.now() } });
    await chrome.storage.local.remove("bulkProgress");
  }
  return { done, failed };
}

// Moves a show to "Completed" in the user's AniSnatch list by driving the
// anime page's own Edit List dialog, then reloads the page and re-reads the
// dialog to confirm the site actually saved it before dropping the show here.
async function markCompleted(aniId, { fromBulk = false } = {}) {
  if (!isValidAniId(aniId)) return { ok: false, error: "Invalid show id" };
  // A separate click during a bulk run would race the loop over the same shows.
  if (bulkRunning && !fromBulk) return { ok: false, error: "A bulk run is in progress" };
  // Claimed before the first await so two callers can't both get past this check.
  if (marksInFlight.has(aniId)) return { ok: false, error: "Already in progress" };
  marksInFlight.add(aniId);

  try {
    // Re-check eligibility here too, not just in the popup, so a bulk request
    // can never complete a show that isn't finished and fully watched.
    const { watchState = {} } = await chrome.storage.local.get("watchState");
    const entry = watchState[aniId];
    if (!entry) return { ok: false, error: "Show isn't in your watchlist data" };
    if (!isReadyToComplete(entry)) return { ok: false, error: "Not finished airing and fully watched yet" };

    return await withBackgroundTab(animePageUrl(aniId), 20000, async (tabId) => {
      await sleep(1200);

      const res = await chrome.tabs.sendMessage(tabId, { type: "MARK_COMPLETED" }).catch(() => null);
      if (!res || !res.ok) return { ok: false, error: res?.error || "No response from the anime page" };

      // The content script already waited for the dialog to close after
      // saving; this is just a little extra margin before reloading.
      await sleep(1000);
      await reloadTab(tabId, 20000);
      await sleep(1200);

      const verify = await chrome.tabs.sendMessage(tabId, { type: "GET_LIST_TYPE" }).catch(() => null);
      if (!verify || verify.listType !== "3") return { ok: false, error: "The site didn't confirm Completed" };

      recentlyCompleted.set(aniId, Date.now());
      await withStateLock(async () => {
        const { watchState: current = {} } = await chrome.storage.local.get("watchState");
        delete current[aniId];
        await chrome.storage.local.set({ watchState: current });
        paintBadge(current);
      });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    marksInFlight.delete(aniId);
  }
}

// --- checking the watchlist -------------------------------------------------

// Overlapping checks (alarm + "Check now" + startup check) would open
// duplicate tabs and fire duplicate notifications, so a second request just
// joins the one already running.
let checkInFlight = null;
function runCheck() {
  if (!checkInFlight) {
    checkInFlight = doCheck().finally(() => {
      checkInFlight = null;
    });
  }
  return checkInFlight;
}

// The checkRunning marker lets any open popup show "Checking…" (including for
// alarm-triggered checks) and notice when it's over.
async function doCheck() {
  await chrome.storage.local.set({ checkRunning: { at: Date.now() } });
  try {
    await checkWatchlist();
  } finally {
    await chrome.storage.local.remove("checkRunning");
  }
}

async function checkWatchlist() {
  try {
    const result = await withBackgroundTab(WATCHLIST_URL, 30000, scrapeWatchlist);
    await chrome.storage.local.set({ lastCheck: Date.now() });

    if (!result || !result.ok) {
      await chrome.storage.local.set({
        lastError: result?.error === "NOT_LOGGED_IN" ? "Not logged in to AniSnatch" : "Check failed (see service worker console)",
      });
      return;
    }

    await chrome.storage.local.remove("lastError");
    const watchState = await processWatchlist(result.items);
    console.log(`[AniSnatch Notifier] checked ${result.items.length} shows`);

    if ((await getSettings()).lookupNextRelease) {
      await updateNextReleaseDates(watchState, Date.now() + LOOKUP_BUDGET_MS);
    }
  } catch (e) {
    console.error("[AniSnatch Notifier] check failed:", e);
    await chrome.storage.local.set({ lastCheck: Date.now(), lastError: String(e.message || e) });
  }
}

async function scrapeWatchlist(tabId) {
  await sleep(1000); // let the SPA finish its own render pass after document "complete"
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "CHECK_WATCHLIST" });
  } catch (e) {
    console.warn("[AniSnatch Notifier] content script didn't respond:", e);
    return null;
  }
}

// Whether an anime's page needs visiting again: never for finished shows (the
// site keeps a stale "Upcoming EP" countdown on those, which we ignore), not
// while a still-future date is cached, and otherwise with a backoff so shows
// with no announced date (or whose page keeps failing to answer) don't open a
// tab on every single check.
function needsLookup(entry, now) {
  if (entry.lookupFailedAt && now - entry.lookupFailedAt < FAILED_LOOKUP_RETRY_MS) return false;
  if (entry.finished === undefined) return true; // cached before we tracked airing status
  if (entry.finished) return false;
  if (entry.nextReleaseAt && entry.nextReleaseAt > now) return false;
  const retryAfterMs = entry.nextReleaseAt ? PAST_DATE_RETRY_MS : NO_DATE_RETRY_MS;
  return now - (entry.lookedUpAt ?? 0) >= retryAfterMs;
}

// Results are saved per show as they arrive (under the state lock), so a
// check that's cut short keeps what it already learned and can't clobber
// changes made while it was running. `deadline` is a soft budget: the loop
// just stops starting new lookups once it's passed.
async function updateNextReleaseDates(watchState, deadline) {
  for (const [aniId, entry] of Object.entries(watchState)) {
    if (Date.now() > deadline) {
      console.warn("[AniSnatch Notifier] next-release lookups ran out of time; the rest happen next check");
      break;
    }
    if (!needsLookup(entry, Date.now())) continue;

    await saveLookup(aniId, await fetchNextEpisodeInfo(aniId));
    await sleep(800); // stagger requests instead of hammering the site back-to-back
  }
}

// info === null records a failed lookup (the cached values are kept and the
// show is left alone for FAILED_LOOKUP_RETRY_MS).
function saveLookup(aniId, info) {
  return withStateLock(async () => {
    const { watchState = {} } = await chrome.storage.local.get("watchState");
    const entry = watchState[aniId];
    if (!entry) return; // removed meanwhile (marked completed / dropped)
    if (info) {
      entry.nextReleaseAt = info.dateMs; // null means "no schedule shown" (finished/hiatus/unknown)
      entry.finished = info.finished;
      entry.lookedUpAt = Date.now();
      delete entry.lookupFailedAt;
    } else {
      entry.lookupFailedAt = Date.now();
    }
    await chrome.storage.local.set({ watchState });
  });
}

async function fetchNextEpisodeInfo(aniId) {
  try {
    return await withBackgroundTab(animePageUrl(aniId), 15000, async (tabId) => {
      await sleep(1200);

      let result = null;
      try {
        result = await chrome.tabs.sendMessage(tabId, { type: "GET_NEXT_EPISODE" });
      } catch (e) {
        result = null;
      }

      if (!result || !result.ok) return null; // unknown -- keep whatever we had cached
      return {
        dateMs: result.dateISO ? new Date(result.dateISO).getTime() : null,
        finished: !!result.finished,
      };
    });
  } catch (e) {
    console.warn(`[AniSnatch Notifier] next-release fetch failed for ${aniId}:`, e);
    return null;
  }
}

// Rebuilds watchState from what the watchlist page currently shows, so shows
// you've dropped, completed or moved elsewhere on the site disappear here too.
function processWatchlist(scrapedItems) {
  return withStateLock(async () => {
    const [{ watchState = {}, pendingShrink }, settings] = await Promise.all([
      chrome.storage.local.get(["watchState", "pendingShrink"]),
      getSettings(),
    ]);

    // Drop shows we just marked completed: this scrape may predate the save.
    const now = Date.now();
    for (const [id, at] of recentlyCompleted) if (now - at > RECENTLY_COMPLETED_MS) recentlyCompleted.delete(id);
    const items = scrapedItems.filter((item) => !recentlyCompleted.has(item.aniId));

    // An empty result is ambiguous (genuinely empty list vs. a slow or broken
    // page load), so never let it wipe what we know.
    if (items.length === 0) return watchState;

    const knownCount = Object.keys(watchState).length;
    const isFirstRun = knownCount === 0;

    // Rebuild from what the page shows so dropped/completed shows disappear.
    // A list that shrank by more than half in one go is more likely a
    // half-rendered page than the user removing most of their list, so the
    // first time that happens keep the missing shows; if the next check sees
    // exactly the same smaller list, it's real and gets pruned.
    const shrinkKey = items.map((item) => item.aniId).sort().join(",");
    let looksPartial = knownCount >= 4 && items.length < knownCount / 2;
    if (looksPartial && pendingShrink === shrinkKey) looksPartial = false;
    if (looksPartial) {
      console.warn(`[AniSnatch Notifier] watchlist shrank ${knownCount} -> ${items.length}; keeping missing shows until confirmed`);
      await chrome.storage.local.set({ pendingShrink: shrinkKey });
    } else if (pendingShrink !== undefined) {
      await chrome.storage.local.remove("pendingShrink");
    }
    const nextState = looksPartial ? { ...watchState } : {};

    for (const item of items) {
      const prev = watchState[item.aniId];

      if (settings.notificationsEnabled && !isFirstRun && prev && item.available > prev.available) {
        const progress = Number.isFinite(item.watched) ? ` (you're at ep ${item.watched})` : "";
        chrome.notifications.create(`anisnatch-${item.aniId}-${item.available}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icon.png"),
          title: "New episode available",
          message: `${item.title} — ep ${item.available}${item.total ? "/" + item.total : ""} is up${progress}`,
        });
      }

      nextState[item.aniId] = {
        title: item.title,
        watched: item.watched,
        available: item.available,
        total: item.total,
        url: item.url,
        watchUrl: item.watchUrl,
        nextEpisode: item.nextEpisode,
        // Carried over; refreshed by updateNextReleaseDates.
        nextReleaseAt: prev?.nextReleaseAt ?? null,
        finished: prev?.finished, // site says "Finished Airing"; undefined until first looked up
        lookedUpAt: prev?.lookedUpAt,
        lookupFailedAt: prev?.lookupFailedAt,
      };
    }

    await chrome.storage.local.set({ watchState: nextState });
    paintBadge(nextState);
    return nextState;
  });
}

async function paintBadge(watchState) {
  const settings = await getSettings();
  const behindCount = Object.values(watchState).filter(isBehind).length;

  chrome.action.setBadgeText({ text: settings.badgeEnabled && behindCount > 0 ? String(behindCount) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#ec4899" });
}

async function refreshBadgeFromStorage() {
  const { watchState = {} } = await chrome.storage.local.get("watchState");
  paintBadge(watchState);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
