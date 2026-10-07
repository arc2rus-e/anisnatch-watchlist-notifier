let settings = DEFAULT_SETTINGS;
let firstRender = true;

// Progress markers older than this are treated as dead (e.g. the background
// worker was killed mid-run). A bulk run touches its marker per show; a check
// sets its marker once and can take ~6 minutes at most.
const BULK_STALE_MS = 3 * 60 * 1000;
const CHECK_STALE_MS = 10 * 60 * 1000;
// How long a finished bulk run's result stays in the status line.
const BULK_RESULT_SHOW_MS = 60 * 1000;

const isFresh = (marker, maxAgeMs) => !!marker && Date.now() - marker.at < maxAgeMs;

// Any exception or dropped channel on the background side becomes an
// { ok: false } result instead of leaving a button stuck on "Marking…".
async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || { ok: false, error: "No response from the extension" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function render() {
  const [{ lastCheck, watchState = {}, lastError, bulkProgress, bulkResult, checkRunning }, loadedSettings] =
    await Promise.all([
      chrome.storage.local.get(["lastCheck", "watchState", "lastError", "bulkProgress", "bulkResult", "checkRunning"]),
      getSettings(),
    ]);
  settings = loadedSettings;

  const statusEl = document.getElementById("status");
  if (isFresh(checkRunning, CHECK_STALE_MS)) {
    statusEl.textContent = "Checking…";
  } else if (isFresh(bulkResult, BULK_RESULT_SHOW_MS)) {
    statusEl.textContent =
      bulkResult.failed > 0
        ? `Marked ${bulkResult.done}, ${bulkResult.failed} failed — try those again`
        : `Marked ${bulkResult.done} as completed`;
  } else {
    statusEl.textContent = lastCheck ? `Last checked: ${new Date(lastCheck).toLocaleString()}` : "Not checked yet";
    if (lastError) statusEl.textContent += ` — ${lastError}`;
    if (!settings.checkEnabled) statusEl.textContent += " — automatic checks paused";
  }

  const listEl = document.getElementById("list");
  const caughtListEl = document.getElementById("caughtUpList");
  const scroll = { list: listEl.scrollTop, caught: caughtListEl.scrollTop }; // rebuilding the lists would reset these
  listEl.innerHTML = "";

  const behind = [];
  const caughtUp = [];
  for (const [aniId, item] of Object.entries(watchState)) {
    (isBehind(item) ? behind : caughtUp).push({ ...item, aniId });
  }

  const activeBulk = isFresh(bulkProgress, BULK_STALE_MS) ? bulkProgress : null;
  renderCaughtUp(caughtUp, activeBulk);
  caughtListEl.scrollTop = scroll.caught;
  firstRender = false;

  if (behind.length === 0) {
    const li = document.createElement("li");
    li.textContent = "You're all caught up!";
    li.style.color = "#888";
    li.style.justifyContent = "center";
    listEl.appendChild(li);
    return;
  }

  behind.forEach((item) => {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("a");
    name.textContent = item.title;
    name.title = item.title;
    name.href = item.url || "#";
    name.target = "_blank";
    name.rel = "noopener noreferrer";
    const eps = document.createElement("span");
    eps.append(`${item.watched} → `);
    const epLink = document.createElement("a");
    epLink.textContent = item.nextEpisode ?? item.available;
    epLink.title = `Watch episode ${item.nextEpisode ?? item.available}`;
    epLink.href = item.watchUrl || item.url || "#";
    epLink.target = "_blank";
    epLink.rel = "noopener noreferrer";
    epLink.className = "eplink";
    eps.append(epLink);
    if (item.available !== item.nextEpisode || item.total) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = ` (${item.available}${item.total ? "/" + item.total : ""} out)`;
      eps.append(detail);
    }
    row.append(name, eps);

    const next = document.createElement("div");
    next.className = "next";
    next.textContent = nextLabel(item);

    li.append(row, next);
    listEl.appendChild(li);
  });
  listEl.scrollTop = scroll.list;
}

function nextLabel(item) {
  return item.finished ? "Finished airing" : `Next ep: ${formatNextRelease(item.nextReleaseAt)}`;
}

// A button that edits the user's real AniSnatch list, so it needs two clicks:
// the first arms it ("Confirm?" for 3 seconds), the second runs onConfirm.
// onConfirm(btn) may return an error string to show on the button.
function makeConfirmButton({ label, confirmLabel, busyLabel, title, className, id, disabled, onConfirm }) {
  const btn = document.createElement("button");
  if (id) btn.id = id;
  btn.className = className;
  btn.title = title;
  btn.textContent = label;
  btn.disabled = !!disabled;

  const reset = () => {
    delete btn.dataset.armed;
    btn.disabled = false;
    btn.textContent = label;
  };

  btn.addEventListener("click", async () => {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.textContent = confirmLabel;
      setTimeout(() => {
        if (btn.isConnected && btn.dataset.armed && !btn.disabled) reset();
      }, 3000);
      return;
    }

    btn.disabled = true;
    btn.textContent = busyLabel;
    const error = await onConfirm(btn);
    if (error && btn.isConnected) {
      reset();
      btn.textContent = "Failed — retry";
      btn.title = error;
    }
  });
  return btn;
}

