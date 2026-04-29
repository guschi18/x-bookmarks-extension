/**
 * Läuft im isolierten Kontext auf x.com.
 * Erhält Credentials vom background.js und fetcht Bookmarks paginiert.
 * Nutzt die originale X-URL inkl. features-Parameter (1:1 wie Referenz-Extension).
 */
'use strict';

let deleteQueryId = null;

// DeleteBookmark QueryId vom MAIN-World-Script empfangen
window.addEventListener('xbm.deleteQueryId', (e) => {
  deleteQueryId = e.detail.queryId;
});

/**
 * Transformiert einen X-API-Bookmark-Entry in unser internes Format.
 */
function transformEntry(entry) {
  const result = entry?.content?.itemContent?.tweet_results?.result;
  if (!result) return null;

  // TweetWithVisibilityResults verschachtelt den Tweet unter result.tweet
  const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  if (!tweet) return null;

  const legacy = tweet.legacy;
  if (!legacy?.id_str) return null;

  // X API hat User-Struktur geändert:
  // Alt: user_results.result.legacy.{ screen_name, name, profile_image_url_https }
  // Neu: user_results.result.core.{ screen_name, name } + result.avatar.image_url
  const userResult = tweet.core?.user_results?.result;
  const userOld = userResult?.legacy;
  const userNew = userResult?.core;

  const screenName = userOld?.screen_name ?? userNew?.screen_name;
  if (!screenName) return null;

  return {
    tweet_url: `https://x.com/${screenName}/status/${legacy.id_str}`,
    full_text: legacy.full_text ?? null,
    screen_name: screenName,
    name: userOld?.name ?? userNew?.name ?? null,
    profile_image_url_https: userOld?.profile_image_url_https ?? userResult?.avatar?.image_url ?? null,
    tweeted_at: legacy.created_at ?? null,
    bookmark_date: new Date().toISOString(),
    extended_media: legacy.extended_entities?.media ?? null,
  };
}

/**
 * Ruft alle Bookmarks paginiert ab.
 * Nutzt die originale URL + originale features (wie Referenz-Extension).
 */
