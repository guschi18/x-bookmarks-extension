'use strict';

let capturedCreds = {};
let capturedBookmarksUrl = null;
let capturedDeleteQueryId = null;

// Persistierten deleteQueryId beim Start laden
chrome.storage.local.get(['deleteQueryId'], (data) => {
  if (data.deleteQueryId) capturedDeleteQueryId = data.deleteQueryId;
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (name === 'authorization' && header.value.startsWith('Bearer ')) {
        capturedCreds.authorization = header.value;
      } else if (name === 'x-csrf-token') {
        capturedCreds['x-csrf-token'] = header.value;
      }
    }
  },
  { urls: ['*://x.com/*', '*://twitter.com/*'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes('/graphql/') && details.url.includes('Bookmarks') && !details.url.includes('DeleteBookmark')) {
      capturedBookmarksUrl = details.url;
    }
    if (details.url.includes('/graphql/') && details.url.includes('DeleteBookmark')) {
      const match = details.url.match(/\/graphql\/([^/]+)\/DeleteBookmark/);
      if (match && match[1] !== capturedDeleteQueryId) {
        capturedDeleteQueryId = match[1];
        chrome.storage.local.set({ deleteQueryId: capturedDeleteQueryId });
      }
    }
  },
  { urls: ['*://x.com/*'] }
);

// Nachricht vom Dashboard — Extension holt Bookmarks und gibt sie zurück
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Dashboard fragt aktuellen Sync-Status ab (für Button-Feedback während laufendem Sync)
  if (message.action === 'getStatus') {
    chrome.storage.session.get(['syncStatus'], (data) => {
      sendResponse({ syncStatus: data.syncStatus ?? 'idle' });
    });
    return true;
  }

  if (message.action !== 'startSync') return false;

  const { pendingDeletions = [] } = message;

  // Credentials für neuen Sync zurücksetzen, damit keine veralteten Werte verwendet werden
  capturedCreds = {};
  capturedBookmarksUrl = null;

  chrome.storage.session.set({ syncStatus: 'running', syncFetched: 0, error: null });

  (async () => {
    let xTabId = null;

    try {
      const xTab = await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: true });
      xTabId = xTab.id;

      await waitForTabLoad(xTabId);

      // Prüfen ob Login nötig — Tab könnte auf Login-Seite gelandet sein
      const initialTab = await chrome.tabs.get(xTabId);
      if (isXLoginPage(initialTab.url ?? '')) {
        chrome.storage.session.set({ syncStatus: 'waitingForLogin' });
      }

      // Wartet auf Credentials — erkennt Login und navigiert nach Login zu Bookmarks
      await waitForCredsAndLogin(xTabId);

      // Sicherstellen dass die Bookmarks-Seite vollständig geladen ist bevor Content-Script kontaktiert wird
      await waitForTabComplete(xTabId);

      // DeleteBookmark QueryId aus dem geladenen X-Webpack-Bundle extrahieren (funktioniert für neue User ohne Prior-State)
      const discovered = await discoverDeleteQueryId(xTabId);
      if (discovered) {
        capturedDeleteQueryId = discovered;
        chrome.storage.local.set({ deleteQueryId: discovered });
      }

      chrome.storage.session.set({ syncStatus: 'running', syncFetched: 0 });

      const contentResult = await sendToContentScript(xTabId, {
        action: 'xbm.syncStart',
        creds: capturedCreds,
        bookmarksUrl: capturedBookmarksUrl,
        pendingDeletions,
        deleteQueryId: capturedDeleteQueryId,
      });

      if (!contentResult.success) {
        throw new Error(contentResult.error ?? 'Content-Script Fehler');
      }

      const { bookmarks } = contentResult;
      chrome.storage.session.set({ syncStatus: 'done', fetched: bookmarks.length });

      // Bookmarks direkt ans Dashboard zurückgeben — Dashboard macht den API-Call
      sendResponse({ success: true, bookmarks });

    } catch (err) {
      console.error('[XBM Background] Sync error:', err.message);
      chrome.storage.session.set({ syncStatus: 'error', error: err.message });
      sendResponse({ success: false, error: err.message });
    } finally {
      if (xTabId !== null) {
        chrome.tabs.remove(xTabId).catch(() => {});
      }
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'syncProgress') {
    chrome.storage.session.set({ syncFetched: message.fetched });
  }
});

function isXLoginPage(url) {
  return (
    url.includes('/login') ||
    url.includes('/i/flow/login') ||
    url.includes('returnUrl')
  );
}

