// Where uploaded images are actually written.
//
// THE BUG THIS EXISTS TO FIX
//
// controllers/admin/uploads.js used to write straight to the filesystem at
// `../../../MFB_PHP_ADMIN_PANEL/admin/assets/uploads`. That path is a sibling
// directory in the local monorepo, so it is correct on a laptop and meaningless
// on a deployed host, where the API and the PHP asset host are different
// machines. Worse, the write used mkdir({recursive:true}), so it SUCCEEDED
// anywhere: the endpoint returned 201, the filename went into the database, and
// the bytes landed in a container directory nothing served and the next restart
// deleted. Every banner, product, vendor and promo image uploaded through the
// deployed panel was silently discarded, and the only visible symptom was a
// broken image weeks later.
//
// So this module has two jobs, and the second matters as much as the first:
//
//   1. Write to the PHP host over FTP when that is configured, so the file
//      lands where www.myfirstbite.in already serves /assets/uploads from —
//      which keeps every existing image URL working and needs no app release.
//      (The customer app hardcodes that origin; see MFB-Mobile-App
//      constants/urls.js.)
//   2. REFUSE to accept an upload it cannot store durably, rather than
//      reporting success. A 503 an admin can see beats a silent loss.
const fs = require("node:fs/promises");
const path = require("node:path");

// Local target. Still the right answer in development, where the PHP app really
// is a sibling directory and its assets are served from :8091.
const LOCAL_ROOT =
  process.env.UPLOADS_ROOT ||
  path.resolve(__dirname, "../../MFB_PHP_ADMIN_PANEL/admin/assets/uploads");

/** FTP settings, or null when the remote store is not configured. */
function remoteConfig() {
  const host = (process.env.UPLOADS_FTP_HOST || "").trim();
  const user = (process.env.UPLOADS_FTP_USER || "").trim();
  const password = process.env.UPLOADS_FTP_PASSWORD || "";
  if (!host || !user || !password) return null;
  return {
    host,
    user,
    password,
    port: Number(process.env.UPLOADS_FTP_PORT || 21),
    // FTPS by default — these are credentials and image bytes crossing the
    // public internet. Set UPLOADS_FTP_SECURE=false only if the host genuinely
    // cannot negotiate TLS.
    secure: String(process.env.UPLOADS_FTP_SECURE || "true").toLowerCase() !== "false",
    // Directory on the host that is published as /assets/uploads, expressed as
    // it looks AFTER logging in — which is the part that catches people out.
    //
    // A hosting panel can scope an FTP account to a subdirectory, and such an
    // account lands directly in it. Pointing this at "public_html/assets/uploads"
    // in that case would try to create public_html/assets/uploads *inside* the
    // uploads directory and file everything one level too deep, silently.
    //
    // So "", "." and "/" all mean "the login directory is already the right
    // one", and are normalised to an empty prefix rather than an absolute "/".
    root: normaliseRoot(process.env.UPLOADS_FTP_ROOT),
  };
}

/** "", ".", "/" and "a/b/" all become a clean relative prefix. */
function normaliseRoot(raw) {
  const value = raw === undefined ? "public_html/assets/uploads" : String(raw);
  const trimmed = value.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return trimmed === "." ? "" : trimmed;
}

/** Joins the login-relative root to a sub-path without ever going absolute. */
function remotePath(root, rest) {
  return root ? `${root}/${rest}` : rest;
}

const remoteConfigured = () => remoteConfig() != null;

/**
 * True when writing locally would throw the file away.
 *
 * A deployed host has no PHP app beside it, so the local path resolves to a
 * container directory that nothing serves and a restart wipes. UPLOADS_ROOT
 * being set explicitly is taken as "I know what this path is" — a mounted disk,
 * say — and is honoured.
 */
function localIsEphemeral() {
  const deployed = (process.env.NODE_ENV || "development") === "production";
  return deployed && !process.env.UPLOADS_ROOT;
}

