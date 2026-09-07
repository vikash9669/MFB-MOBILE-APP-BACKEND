const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const uploadStore = require("../util/uploadStore");

// Where an uploaded image goes, and — the part that actually bit — what
// happens when there is nowhere for it to go.
//
// The original code wrote to a path that only exists in the local monorepo,
// with mkdir({recursive:true}), so on a deployed host the write SUCCEEDED into
// a container directory nothing served and the next restart deleted. The
// endpoint returned 201, the filename went into the database, and every banner,
// product and vendor image uploaded through the deployed panel was lost. The
// only symptom was a broken image, weeks later.
//
// So the rule under test is: store it, or refuse it. Never report success for
// bytes that are already gone.

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const NO_REMOTE = {
  UPLOADS_FTP_HOST: undefined,
  UPLOADS_FTP_USER: undefined,
  UPLOADS_FTP_PASSWORD: undefined,
};
const REMOTE = {
  UPLOADS_FTP_HOST: "ftp.example.com",
  UPLOADS_FTP_USER: "someuser",
  UPLOADS_FTP_PASSWORD: "secret",
};

test("a deployed host with no storage configured REFUSES the upload", async () => {
  // The whole point. Previously this path returned 201 and threw the file away.
  await withEnv({ NODE_ENV: "production", UPLOADS_ROOT: undefined, ...NO_REMOTE }, async () => {
    await assert.rejects(
      () => uploadStore.putImage({ kind: "banners", ext: "webp", base: "x", buffer: Buffer.from("hi") }),
      (err) => {
        assert.strictEqual(err.unavailable, true, "must be flagged so the route can answer 503");
        assert.match(err.message, /UPLOADS_FTP_HOST/, "must name the fix");
        return true;
      },
    );
  });
});

test("deleting an image is refused the same way, not reported as done", async () => {
  // "Nothing to remove" would be a lie that hides the same misconfiguration.
  await withEnv({ NODE_ENV: "production", UPLOADS_ROOT: undefined, ...NO_REMOTE }, async () => {
    await assert.rejects(
      () => uploadStore.removeImage({ kind: "banners", base: "x" }),
      (err) => err.unavailable === true,
    );
  });
});

test("an explicit UPLOADS_ROOT is trusted even in production", async () => {
  // Someone who sets the path has said "I know what this is" — a mounted disk,
  // say. Refusing that would break a legitimate deployment.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mfb-uploads-"));
  await withEnv({ NODE_ENV: "production", UPLOADS_ROOT: dir, ...NO_REMOTE }, async () => {
    assert.strictEqual(uploadStore.localIsEphemeral(), false);
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("development still writes to the local PHP assets directory", async () => {
  await withEnv({ NODE_ENV: "development", UPLOADS_ROOT: undefined, ...NO_REMOTE }, () => {
    assert.strictEqual(uploadStore.localIsEphemeral(), false);
    assert.strictEqual(uploadStore.remoteConfigured(), false);
    assert.match(uploadStore.describe(), /^local /);
  });
});

test("the remote store needs all three credentials, not just a host", async () => {
  // A half-filled dashboard is the likely failure, and it must not read as
  // "configured" — that would send uploads to a client that cannot log in.
  await withEnv({ ...NO_REMOTE, UPLOADS_FTP_HOST: "ftp.example.com" }, () => {
    assert.strictEqual(uploadStore.remoteConfigured(), false);
  });
  await withEnv({ ...NO_REMOTE, UPLOADS_FTP_HOST: "ftp.example.com", UPLOADS_FTP_USER: "u" }, () => {
    assert.strictEqual(uploadStore.remoteConfigured(), false);
  });
  await withEnv(REMOTE, () => {
    assert.strictEqual(uploadStore.remoteConfigured(), true);
  });
});

test("blank strings do not count as configuration", async () => {
  // A field cleared in a hosting dashboard comes back as "", not unset.
  await withEnv({ ...REMOTE, UPLOADS_FTP_USER: "   " }, () => {
    assert.strictEqual(uploadStore.remoteConfigured(), false);
  });
});

test("the boot banner names the destination without leaking the password", async () => {
  await withEnv({ ...REMOTE, UPLOADS_FTP_ROOT: "public_html/assets/uploads" }, () => {
    const shown = uploadStore.describe();
    assert.match(shown, /ftp\.example\.com/);
    assert.match(shown, /public_html\/assets\/uploads/);
    assert.ok(!shown.includes("secret"), "the password must never reach the log");
    assert.ok(!shown.includes("someuser"), "nor the username");
  });
});

test("a configured remote wins over the local path", async () => {
  await withEnv({ NODE_ENV: "development", ...REMOTE }, () => {
    assert.strictEqual(uploadStore.remoteConfigured(), true);
    assert.match(uploadStore.describe(), /^FTP /);
  });
});

test("a trailing slash on the remote root does not double up the path", async () => {
  await withEnv({ ...REMOTE, UPLOADS_FTP_ROOT: "public_html/assets/uploads///" }, () => {
    assert.match(uploadStore.describe(), /public_html\/assets\/uploads$/);
  });
});

// ── The scoped-FTP-account trap ─────────────────────────────────────
//
// A hosting panel can restrict an FTP account to a subdirectory, and such an
// account lands *inside* it on login. Leaving UPLOADS_FTP_ROOT at the default
// then creates public_html/assets/uploads INSIDE the uploads directory and
// files every image one level too deep — an upload that reports success and
// serves a 404, which is the exact failure this whole module exists to end.

test("an empty, '.' or '/' root means 'already in the right directory'", () => {
  for (const raw of ["", ".", "/", "  ", " / "]) {
    assert.strictEqual(
      uploadStore._normaliseRoot(raw), "",
      `${JSON.stringify(raw)} should normalise to no prefix`,
    );
  }
});

test("the upload path stays relative, never absolute", () => {
  // A leading "/" would address the FTP server's root rather than the
  // account's home, which on a scoped account is a different place entirely.
  const path = uploadStore._remotePath(uploadStore._normaliseRoot("/"), "banners/webp");
  assert.strictEqual(path, "banners/webp");
  assert.ok(!path.startsWith("/"), "must not be absolute");
});

test("a leading slash or trailing slashes on the root are tolerated", () => {
  const expected = "public_html/assets/uploads";
  for (const raw of [expected, `/${expected}`, `${expected}///`, ` ${expected} `]) {
    assert.strictEqual(uploadStore._normaliseRoot(raw), expected, `failed on ${JSON.stringify(raw)}`);
  }
});

test("an unset root keeps the documented Hostinger default", () => {
  assert.strictEqual(uploadStore._normaliseRoot(undefined), "public_html/assets/uploads");
});