// Wartet auf den ersten Tab-Load (für neu geöffnete Tabs)
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab-Ladezeit überschritten'));
    }, 30000);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Wartet auf Credentials — mit Login-Erkennung.
// Wenn der Tab auf die Login-Seite weitergeleitet wurde, wartet diese Funktion
// bis der Nutzer sich eingeloggt hat. Nach dem Login navigiert sie ggf. zu
// /i/bookmarks, damit der Browser die Bookmarks-API aufruft und Credentials
// abgefangen werden können.
function waitForCredsAndLogin(tabId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let navigatedToBookmarks = false;

    function cleanup() {
      clearInterval(credInterval);
      chrome.tabs.onUpdated.removeListener(tabListener);
      chrome.tabs.onRemoved.removeListener(removedListener);
    }

    // Tab-URL überwachen: Login-Status anzeigen und nach Login zu Bookmarks navigieren
    function tabListener(id, changeInfo, tab) {
      if (id !== tabId || changeInfo.status !== 'complete') return;

      const url = tab.url ?? '';
      if (!url.startsWith('https://x.com/') && !url.startsWith('https://twitter.com/')) return;

      if (isXLoginPage(url)) {
        chrome.storage.session.set({ syncStatus: 'waitingForLogin' });
        return;
      }

      // Nach erfolgreichem Login: falls nicht schon auf Bookmarks-Seite, dorthin navigieren
      if (!url.includes('/i/bookmarks') && !navigatedToBookmarks) {
        navigatedToBookmarks = true;
        chrome.tabs.update(tabId, { url: 'https://x.com/i/bookmarks' }).catch(() => {});
      }
    }

    // Tab-Schließung durch den Nutzer sauber behandeln
    function removedListener(id) {
      if (id === tabId) {
        cleanup();
        reject(new Error('X-Tab wurde geschlossen'));
      }
    }

    chrome.tabs.onUpdated.addListener(tabListener);
    chrome.tabs.onRemoved.addListener(removedListener);

    // Credentials pollen bis vorhanden oder Timeout.
    // Nach 3s ohne Credentials: Login-Status zeigen — deckt sowohl URL-Redirect
    // als auch Login-Overlays ohne URL-Änderung ab.
    let loginHinted = false;

    const credInterval = setInterval(() => {
      const elapsed = Date.now() - start;
      const hasAuth = capturedCreds.authorization && capturedCreds['x-csrf-token'];
      const hasUrl = capturedBookmarksUrl;

      if (hasAuth && hasUrl) {
        cleanup();
        resolve();
        return;
      }

      if (!loginHinted && elapsed >= 3000) {
        loginHinted = true;
        chrome.storage.session.set({ syncStatus: 'waitingForLogin' });
      }

      if (elapsed >= timeoutMs) {
        cleanup();
        const missing = [];
        if (!capturedCreds.authorization) missing.push('Bearer Token');
        if (!capturedCreds['x-csrf-token']) missing.push('CSRF Token');
        if (!capturedBookmarksUrl) missing.push('Bookmarks URL');
        reject(new Error(`Timeout: ${missing.join(', ')} nicht gefunden. Bitte auf x.com einloggen.`));
      }
    }, 300);
  });
}

// Stellt sicher dass der Tab vollständig geladen ist — löst sofort auf wenn
// der Tab bereits den Status 'complete' hat, wartet andernfalls auf das Event.
function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        setTimeout(resolve, 1000);
        return;
      }
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab-Ladezeit überschritten'));
      }, timeoutMs);
      function listener(id, changeInfo) {
        if (id === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1000);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

/**
 * Durchsucht X's Webpack-Module im geöffneten Tab nach der DeleteBookmark QueryId.
 * Funktioniert für neue User ohne Prior-State — die QueryId ist im geladenen Bundle.
 */
async function discoverDeleteQueryId(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          for (const key of Object.keys(window)) {
            if (!key.startsWith('webpack')) continue;
            const val = window[key];
            if (!Array.isArray(val)) continue;
            for (const chunk of val) {
              const modules = chunk?.[1];
              if (!modules || typeof modules !== 'object') continue;
              for (const factory of Object.values(modules)) {
                if (typeof factory !== 'function') continue;
                const src = factory.toString();
                if (!src.includes('DeleteBookmark')) continue;
                const m = src.match(/queryId:"([^"]+)",operationName:"DeleteBookmark"/);
                if (m) return m[1];
              }
            }
          }
        } catch {}
        return null;
      },
    });
    return results?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Content-Script Timeout'));
    }, 120000);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response ?? { success: false, error: 'Keine Antwort' });
    });
  });
}
