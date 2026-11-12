// The mobile server proxies /api/ to the ASHRAAY API, so phones on the LAN need no CORS or port 8000 access.
window.ASHRAAY_API_BASE = `${location.origin}/api/v1`;
