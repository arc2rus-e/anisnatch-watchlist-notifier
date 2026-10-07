// Shared by the background service worker (importScripts), the popup and the
// options page. Stored under the "settings" key in chrome.storage.local.

const DEFAULT_SETTINGS = {
  checkEnabled: true, // false pauses the scheduled checks ("Check now" still works)
  checkIntervalMinutes: 30,
  checkOnStartup: false, // also run a check shortly after Chrome starts
  lookupNextRelease: true, // visit each show's page for its next-episode date / airing status
  notificationsEnabled: true,
  notificationClick: "watch", // "watch" = the episode you're up to, "anime" = the show's page
  badgeEnabled: true, // toolbar badge with the number of shows you're behind on
  showCaughtUp: true,
  caughtUpExpanded: false, // open the "Caught up" section by default
  showCompleteButtons: true, // "Mark completed" buttons for finished shows
};

const INTERVAL_CHOICES = [15, 30, 60, 120, 360, 720];
const NOTIFICATION_CLICK_CHOICES = ["watch", "anime"];

function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    out[key] = typeof src[key] === typeof def ? src[key] : def;
  }
  if (!INTERVAL_CHOICES.includes(out.checkIntervalMinutes)) {
    out.checkIntervalMinutes = DEFAULT_SETTINGS.checkIntervalMinutes;
  }
  if (!NOTIFICATION_CLICK_CHOICES.includes(out.notificationClick)) {
    out.notificationClick = DEFAULT_SETTINGS.notificationClick;
  }
  return out;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: normalizeSettings(settings) });
}

// --- Shared watchlist helpers (used by the background worker and the popup) ---

// You're behind: more episodes are out than you've watched.
function isBehind(item) {
  return Number.isFinite(item.watched) && Number.isFinite(item.available) && item.available > item.watched;
}

// Safe to move to Completed: the show has finished airing and you've watched
// every episode the site has -- and the full run, when the total is known.
// An unreadable watched count never qualifies.
function isReadyToComplete(item) {
  return (
    !!item.finished &&
    Number.isFinite(item.watched) &&
    Number.isFinite(item.available) &&
    item.watched >= item.available &&
    (!Number.isFinite(item.total) || item.watched >= item.total)
  );
}
