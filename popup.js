'use strict';

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const stats = document.getElementById('stats');
const statImported = document.getElementById('stat-imported');
const statFetched = document.getElementById('stat-fetched');

function render(data) {
  const { syncStatus, syncFetched, imported } = data;

  dot.className = 'dot ' + (syncStatus ?? 'idle');

  switch (syncStatus) {
    case 'running':
      statusText.textContent = syncFetched
        ? `Sync läuft... (${syncFetched} gefunden)`
        : 'Sync läuft...';
      stats.style.display = 'none';
      break;
    case 'waitingForLogin':
      statusText.textContent = 'Bitte bei X einloggen...';
      stats.style.display = 'none';
      break;
    case 'done':
      statusText.textContent = 'Sync abgeschlossen';
      statImported.textContent = imported ?? 0;
      statFetched.textContent = syncFetched ?? 0;
      stats.style.display = 'grid';
      break;
    case 'error':
      statusText.textContent = 'Fehler: ' + (data.error ?? 'Unbekannter Fehler');
      statusText.title = data.error ?? '';
      stats.style.display = 'none';
      break;
    default:
      statusText.textContent = 'Bereit';
      stats.style.display = 'none';
  }
}

// Initialer Zustand
chrome.storage.session.get(['syncStatus', 'syncFetched', 'imported', 'error'], render);

// Live-Updates während Popup offen ist
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  chrome.storage.session.get(['syncStatus', 'syncFetched', 'imported', 'error'], render);
});