async function fetchAllBookmarks(creds, bookmarksUrl) {
  const bookmarks = [];

  // Originale URL als Vorlage nutzen — nur variables ersetzen, ALLES andere (features,
  // fieldToggles, etc.) bleibt zeichengenau erhalten.
  const baseUrl = bookmarksUrl.split('?')[0];
  const rawQuery = bookmarksUrl.split('?')[1] ?? '';

  // Variables aus der Original-URL dekodieren und Cursor entfernen (starten von vorne)
  const varPart = rawQuery.split('&').find(p => p.startsWith('variables=')) ?? 'variables=%7B%7D';
  const originalVariables = JSON.parse(decodeURIComponent(varPart.slice('variables='.length)));
  delete originalVariables.cursor;

  let cursor = null;

  while (true) {
    const variables = { ...originalVariables };
    if (cursor) variables.cursor = cursor;

    // Nur variables-Teil in der Original-Query ersetzen, Rest unberührt lassen
    const newVarPart = 'variables=' + encodeURIComponent(JSON.stringify(variables));
    const rebuiltQuery = rawQuery.replace(/variables=[^&]+/, newVarPart);
    const url = `${baseUrl}?${rebuiltQuery}`;

    let response;
    try {
      response = await fetch(url, {
        headers: {
          'accept': '*/*',
          'authorization': creds.authorization,
          'content-type': 'application/json',
          'x-csrf-token': creds['x-csrf-token'],
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-client-language': 'en',
        },
        referrer: 'https://x.com/i/bookmarks',
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
      });
    } catch (err) {
      throw new Error('Netzwerkfehler: ' + err.message);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('[XBM] X-API HTTP', response.status, '| URL:', url.slice(0, 120), '| Body:', body.slice(0, 400));
      throw new Error(`X-API HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();

    // Fehler im Response-Body (X gibt manchmal 200 + errors zurück)
    if (data?.errors?.length && !data?.data) {
      console.error('[XBM] X-API errors:', JSON.stringify(data.errors));
      throw new Error('X-API Fehler: ' + data.errors[0]?.message);
    }

    // Unterstützt bookmark_timeline_v2 und bookmark_collection_timeline
    const timelineKey = data?.data?.bookmark_timeline_v2 ? 'bookmark_timeline_v2' : 'bookmark_collection_timeline';
    const timeline = data?.data?.[timelineKey]?.timeline;

    console.log('[XBM] Timeline key:', timelineKey, '| Instructions:', timeline?.instructions?.length, '| data keys:', Object.keys(data?.data ?? {}));

    // Instruction mit Entries finden (kann TimelineAddEntries oder anderer Typ sein)
    const instruction = timeline?.instructions?.find(i => Array.isArray(i.entries) && i.entries.length > 0)
                     ?? timeline?.instructions?.[0];
    const entries = instruction?.entries ?? [];

    // Alle Non-Cursor-Entries verarbeiten — transformEntry gibt null für Nicht-Tweets
    const candidateEntries = entries.filter(e => e.entryId && !e.entryId.startsWith('cursor-'));
    console.log('[XBM] Entries total:', entries.length, '| Candidates:', candidateEntries.length);

    // Ersten Entry vollständig loggen um die Struktur zu sehen
    if (candidateEntries.length > 0) {
      console.log('[XBM] First entry structure:', JSON.stringify(candidateEntries[0], null, 2).slice(0, 1000));
    }

    for (const entry of candidateEntries) {
      const transformed = transformEntry(entry);
      if (transformed) bookmarks.push(transformed);
    }

    chrome.runtime.sendMessage({ action: 'syncProgress', fetched: bookmarks.length });

    // Referenz-Extension: brich ab wenn nur 2 Entries (= nur Cursors, keine Tweets mehr)
    if (entries.length <= 2) break;

    const cursorEntry = entries.find(e => e.entryId?.startsWith('cursor-bottom'));
    const nextCursor = cursorEntry?.content?.value;
    if (!nextCursor) break;

    cursor = nextCursor;
    await new Promise(r => setTimeout(r, 1500));
  }

  return bookmarks;
}


async function deleteBookmarkOnX(tweetId, creds) {
  if (!deleteQueryId) return;
  try {
    await fetch(`https://x.com/i/api/graphql/${deleteQueryId}/DeleteBookmark`, {
      method: 'POST',
      headers: {
        'authorization': creds.authorization,
        'x-csrf-token': creds['x-csrf-token'],
        'content-type': 'application/json',
        'x-twitter-auth-type': 'OAuth2Session',
      },
      credentials: 'include',
      body: JSON.stringify({
        variables: { tweet_id: tweetId },
        queryId: deleteQueryId,
      }),
    });
  } catch {
    // Fehler ignorieren — pending_deletions wird trotzdem geleert
  }
}


chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'xbm.syncStart') return false;

  const { creds, bookmarksUrl, pendingDeletions = [], deleteQueryId: msgDeleteQueryId } = message;
  // deleteQueryId aus der Nachricht übernehmen (zuverlässiger als window-Event)
  if (msgDeleteQueryId) deleteQueryId = msgDeleteQueryId;

  (async () => {
    try {
      if (!creds?.authorization) throw new Error('Kein Bearer-Token übergeben');
      if (!bookmarksUrl) throw new Error('Keine Bookmarks-URL übergeben');

      // 1. Pending Deletions auf X ausführen (Liste kommt vom Dashboard)
      for (const tweetId of pendingDeletions) {
        await deleteBookmarkOnX(tweetId, creds);
        await new Promise(r => setTimeout(r, 500));
      }

      // 2. Alle Bookmarks abrufen
      const bookmarks = await fetchAllBookmarks(creds, bookmarksUrl);

      sendResponse({ success: true, bookmarks });
    } catch (err) {
      console.error('[XBM Content]', err.message);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});