function makeCompleteButton(item, bulkActive) {
  return makeConfirmButton({
    className: "complete",
    label: "Mark completed",
    confirmLabel: "Confirm?",
    busyLabel: "Marking…",
    title: bulkActive ? "Wait for the bulk run to finish" : "Moves this show to Completed in your AniSnatch list",
    disabled: bulkActive,
    async onConfirm() {
      const res = await send({ type: "MARK_COMPLETED", aniId: item.aniId });
      if (res.ok) {
        render();
        return null;
      }
      return res.error || "Unknown error";
    },
  });
}

// "Mark all" button for every finished-and-fully-watched show. The work runs
// in the background script.
function makeBulkButton(ready, bulkProgress) {
  if (bulkProgress) {
    const btn = document.createElement("button");
    btn.id = "bulkBtn";
    btn.className = "bulk";
    btn.disabled = true;
    btn.textContent = `Marking ${bulkProgress.done + 1}/${bulkProgress.total}…`;
    return btn;
  }

  return makeConfirmButton({
    id: "bulkBtn",
    className: "bulk",
    label: `Mark all ${ready.length} finished as completed`,
    confirmLabel: `Confirm? Marks ${ready.length} shows`,
    busyLabel: `Marking 1/${ready.length}…`,
    title: "Moves every finished, fully watched show listed below to Completed in your AniSnatch list",
    async onConfirm() {
      // The background only confirms the run started; progress and the final
      // result arrive through storage (bulkProgress / bulkResult).
      const res = await send({ type: "MARK_ALL_COMPLETED", aniIds: ready.map((item) => item.aniId) });
      return res.ok ? null : res.error || "Unknown error";
    },
  });
}

function renderCaughtUp(caughtUp, bulkProgress) {
  const section = document.getElementById("caughtUpSection");
  const summary = document.getElementById("caughtUpSummary");
  const listEl = document.getElementById("caughtUpList");
  const bulkEl = document.getElementById("bulkRow");
  listEl.innerHTML = "";
  bulkEl.innerHTML = "";

  if (caughtUp.length === 0 || !settings.showCaughtUp) {
    section.style.display = "none";
    return;
  }

  const ready = caughtUp.filter(isReadyToComplete);
  // While a run is active its progress stays visible even once only one show
  // is left, and the per-show buttons are held off so they can't race the loop.
  if (settings.showCompleteButtons && (bulkProgress || ready.length > 1)) {
    bulkEl.append(makeBulkButton(ready, bulkProgress));
  }

  section.style.display = "";
  // Only on the first paint, so re-renders (after Check now / marking
  // completed) don't fight the user toggling the section themselves.
  if (firstRender) section.open = settings.caughtUpExpanded;
  summary.textContent = `Caught up (${caughtUp.length})`;

  caughtUp
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach((item) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "row";
      const a = document.createElement("a");
      a.textContent = item.title;
      a.title = item.title;
      a.href = item.url || "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.append(a);
      // Only offered once the show has finished airing and you've seen it all.
      if (settings.showCompleteButtons && isReadyToComplete(item)) row.append(makeCompleteButton(item, !!bulkProgress));

      const next = document.createElement("div");
      next.className = "next";
      next.textContent = nextLabel(item);

      li.append(row, next);
      listEl.appendChild(li);
    });
}

function formatNextRelease(ms) {
  if (!ms) return "not announced";

  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "any time now";

  const date = new Date(ms);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);

  let relative;
  if (days === 0) relative = hours >= 1 ? `in ${hours}h` : "in <1h";
  else if (days === 1) relative = "tomorrow";
  else relative = `in ${days}d`;

  return `${weekday} (${relative})`;
}

document.getElementById("openSettings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Keep the open popup in sync with the background worker: settings edits, the
// watchlist changing (a check or a mark-completed finishing, even one started
// from an earlier popup), and a bulk run's progress.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const progress = changes.bulkProgress?.newValue;
  const bulkBtn = document.getElementById("bulkBtn");
  if (progress && bulkBtn && bulkBtn.disabled) {
    bulkBtn.textContent = `Marking ${progress.done + 1}/${progress.total}…`;
  }

  const bulkEnded = changes.bulkProgress && !changes.bulkProgress.newValue;
  if (changes.settings || changes.watchState || changes.checkRunning || changes.bulkResult || bulkEnded) {
    scheduleRender();
  }
});

// A check saves its results show by show, which would otherwise rebuild the
// whole popup dozens of times. Coalesce those, and hold off while a "Confirm?"
// button is waiting for its second click so it isn't replaced under the cursor.
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(function run() {
    if (document.querySelector("button[data-armed]:not(:disabled)")) {
      renderTimer = setTimeout(run, 500);
      return;
    }
    render();
  }, 300);
}

// The check runs in the background and can take minutes; the status line
// follows it through the checkRunning marker and updates when it's done.
document.getElementById("checkNow").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Checking…";
  const res = await send({ type: "MANUAL_CHECK" });
  if (!res.ok) statusEl.textContent = `Couldn't start a check: ${res.error || "unknown error"}`;
});

render();
