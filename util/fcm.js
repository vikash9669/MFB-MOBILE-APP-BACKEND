// Firebase Cloud Messaging sender (HTTP v1 API).
//
// Uses a Google service account to mint a short-lived OAuth access token, then
// POSTs to fcm.googleapis.com/v1/projects/<id>/messages:send. The legacy
// /fcm/send server-key API was shut down by Google in 2024, so v1 is required.
//
// Config (from the service-account JSON — set in .env):
//   FCM_PROJECT_ID     project_id
//   FCM_CLIENT_EMAIL   client_email
//   FCM_PRIVATE_KEY    private_key   (keep the \n escapes; they're unescaped here)
//
// When these are unset the module is a graceful no-op: notifications are still
// persisted to the DB, they just aren't pushed. No new dependencies — token
// signing uses jsonwebtoken (already installed) and the global fetch (Node 18+).
const jwt = require("jsonwebtoken");

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const projectId = () => process.env.FCM_PROJECT_ID;
const clientEmail = () => process.env.FCM_CLIENT_EMAIL;
// Support both raw multiline keys and single-line keys with escaped newlines.
const privateKey = () => (process.env.FCM_PRIVATE_KEY || "").replaceAll(String.raw`\n`, "\n");

const isConfigured = () => Boolean(projectId() && clientEmail() && privateKey());

// Cached access token so we don't re-auth on every push.
let cachedToken = null;
let cachedExp = 0;

// Exchanges a signed service-account JWT for an OAuth2 access token.
const getAccessToken = async () => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExp - 60) {
    return cachedToken;
  }

  const assertion = jwt.sign(
    { scope: SCOPE },
    privateKey(),
    {
      algorithm: "RS256",
      issuer: clientEmail(),
      audience: OAUTH_TOKEN_URL,
      subject: clientEmail(),
      expiresIn: 3600,
    }
  );

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`FCM auth failed: ${data.error_description || data.error || res.status}`);
  }

  cachedToken = data.access_token;
  cachedExp = now + (data.expires_in || 3600);
  return cachedToken;
};

// True when FCM says the token is gone/invalid and we should delete it.
const isDeadTokenError = (status, body) => {
  if (status === 404) {
    return true;
  }
  const errStatus = body?.error?.status;
  const details = body?.error?.details || [];
  const code = details.find((d) => d.errorCode)?.errorCode;
  return (
    errStatus === "NOT_FOUND" ||
    code === "UNREGISTERED" ||
    code === "INVALID_ARGUMENT"
  );
};

// Sends one notification to many tokens. FCM v1 has no multicast, so we fan out
// (partners have only a handful of devices). Returns the tokens FCM rejected as
// permanently dead so the caller can prune them.
//
// message: { title, body, data? }  — data values are coerced to strings (FCM
// requires string values in the data payload).
const sendToTokens = async (tokens, message) => {
  const dead = [];
  if (!isConfigured() || !Array.isArray(tokens) || tokens.length === 0) {
    return { sent: 0, dead };
  }

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.log("MFB-error-logs ~ fcm getAccessToken ~ err:", err.message);
    return { sent: 0, dead };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${projectId()}/messages:send`;
  const dataPayload = {};
  Object.entries(message.data || {}).forEach(([k, v]) => {
    dataPayload[k] = String(v);
  });

  let sent = 0;
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              data: dataPayload,
              // No channel_id: use FCM's auto-created default channel so
              // notifications always display without the app pre-registering one.
              android: { priority: "high" },
              apns: { headers: { "apns-priority": "10" } },
            },
          }),
        });
        if (res.ok) {
          sent += 1;
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (isDeadTokenError(res.status, body)) {
          dead.push(token);
        } else {
          console.log("MFB-error-logs ~ fcm send ~ status:", res.status, body?.error?.message);
        }
      } catch (err) {
        console.log("MFB-error-logs ~ fcm send ~ err:", err.message);
      }
    })
  );

  return { sent, dead };
};

module.exports = { isConfigured, sendToTokens };
