const controls = [...document.querySelectorAll("[data-key]")];
const savedEl = document.getElementById("saved");
let savedTimer = null;

function flashSaved() {
  savedEl.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove("show"), 1200);
}

function applyToForm(settings) {
  for (const el of controls) {
    const value = settings[el.dataset.key];
    if (el.type === "checkbox") el.checked = value;
    else el.value = String(value);
  }
}

function readForm() {
  const settings = {};
  for (const el of controls) {
    if (el.type === "checkbox") settings[el.dataset.key] = el.checked;
    else settings[el.dataset.key] = el.dataset.type === "number" ? Number(el.value) : el.value;
  }
  return settings;
}

async function init() {
  applyToForm(await getSettings());
  for (const el of controls) {
    el.addEventListener("change", async () => {
      await saveSettings(readForm());
      flashSaved();
    });
  }
}

document.getElementById("resetSettings").addEventListener("click", async () => {
  await saveSettings(DEFAULT_SETTINGS);
  applyToForm(await getSettings());
  flashSaved();
});

document.getElementById("clearData").addEventListener("click", async () => {
  if (!confirm("Clear everything this extension has remembered about your watchlist? Your AniSnatch list is not affected.")) return;
  await chrome.storage.local.remove(["watchState", "lastCheck", "lastError", "bulkProgress", "bulkResult", "pendingShrink"]);
  await chrome.action.setBadgeText({ text: "" });
  document.getElementById("dataMsg").textContent = "Cleared. The next check will rebuild it.";
});

init();
