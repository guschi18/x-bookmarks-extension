/**
 * Läuft in der MAIN world.
 * Fängt die DeleteBookmark-QueryId ab — X.com nutzt fetch() für GraphQL.
 */
(function () {
  'use strict';

  function extractAndDispatch(url) {
    if (url && url.includes('/graphql/') && url.includes('DeleteBookmark')) {
      const match = url.match(/\/graphql\/([^/]+)\/DeleteBookmark/);
      if (match) {
        window.dispatchEvent(new CustomEvent('xbm.deleteQueryId', {
          detail: { queryId: match[1] }
        }));
      }
    }
  }

  // fetch patchen (X.com nutzt primär fetch für GraphQL)
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
    extractAndDispatch(url);
    return originalFetch.apply(this, args);
  };

  // XHR als Fallback
  const originalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new originalXHR();
    const originalOpen = xhr.open.bind(xhr);
    xhr.open = function (...args) {
      extractAndDispatch(args[1] || '');
      return originalOpen(...args);
    };
    return xhr;
  };
  Object.assign(window.XMLHttpRequest, originalXHR);
})();
