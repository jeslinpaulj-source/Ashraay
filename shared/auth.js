(function (global) {
const auth = (() => {
  let config;
  let provider;
  let tokens;
  let refreshTimer;
  let refreshPromise;

  const api = global.ASHRAAY_API_BASE || `${location.protocol}//${location.hostname}:8000/api/v1`;
  const redirectUri = `${location.origin}/`;
  const readJwt = (value) => {
    const encoded = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(encoded.padEnd(encoded.length + ((4 - encoded.length % 4) % 4), "=")));
  };
  const random = (length = 32) => {
    const data = crypto.getRandomValues(new Uint8Array(length));
    return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };
  function sha256(value) {
    const primes = [];
    for (let candidate = 2; primes.length < 64; candidate++) {
      if (primes.every((prime) => candidate % prime !== 0)) primes.push(candidate);
    }
    const constants = primes.map((prime) => Math.floor((Math.cbrt(prime) % 1) * 0x100000000));
    const state = primes.slice(0, 8).map((prime) => Math.floor((Math.sqrt(prime) % 1) * 0x100000000));
    const message = Array.from(new TextEncoder().encode(value));
    const bitLength = message.length * 8;
    message.push(0x80);
    while (message.length % 64 !== 56) message.push(0);
    for (let shift = 56; shift >= 0; shift -= 8) message.push(Math.floor(bitLength / 2 ** shift) & 255);
    const rotate = (number, count) => (number >>> count) | (number << (32 - count));
    for (let offset = 0; offset < message.length; offset += 64) {
      const words = new Array(64);
      for (let index = 0; index < 16; index++) {
        const start = offset + index * 4;
        words[index] = (message[start] << 24) | (message[start + 1] << 16) | (message[start + 2] << 8) | message[start + 3];
      }
      for (let index = 16; index < 64; index++) {
        const x = words[index - 15];
        const y = words[index - 2];
        const small0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
        const small1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
        words[index] = (words[index - 16] + small0 + words[index - 7] + small1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let index = 0; index < 64; index++) {
        const big1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + big1 + choice + constants[index] + words[index]) | 0;
        const big0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (big0 + majority) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      for (let index = 0; index < 8; index++) state[index] = (state[index] + [a, b, c, d, e, f, g, h][index]) | 0;
    }
    return new Uint8Array(state.flatMap((word) => [
      (word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255
    ]));
  }
  const digest = async (value) => btoa(String.fromCharCode(...sha256(value)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const randomId = () => {
    const data = crypto.getRandomValues(new Uint8Array(16));
    data[6] = (data[6] & 15) | 64;
    data[8] = (data[8] & 63) | 128;
    const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const endpoint = (name) => ({
    auth: provider?.authorization_endpoint,
    token: provider?.token_endpoint,
    logout: provider?.end_session_endpoint
  })[name];

  async function exchange(body) {
    const response = await fetch(endpoint("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    });
    if (!response.ok) throw new Error(`Identity provider token request failed (${response.status}).`);
    tokens = await response.json();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, Math.max(10000, (tokens.expires_in - 60) * 1000));
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = refreshTokens();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = undefined;
    }
  }

  async function refreshTokens() {
    if (tokens?.local) {
      clearSession();
      location.assign(redirectUri);
      return new Promise(() => {});
    }
    if (!tokens?.refresh_token) return login();
    try {
      await exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: config.clientId
      });
    } catch (error) {
      console.error(error);
      tokens = undefined;
      await login();
    }
  }

  async function login() {
    const verifier = random(48);
    const state = random();
    const nonce = random();
    sessionStorage.setItem("ashraay.oauth", JSON.stringify({ verifier, state, nonce }));
    const query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scopes,
      state,
      nonce,
      code_challenge: await digest(verifier),
      code_challenge_method: "S256"
    });
    location.assign(`${endpoint("auth")}?${query}`);
  }

  function logout() {
    if (tokens?.local || !config) {
      clearSession();
      location.assign(redirectUri);
      return;
    }
    const logoutEndpoint = endpoint("logout");
    if (!logoutEndpoint) {
      tokens = undefined;
      clearTimeout(refreshTimer);
      location.assign(redirectUri);
      return;
    }
    const query = new URLSearchParams({
      client_id: config.clientId,
      post_logout_redirect_uri: redirectUri,
      ...(tokens?.id_token ? { id_token_hint: tokens.id_token } : {})
    });
    tokens = undefined;
    clearTimeout(refreshTimer);
    location.assign(`${logoutEndpoint}?${query}`);
  }

  async function initialize() {
    if (tokens?.local) return;
    const configResponse = await fetch(`${api}/config`);
    if (!configResponse.ok) throw new Error("Cannot load identity provider configuration.");
    config = await configResponse.json();
    const discoveryResponse = await fetch(
      `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`
    );
    if (!discoveryResponse.ok) throw new Error("Cannot load OIDC provider discovery metadata.");
    provider = await discoveryResponse.json();
    if (
      provider.issuer?.replace(/\/+$/, "") !== config.issuer.replace(/\/+$/, "") ||
      typeof provider.authorization_endpoint !== "string" ||
      typeof provider.token_endpoint !== "string"
    ) {
      throw new Error("OIDC discovery metadata does not match the configured issuer.");
    }
    const callback = new URLSearchParams(location.search);
    if (callback.has("error")) throw new Error(callback.get("error_description") || callback.get("error"));
    if (callback.has("code")) {
      const saved = JSON.parse(sessionStorage.getItem("ashraay.oauth") || "null");
      sessionStorage.removeItem("ashraay.oauth");
      if (!saved || saved.state !== callback.get("state")) throw new Error("Identity callback state did not match.");
      await exchange({
        grant_type: "authorization_code",
        code: callback.get("code"),
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: saved.verifier
      });
      if (!tokens.id_token || readJwt(tokens.id_token).nonce !== saved.nonce) {
        tokens = undefined;
        throw new Error("Identity token nonce did not match the sign-in request.");
      }
      history.replaceState({}, document.title, location.pathname);
    }
    if (!tokens) await login();
  }

  async function request(path, options = {}, retried = false) {
    if (!tokens?.access_token) throw new Error("Sign-in is required.");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${tokens.access_token}`);
    const response = await fetch(`${api}${path}`, { ...options, headers });
    if (response.status === 401 && !retried) {
      await refresh();
      return request(path, options, true);
    }
    if (!response.ok) {
      let message = response.status === 401
        ? "Authentication expired. Sign in again."
        : `Request failed (${response.status}).`;
      const text = await response.text();
      if (text && response.status !== 401) {
        try {
          const payload = JSON.parse(text);
          message = typeof payload.detail === "string" ? payload.detail : text;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          message = text;
        }
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function identity() {
    return tokens ? readJwt(tokens.access_token) : null;
  }

  function hasRole(...roles) {
    return Boolean(getRoles().some((role) => roles.includes(role)));
  }

  function getRoles() {
    const claims = identity();
    return claims?.realm_access?.roles || claims?.roles || [];
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));

  const roleNames = {
    "resident-reporter": "Resident Reporter",
    volunteer: "Volunteer",
    "field-team": "Field Team / Volunteer",
    verifier: "Verifier",
    "incident-commander": "Incident Commander",
    "response-agency": "Response Agency",
    "platform-admin": "Platform Admin"
  };
  const roleLabel = (role) => roleNames[role] || role;

  function postJson(path, body = {}, { key, signal } = {}) {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key || randomId() },
      body: JSON.stringify(body),
      signal
    });
  }

  function rewriteAppLinks() {
    document.querySelectorAll("a[data-port]").forEach((link) => {
      link.href = `${location.protocol}//${location.hostname}:${link.dataset.port}${link.dataset.path || "/"}`;
    });
  }

  // True while returning from the identity provider redirect (has ?code= or ?error=).
  function hasCallback() {
    const query = new URLSearchParams(location.search);
    return query.has("code") || query.has("error");
  }

  // Built-in citizen/volunteer accounts (phone + password/MPIN), issued by the ASHRAAY API.
  const sessionKey = "ashraay.session";

  function clearSession() {
    tokens = undefined;
    clearTimeout(refreshTimer);
    sessionStorage.removeItem(sessionKey);
    localStorage.removeItem(sessionKey);
  }

  function storeSession(payload, remember) {
    clearSession();
    tokens = { access_token: payload.access_token, local: true };
    (remember ? localStorage : sessionStorage).setItem(sessionKey, JSON.stringify({ access_token: payload.access_token }));
  }

  function restoreSession() {
    const raw = localStorage.getItem(sessionKey) || sessionStorage.getItem(sessionKey);
    if (!raw) return false;
    try {
      const { access_token: accessToken } = JSON.parse(raw);
      if (readJwt(accessToken).exp * 1000 > Date.now() + 60000) {
        tokens = { access_token: accessToken, local: true };
        return true;
      }
    } catch (error) {
      console.warn("Discarding unreadable saved session.", error);
    }
    clearSession();
    return false;
  }

  const isLocalSession = () => Boolean(tokens?.local);

  async function publicPost(path, body) {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        payload = { detail: text };
      }
    }
    if (!response.ok) {
      const detail = payload.detail;
      const message = typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((item) => String(item.msg || "").replace(/^Value error, /, "")).join(" ")
          : `Request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function signIn({ role, phone, password, mpin, remember }) {
    const payload = await publicPost("/auth/login", { role, phone, password: password || null, mpin: mpin || null });
    storeSession(payload, remember);
  }

  async function register({ role, name, phone, email, password, mpin, latitude, longitude, remember = true }) {
    const payload = await publicPost("/auth/register", {
      role, name: name || null, phone, email, password, mpin: mpin || null,
      latitude: latitude ?? null, longitude: longitude ?? null,
    });
    storeSession(payload, remember);
  }

  const forgotPassword = (identifier) => publicPost("/auth/password/forgot", { identifier });
  const resetPassword = ({ identifier, code, newPassword, newMpin }) =>
    publicPost("/auth/password/reset", { identifier, code, newPassword, newMpin: newMpin || null });

  return {
    initialize, login, logout, request, identity, hasRole, randomId, roles: getRoles,
    escapeHtml, postJson, roleLabel, rewriteAppLinks, hasCallback,
    signIn, register, forgotPassword, resetPassword, restoreSession, clearSession, isLocalSession
  };
})();
global.ashraayAuth = auth;
})(window);
