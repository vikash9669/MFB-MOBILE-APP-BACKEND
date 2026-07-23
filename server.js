// Keep-alive ping so the free Render instance doesn't sleep. This only makes
// sense for the deployed app, so it's skipped in local dev and any failure is
// swallowed — a failed ping must never crash the server process.
const KEEP_ALIVE_URL = "https://mfb-mobile-app-backend.onrender.com/restaurant";

async function ping() {
  try {
    const response = await fetch(KEEP_ALIVE_URL);
    await response.json();
  } catch (err) {
    console.log("MFB-error-logs ~ keep-alive ping failed:", err.message);
  }
}

if (process.env.NODE_ENV === "production") {
  setInterval(ping, 90 * 1000);
}
