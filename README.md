# X Bookmarks Sync

Chrome-Erweiterung (Manifest V3), die X/Twitter-Bookmarks mit dem eigenen
X-Bookmarks-Dashboard synchronisiert — inklusive Reverse-Flow zum Aufräumen:
bereits importierte Bookmarks können direkt auf X gelöscht werden.

## Was sie tut

1. **Credentials erfassen** (nur zur Laufzeit): Der Service Worker lauscht auf
   ausgehende Requests nach x.com und erfasst `Authorization: Bearer` und
   `x-csrf-token` — genau die Header, die der eingeloggte Browser selbst sendet.
   Es gibt keine hartcodierten Keys.
2. **Bookmarks fetchen**: Das isolierte Content-Script ruft den originalen
   X-GraphQL-Endpunkt `Bookmarks` paginiert auf — mit der echten URL inkl.
   `features`-Parameter, also 1:1 das Verhalten der X-Web-App.
3. **Transformieren**: Entries werden in ein internes Format überführt
   (inkl. Edge-Cases wie `TweetWithVisibilityResults` und der neuen
   X-User-Struktur).
4. **Sync ins Dashboard**: Die Ergebnisse gehen an das eigene Dashboard
   (`x-bookmarks.de`, Vercel-Deployment oder lokal per `localhost:3000`).
5. **Reverse-Flow**: Nach erfolgreichem Import kann die Extension Bookmarks
   auf X löschen. Die `DeleteBookmark`-QueryId wird dynamisch erfasst,
   im MAIN-World-Script abgefangen und persistiert — kein manuelles Nachschlagen.

## Architektur

```
x.com-Seite
├── content_main.js   (MAIN world, document_start)
│                     fängt DeleteBookmark-QueryIds aus der Seite ab
│                     → window-Event "xbm.deleteQueryId"
├── content.js        (isolated world)
│                     fetcht Bookmarks paginiert mit den echten Headern,
│                     transformiert Entries, steuert DeleteBookmark
└── background.js     (service worker)
                      erfasst Bearer/CSRF per webRequest (nur Laufzeit),
                      koordiniert Sync-Status, persistiert deleteQueryId
```

Kommunikation mit dem Dashboard läuft über `chrome.runtime messaging`
(`externally_connectable` ist auf die eigenen Domains + localhost beschränkt).

## Installation (Developer-Modus)

1. Repo klonen oder ZIP entpacken
2. Chrome → `chrome://extensions` → **Entwicklermodus** aktivieren
3. **Entladene Erweiterung laden** → Ordner auswählen
4. Auf x.com einloggen, Extension-Icon öffnen → Sync starten

## Datenschutz

- Tokens werden ausschließlich zur Laufzeit erfasst und flüchtig gehalten —
  es wird nichts an Dritte gesendet, nur an das konfigurierte eigene Dashboard.
- Kein Tracking, keine Analytics, keine externen Server.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
