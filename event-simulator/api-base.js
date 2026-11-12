// Tells the client to call the API through this server's own origin (proxied), so the
// event simulator works both on localhost and from other devices on the same network/hotspot.
window.ASHRAAY_API_BASE = `${location.origin}/api/v1`;
