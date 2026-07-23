// Access + refresh token helpers for the delivery-partner auth flow.
// Access tokens are short-lived and signed with JWT_SECRET_KEY (so the existing
// verifyToken middleware validates them). Refresh tokens are long-lived, signed
// with a separate secret, and paired with a per-partner token version in the DB
// so they can be revoked (logout / force-logout-all).
const jwt = require("jsonwebtoken");

const ACCESS_TTL = "30m";
const REFRESH_TTL = "60d";

const accessSecret = () => process.env.JWT_SECRET_KEY;
const refreshSecret = () =>
  process.env.JWT_REFRESH_SECRET_KEY || `${process.env.JWT_SECRET_KEY}-refresh`;

const signAccessToken = (payload) =>
  jwt.sign({ ...payload, type: "access" }, accessSecret(), {
    expiresIn: ACCESS_TTL,
  });

const signRefreshToken = (payload) =>
  jwt.sign({ ...payload, type: "refresh" }, refreshSecret(), {
    expiresIn: REFRESH_TTL,
  });

const verifyRefreshToken = (token) => jwt.verify(token, refreshSecret());

module.exports = {
  ACCESS_TTL,
  REFRESH_TTL,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
};
