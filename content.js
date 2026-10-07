// Runs in the AniSnatch tab, loaded directly at /watchlist. That URL
// server-renders straight into the "Watching" view when logged in, so no
// click simulation is needed here (a scripted .click() isn't a trusted
// user gesture anyway, and the site's own root "/" is a separate marketing
// page with no watchlist nav at all -- both dead ends we don't need).

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CHECK_WATCHLIST") {
    checkWatchlist().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "GET_NEXT_EPISODE") {
    getNextEpisode().then(sendResponse);
    return true;
  }
  if (msg.type === "MARK_COMPLETED") {
    markCompleted().then(sendResponse);
    return true;
  }
  if (msg.type === "GET_LIST_TYPE") {
    getListType().then(sendResponse);
    return true;
  }
});

function waitFor(fn, timeoutMs = 8000, intervalMs = 200) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function getNextEpisode() {
  // The site keeps showing an "Upcoming EP" countdown on shows whose Status is
  // "Finished Airing", so read the status first and ignore the countdown then.
  const info = await waitFor(() => {
    const el = document.querySelector("#addInfo");
    return el && /Status:/.test(el.innerText) ? el : null;
  });
  const status = info ? /Status:\s*([^\n]+)/.exec(info.innerText)?.[1].trim() ?? null : null;
  if (status && /finished/i.test(status)) return { ok: true, status, finished: true, dateISO: null };

  const el = await waitFor(() => {
    const s = document.querySelector("#schedule");
    return s && s.textContent.trim() ? s : null;
  }, 8000, 300);
  if (!el) return { ok: !!status, status, finished: false, dateISO: null };

  const text = el.textContent.trim();
  const date = parseCountdownToDate(text);
  return { ok: true, status, finished: false, text, dateISO: date ? date.toISOString() : null };
}

// Opens the anime page's "Edit List" dialog and resolves to its list-type
// <select> (value "3" = Completed), or null if the dialog never appeared
// (e.g. logged out).
async function openEditDialog() {
  const btn = await waitFor(() => document.querySelector("#showlistedbtn"));
  if (!btn) return null;
  btn.click();
  return waitFor(() => {
    const s = document.querySelector("#listTypeSelect");
    return s && s.offsetParent !== null ? s : null;
  });
}

async function markCompleted() {
  const select = await openEditDialog();
  if (!select) return { ok: false, error: "Edit List dialog didn't open (logged out?)" };

  select.value = "3";
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  if (select.value !== "3") {
    document.querySelector("#closeDialog")?.click();
    return { ok: false, error: "Couldn't select Completed" };
  }

  const save = document.querySelector("#saveListUpdate");
  if (!save) return { ok: false, error: "Confirm button not found" };
  save.click();
  // Give the site's save request time to finish before replying: the
  // background script reloads the page next, which would cancel a save still
  // in flight. The dialog closing is the sign it's done; if it never closes we
  // carry on anyway and let the post-reload check decide.
  await waitFor(() => select.offsetParent === null, 10000, 200);
  return { ok: true };
}

async function getListType() {
  const select = await openEditDialog();
  if (!select) return { ok: false };
  const listType = select.value;
  document.querySelector("#closeDialog")?.click();
  return { ok: true, listType };
}

// The site renders this as a live-ticking "5d 20h 47m 43s" string rather
// than exposing the raw target timestamp, so we read the string at fetch
// time and reconstruct an approximate date from it.
function parseCountdownToDate(text) {
  const d = /(\d+)\s*d/.exec(text);
  const h = /(\d+)\s*h/.exec(text);
  const m = /(\d+)\s*m/.exec(text);
  const s = /(\d+)\s*s/.exec(text);
  if (!d && !h && !m && !s) return null;

  const totalMs =
    ((d ? +d[1] : 0) * 86400 + (h ? +h[1] : 0) * 3600 + (m ? +m[1] : 0) * 60 + (s ? +s[1] : 0)) * 1000;
  return new Date(Date.now() + totalMs);
}

async function checkWatchlist() {
  const items = await pollForItems();
  if (items.length > 0) return { ok: true, items };

  // Empty result: distinguish "logged out" from "genuinely empty list". The
  // page always contains (hidden) sign-in fields; only a visible one means
  // the user is actually signed out.
  const loggedOut = [...document.querySelectorAll('input[type="password"]')].some((el) => el.offsetParent !== null);
  if (loggedOut) return { ok: false, error: "NOT_LOGGED_IN" };

  return { ok: true, items: [] };
}

const WATCHLIST_ROWS = '#userlistcontainer [id^="watchlist-"]';

async function pollForItems(timeoutMs = 8000, intervalMs = 300) {
  // Wait for the row count to hold steady across two polls, so a list that
  // renders in chunks isn't read half-built (a partial list would make the
  // background script think the missing shows were removed).
  let lastCount = 0;
  const settled = await waitFor(() => {
    const nodes = document.querySelectorAll(WATCHLIST_ROWS);
    const stable = nodes.length > 0 && nodes.length === lastCount;
    lastCount = nodes.length;
    return stable ? nodes : null;
  }, timeoutMs, intervalMs);
  if (settled) return parseItems(settled);

  // Timed out: take whatever did render (a list that never stopped changing),
  // or nothing -- a genuinely empty watchlist or a slow/broken load.
  const nodes = document.querySelectorAll(WATCHLIST_ROWS);
  return nodes.length > 0 ? parseItems(nodes) : [];
}

function parseItems(nodes) {
  return [...nodes]
    .map((node) => {
      const aniId = node.id.replace("watchlist-", "");
      const titleAnchor = node.querySelector(".titleuserlist a");
      const titleEl = node.querySelector('.titleuserlist a span[lang="en"]') || titleAnchor;
      const title = titleEl ? titleEl.textContent.trim() : "Unknown title";

      const controlEl = node.querySelector(".usercontrol2");
      const watched = controlEl && controlEl.dataset.watching !== undefined ? parseInt(controlEl.dataset.watching, 10) : null;

      const epsEl = node.querySelector(".tick-eps");
      let available = null;
      let total = null;
      if (epsEl) {
        const [a, t] = epsEl.textContent.trim().split("/");
        available = parseInt(a, 10);
        total = t === "?" ? null : parseInt(t, 10);
      }

      const href = titleAnchor ? titleAnchor.getAttribute("data-href") : null;
      const url = href ? new URL(href, location.origin).toString() : `${location.origin}/anime/${aniId}`;

      // Link to the next episode you haven't seen yet, not the newest one --
      // if you're at ep 5 and 19 are out, the useful jump is to ep 6.
      const nextEpisode = Number.isFinite(watched) ? Math.min(watched + 1, available) : available;
      const watchUrl = Number.isFinite(nextEpisode) ? `${location.origin}/watch/${aniId}?ep=${nextEpisode}` : url;

      return { aniId, title, watched, available, total, url, watchUrl, nextEpisode };
    })
    .filter((item) => Number.isFinite(item.available));
}