/** Human-readable description of where uploads go, for the boot banner. */
function describe() {
  if (remoteConfigured()) {
    const { host, root } = remoteConfig();
    return `FTP ${host}:${root ? `/${root}` : " (login directory)"}`;
  }
  if (localIsEphemeral()) return "NOT CONFIGURED — uploads will be refused";
  return `local ${LOCAL_ROOT}`;
}

/** Raised when an upload cannot be stored anywhere durable. */
class UploadUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadUnavailable";
    this.unavailable = true;
  }
}

const NOT_CONFIGURED =
  "Image storage is not configured on this server, so the upload was refused " +
  "rather than silently lost. Set UPLOADS_FTP_HOST / UPLOADS_FTP_USER / " +
  "UPLOADS_FTP_PASSWORD (see .env.production.example).";

/** Runs `fn` against a connected FTP client, always closing it. */
async function withClient(fn) {
  // Required lazily so a deployment that never uploads does not pay for the
  // module, and so the tests can run without it being reachable.
  const { Client } = require("basic-ftp");
  const cfg = remoteConfig();
  const client = new Client(Number(process.env.UPLOADS_FTP_TIMEOUT_MS || 30000));
  try {
    await client.access({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      secure: cfg.secure,
      // Hostinger's certificate is issued for the hosting domain rather than
      // the FTP hostname, which makes strict verification fail on a perfectly
      // good connection. The credentials and payload are still encrypted.
      secureOptions: { rejectUnauthorized: false },
    });
    return await fn(client, cfg);
  } finally {
    client.close();
  }
}

/**
 * Stores one image and returns where it went.
 *
 * Throws on failure — deliberately. The caller turns that into a non-2xx, which
 * is the whole point: an upload that did not land must not look like one that
 * did.
 */
async function putImage({ kind, ext, base, buffer }) {
  const relative = `${kind}/${ext}/${base}.${ext}`;

  if (remoteConfigured()) {
    const { Readable } = require("node:stream");
    await withClient(async (client, cfg) => {
      // ensureDir creates the whole chain and leaves the CWD there, so the
      // upload path is relative to it afterwards. Kept RELATIVE to the login
      // directory: a leading "/" would address the server's FTP root, which is
      // not the account's home on a scoped account.
      await client.ensureDir(remotePath(cfg.root, `${kind}/${ext}`));
      await client.uploadFrom(Readable.from(buffer), `${base}.${ext}`);
    });
    return { stored: "remote", path: relative };
  }

  if (localIsEphemeral()) {
    throw new UploadUnavailable(NOT_CONFIGURED);
  }

  const dir = path.join(LOCAL_ROOT, kind, ext);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${base}.${ext}`), buffer);
  return { stored: "local", path: relative };
}

/**
 * Deletes both renditions of an image. A missing file is not an error, so the
 * call stays safe to retry.
 */
async function removeImage({ kind, base }) {
  if (remoteConfigured()) {
    return withClient(async (client, cfg) => {
      let removed = 0;
      for (const ext of ["webp", "jpg"]) {
        try {
          await client.remove(remotePath(cfg.root, `${kind}/${ext}/${base}.${ext}`));
          removed += 1;
        } catch {
          // Already gone.
        }
      }
      return removed;
    });
  }

  if (localIsEphemeral()) {
    throw new UploadUnavailable(NOT_CONFIGURED);
  }

  let removed = 0;
  for (const ext of ["webp", "jpg"]) {
    try {
      await fs.unlink(path.join(LOCAL_ROOT, kind, ext, `${base}.${ext}`));
      removed += 1;
    } catch {
      // Already gone.
    }
  }
  return removed;
}

module.exports = {
  putImage,
  _normaliseRoot: normaliseRoot,
  _remotePath: remotePath,
  removeImage,
  describe,
  remoteConfigured,
  localIsEphemeral,
  UploadUnavailable,
  LOCAL_ROOT,
};
