import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { Pool } from "pg";

/**
 * DBHistory (Render + Postgres)
 * - Auth (simple password)
 * - Ingest:
 *    * UI paste text: POST /ingest-text (urlencoded)  ✅ no multipart/busboy
 *    * UI file upload: POST /upload (multipart)       ✅ uses multer
 *    * API ingest: POST /api/ingest (text/plain)      ✅ for automation
 * - Pages:
 *    * / (main)
 *    * /charts
 *    * /diff
 *    * /snapshots (+ delete)
 *    * /login
 */

// -------------------- Config --------------------
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || "";
const INGEST_API_KEY = process.env.INGEST_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || ""; // password for UI
const COOKIE_SECRET = process.env.COOKIE_SECRET || "change-me";

if (!DATABASE_URL) {
  // Render provides DATABASE_URL for Postgres.
  console.warn("WARNING: DATABASE_URL is empty.");
}
if (!APP_PASSWORD) {
  console.warn("WARNING: APP_PASSWORD is empty. UI will be unprotected.");
}
if (!INGEST_API_KEY) {
  console.warn("WARNING: INGEST_API_KEY is empty. /api/ingest will be unprotected.");
}

const pool = new Pool({ connectionString: DATABASE_URL });

// -------------------- App --------------------
const app = express();

// IMPORTANT: for paste-text form we use urlencoded; this avoids busboy/multipart issues.
app.use(express.urlencoded({ extended: false, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ type: "text/plain", limit: "10mb" }));

app.use(cookieParser(COOKIE_SECRET));

// -------------------- DB init --------------------
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id BIGSERIAL PRIMARY KEY,
      snapshot_at TIMESTAMPTZ NOT NULL,
      server_name TEXT NULL
    );
  `);

  // Optional uniqueness (helps avoid duplicates on same day+server).
  // If you already have this constraint, this will do nothing.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'snapshots_snapshot_at_server_idx'
      ) THEN
        CREATE INDEX snapshots_snapshot_at_server_idx ON snapshots (snapshot_at DESC, server_name);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS db_sizes (
      id BIGSERIAL PRIMARY KEY,
      snapshot_id BIGINT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      datname TEXT NOT NULL,
      size_pretty TEXT NOT NULL,
      size_bytes BIGINT NOT NULL
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'db_sizes_snapshot_datname_idx'
      ) THEN
        CREATE INDEX db_sizes_snapshot_datname_idx ON db_sizes (snapshot_id, datname);
      END IF;
    END $$;
  `);
}
ensureSchema().catch((e) => console.error("Schema init failed:", e));

// -------------------- Auth --------------------
function isAuthed(req: express.Request): boolean {
  if (!APP_PASSWORD) return true; // allow if no password configured
  return req.cookies?.auth === "1";
}
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isAuthed(req)) return next();
  return res.redirect("/login");
}

app.get("/login", (req, res) => {
  const msg = typeof req.query?.err === "string" ? req.query.err : "";
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Login</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;margin:24px;max-width:520px}
    input{padding:10px;width:100%;box-sizing:border-box;margin:8px 0}
    button{padding:10px 14px}
    .err{color:#b00020}
  </style>
</head>
<body>
  <h2>DBHistory</h2>
  ${msg ? `<p class="err">${escapeHtml(msg)}</p>` : ""}
  <form method="post" action="/login">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>
`);
});

app.post("/login", (req, res) => {
  const pw = String((req.body as any)?.password || "");
  if (!APP_PASSWORD || pw === APP_PASSWORD) {
    res.cookie("auth", "1", { httpOnly: true, sameSite: "lax", secure: true });
    return res.redirect("/");
  }
  return res.redirect("/login?err=" + encodeURIComponent("Wrong password"));
});

app.get("/logout", (req, res) => {
  res.clearCookie("auth");
  res.redirect("/login");
});

// -------------------- Helpers --------------------
function escapeHtml(s: any): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtBytesPretty(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let b = bytes;
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  const n = i === 0 ? Math.round(b) : Math.round(b * 10) / 10;
  return `${n} ${units[i]}`;
}

function toUtcMidnightIsoFromDateOnly(dateOnly: string): string | null {
  // dateOnly: YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  // Force UTC midnight
  return new Date(dateOnly + "T00:00:00Z").toISOString();
}

function normalizeTextInput(text: string): string {
  // Normalize common copy/paste issues (NBSP, weird unicode spaces)
  return String(text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// -------------------- Parsing --------------------
type ParsedDbSizeRow = { datname: string; size_pretty: string; size_bytes: number };

function parsePrettySizeToBytes(s: string): number | null {
  const str = String(s ?? "").trim();
  if (!str) return null;

  // Examples: "39 GB", "4512 MB", "7779 kB"
  const m = str.match(/^(-?\d+(?:[.,]\d+)?)\s*([A-Za-z]+)$/);
  if (!m) return null;

  const num = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(num)) return null;

  const unit = m[2].toLowerCase();

  const mul = (p: number) => Math.round(num * Math.pow(1024, p));

  if (unit === "b" || unit === "byte" || unit === "bytes") return Math.round(num);
  if (unit === "kb" || unit === "kib") return mul(1);
  if (unit === "mb" || unit === "mib") return mul(2);
  if (unit === "gb" || unit === "gib") return mul(3);
  if (unit === "tb" || unit === "tib") return mul(4);
  if (unit === "pb" || unit === "pib") return mul(5);

  // tolerate Postgres kB -> "kb" already after toLowerCase()
  if (unit === "k") return mul(1);
  if (unit === "m") return mul(2);
  if (unit === "g") return mul(3);
  if (unit === "t") return mul(4);
  if (unit === "p") return mul(5);

  return null;
}

function parsePgSizeOutput(input: string): ParsedDbSizeRow[] {
  const text = normalizeTextInput(input);
  const lines = text.split("\n");

  const rows: ParsedDbSizeRow[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // ignore headers/separators/footers from psql pretty output
    if (/^\(\d+\s+rows\)/i.test(line)) continue;
    if (/^-+\+-+/.test(line)) continue;
    if (/^datname\s*\|\s*pg_size_pretty/i.test(line)) continue;

    if (!line.includes("|")) continue;

    const parts = line.split("|");
    if (parts.length < 2) continue;

    const datname = parts[0].trim();
    const size_pretty = parts[1].trim();
    if (!datname || !size_pretty) continue;

    const size_bytes = parsePrettySizeToBytes(size_pretty);
    if (size_bytes == null) continue;

    rows.push({ datname, size_pretty, size_bytes });
  }

  if (rows.length === 0) {
    throw new Error("No db size rows parsed (input format not recognized).");
  }
  return rows;
}

// -------------------- DB writes --------------------
async function insertSnapshotWithSizes(args: {
  snapshot_at: string; // ISO
  server_name?: string | null;
  rows: ParsedDbSizeRow[];
}): Promise<{ snapshot_id: number; inserted_rows: number }> {
  const snapshot_at = new Date(args.snapshot_at);
  if (Number.isNaN(snapshot_at.getTime())) throw new Error("Invalid snapshot_at");

  const server_name = (args.server_name ?? "").trim() || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const snapRes = await client.query(
      `INSERT INTO snapshots(snapshot_at, server_name) VALUES ($1, $2) RETURNING id`,
      [snapshot_at.toISOString(), server_name]
    );
    const snapshot_id = Number(snapRes.rows[0].id);

    // Bulk insert
    // Use VALUES list
    const values: any[] = [];
    const placeholders: string[] = [];
    let i = 1;
    for (const r of args.rows) {
      values.push(snapshot_id, r.datname, r.size_pretty, r.size_bytes);
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    }

    await client.query(
      `INSERT INTO db_sizes(snapshot_id, datname, size_pretty, size_bytes) VALUES ${placeholders.join(",")}`,
      values
    );

    await client.query("COMMIT");
    return { snapshot_id, inserted_rows: args.rows.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// -------------------- Ingest endpoints --------------------

// UI paste-text (urlencoded) — NO multer/busboy here
app.post("/ingest-text", requireAuth, async (req, res) => {
  try {
    const text = String((req.body as any)?.text || "");
    const server_name = String((req.body as any)?.server_name || "").trim();
    const snapshot_date = String((req.body as any)?.snapshot_date || "").trim(); // YYYY-MM-DD optional

    if (!text.trim()) {
      return res.status(400).type("html").send(`<p>Empty text</p><p><a href="/">Back</a></p>`);
    }

    const rows = parsePgSizeOutput(text);

    const snapshot_at =
      (snapshot_date ? toUtcMidnightIsoFromDateOnly(snapshot_date) : null) || new Date().toISOString();

    await insertSnapshotWithSizes({ snapshot_at, server_name, rows });

    res.redirect("/?msg=" + encodeURIComponent("Uploaded"));
  } catch (e: any) {
    console.error("ingest-text failed:", e?.stack || e);
    res.status(500).type("html").send(`
      <h3>Upload failed</h3>
      <pre>${escapeHtml(String(e?.message || e))}</pre>
      <p><a href="/">Back</a></p>
    `);
  }
});

// UI file upload (multipart) — uses multer
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const server_name = String((req.body as any)?.server_name || "").trim();
    const snapshot_date = String((req.body as any)?.snapshot_date || "").trim();

    const buf = (req.file as any)?.buffer as Buffer | undefined;
    const text = buf ? buf.toString("utf-8") : "";

    if (!text.trim()) {
      return res.status(400).type("html").send(`<p>Empty file</p><p><a href="/">Back</a></p>`);
    }

    const rows = parsePgSizeOutput(text);
    const snapshot_at =
      (snapshot_date ? toUtcMidnightIsoFromDateOnly(snapshot_date) : null) || new Date().toISOString();

    await insertSnapshotWithSizes({ snapshot_at, server_name, rows });

    res.redirect("/?msg=" + encodeURIComponent("Uploaded"));
  } catch (e: any) {
    console.error("upload failed:", e?.stack || e);
    res.status(500).type("html").send(`
      <h3>Upload failed</h3>
      <pre>${escapeHtml(String(e?.message || e))}</pre>
      <p><a href="/">Back</a></p>
    `);
  }
});

// API ingest (text/plain body) for automation
app.post("/api/ingest", async (req, res) => {
  try {
    if (INGEST_API_KEY) {
      const key = String(req.header("X-API-Key") || "");
      if (key !== INGEST_API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const server_name = String(req.query?.server_name || "").trim();
    const snapshot_at_q = String(req.query?.snapshot_at || "").trim();

    const bodyText = normalizeTextInput(String(req.body || ""));
    if (!bodyText.trim()) return res.status(400).json({ ok: false, error: "Empty body" });

    const rows = parsePgSizeOutput(bodyText);

    const snapshot_at = snapshot_at_q ? new Date(snapshot_at_q).toISOString() : new Date().toISOString();
    await insertSnapshotWithSizes({ snapshot_at, server_name, rows });

    res.json({ ok: true, rows: rows.length, server_name: server_name || null, snapshot_at });
  } catch (e: any) {
    console.error("api/ingest failed:", e?.stack || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Pages --------------------
app.get("/", requireAuth, async (req, res) => {
  const msg = typeof req.query?.msg === "string" ? req.query.msg : "";
  const server = typeof req.query?.server === "string" ? req.query.server : "";

  // Determine latest snapshot per server filter
  const latestSnapRes = await pool.query(
    `SELECT id, snapshot_at, server_name
     FROM snapshots
     WHERE ($1 = '' OR server_name = $1)
     ORDER BY snapshot_at DESC
     LIMIT 1`,
    [server]
  );

  const latest = latestSnapRes.rows[0] || null;

  let rows: any[] = [];
  let totalBytes = 0;

  if (latest) {
    const sizesRes = await pool.query(
      `SELECT datname, size_pretty, size_bytes
       FROM db_sizes
       WHERE snapshot_id = $1
       ORDER BY size_bytes DESC`,
      [latest.id]
    );
    rows = sizesRes.rows;
    totalBytes = rows.reduce((a, r) => a + Number(r.size_bytes || 0), 0);
  }

  const serversRes = await pool.query(
    `SELECT DISTINCT COALESCE(server_name, '') AS server_name
     FROM snapshots
     ORDER BY server_name`
  );
  const servers = serversRes.rows.map((r) => String(r.server_name || ""));

  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>DBHistory</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;margin:18px}
    a{color:#0366d6;text-decoration:none}
    a:hover{text-decoration:underline}
    .topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0}
    textarea{width:100%;box-sizing:border-box}
    input,select,button{padding:8px}
    table{border-collapse:collapse;width:100%}
    th,td{border-bottom:1px solid #eee;padding:8px;text-align:left}
    th{position:sticky;top:0;background:#fafafa}
    .muted{color:#666}
    .right{text-align:right}
    /* Two-column layout */
    .page{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
    .left{flex:1 1 640px;min-width:420px}
    .right{flex:0 0 420px;min-width:360px}
    .section-title{margin:0 0 8px 0}
    .form-row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
  </style>
</head>
<body>
  <div class="topbar">
    <strong>DBHistory</strong>
    <a href="/">Home</a>
    <a href="/charts">Charts</a>
    <a href="/diff">Diff</a>
    <a href="/snapshots">Snapshots</a>
    <span class="muted">|</span>
    <a href="/logout">Logout</a>
  </div>

  ${msg ? `<div class="card"><b>${escapeHtml(msg)}</b></div>` : ""}

  <div class="page">
    <div class="left">

      <div class="card">
        <h3 class="section-title">Latest snapshot</h3>
        <form method="get" action="/" class="form-row">
          <div>
            <div class="muted">Server</div>
            <select name="server">
              <option value="" ${server === "" ? "selected" : ""}>(all)</option>
              ${servers
                .map((s) => `<option value="${escapeHtml(s)}" ${s === server ? "selected" : ""}>${escapeHtml(s || "(empty)")}</option>`)
                .join("")}
            </select>
          </div>
          <button type="submit">Apply</button>
        </form>

        <div style="margin-top:10px" class="muted">
          ${
            latest
              ? `${escapeHtml(new Date(latest.snapshot_at).toISOString())} | server: ${escapeHtml(latest.server_name || "")} | total: <b>${escapeHtml(fmtBytesPretty(totalBytes))}</b>`
              : "No data yet"
          }
        </div>

        <div style="margin-top:10px">
          ${
            latest
              ? `
            <table>
              <thead><tr><th>Database</th><th class="right">Size</th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (r) => `<tr><td>${escapeHtml(r.datname)}</td><td class="right">${escapeHtml(r.size_pretty)}</td></tr>`
                  )
                  .join("")}
              </tbody>
              <tfoot>
                <tr><td><b>Total</b></td><td class="right"><b>${escapeHtml(fmtBytesPretty(totalBytes))}</b></td></tr>
              </tfoot>
            </table>
            `
              : `<div class="muted">No data yet.</div>`
          }
        </div>
      </div>

     
    </div>
    <div class="right">

       <div class="card">
        <h3 class="section-title">Paste text</h3>
        <form method="post" action="/ingest-text">
          <div class="form-row">
            <div>
              <div class="muted">Server (optional)</div>
              <input name="server_name" placeholder="AWS / prod-msk / ..." />
            </div>
            <div>
              <div class="muted">Snapshot date (optional)</div>
              <input type="date" name="snapshot_date" />
            </div>
            <div>
              <div class="muted">&nbsp;</div>
              <button type="submit">Upload</button>
            </div>
          </div>
          <div style="margin-top:8px" class="muted">Format: <code>dbname | 39 GB</code> (one per line)</div>
          <textarea name="text" rows="10" placeholder="TMSKZ_live | 39 GB"></textarea>
        </form>
      </div>

      <div class="card">
        <h3 class="section-title">Upload file</h3>
        <form method="post" action="/upload" enctype="multipart/form-data">
          <div class="form-row">
            <div>
              <div class="muted">Server (optional)</div>
              <input name="server_name" placeholder="AWS / prod-msk / ..." />
            </div>
            <div>
              <div class="muted">Snapshot date (optional)</div>
              <input type="date" name="snapshot_date" />
            </div>
            <div>
              <div class="muted">File</div>
              <input type="file" name="file" />
            </div>
            <div>
              <div class="muted">&nbsp;</div>
              <button type="submit">Upload file</button>
            </div>
          </div>
        </form>
      </div>

    </div>
  </div>

</body>
</html>
`);
});
app.get("/charts", requireAuth, async (req, res) => {
  const server = typeof req.query?.server === "string" ? req.query.server : "";

  const serversRes = await pool.query(
    `SELECT DISTINCT COALESCE(server_name, '') AS server_name
     FROM snapshots
     ORDER BY server_name`
  );
  const servers = serversRes.rows.map((r) => String(r.server_name || ""));

  // Time series per DB for selected server
  const seriesRes = await pool.query(
    `SELECT s.snapshot_at, COALESCE(s.server_name,'') AS server_name, d.datname, d.size_bytes
     FROM snapshots s
     JOIN db_sizes d ON d.snapshot_id = s.id
     WHERE ($1 = '' OR s.server_name = $1)
     ORDER BY s.snapshot_at ASC`,
    [server]
  );

  // Bar chart for selected snapshot (latest by default)
  const latestSnapRes = await pool.query(
    `SELECT id, snapshot_at
     FROM snapshots
     WHERE ($1 = '' OR server_name = $1)
     ORDER BY snapshot_at DESC
     LIMIT 1`,
    [server]
  );
  const latest = latestSnapRes.rows[0] || null;

  const barRes = latest
    ? await pool.query(
        `SELECT datname, size_bytes
         FROM db_sizes
         WHERE snapshot_id = $1
         ORDER BY size_bytes DESC`,
        [latest.id]
      )
    : { rows: [] as any[] };

  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Charts</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;margin:18px}
    a{color:#0366d6;text-decoration:none}
    .topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0}
    canvas{max-width:100%}
    select,button{padding:8px}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="topbar">
    <strong>DBHistory</strong>
    <a href="/">Home</a>
    <a href="/charts">Charts</a>
    <a href="/diff">Diff</a>
    <a href="/snapshots">Snapshots</a>
    <span style="color:#666">|</span>
    <a href="/logout">Logout</a>
  </div>

  <div class="card">
    <form method="get" action="/charts" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
      <div>
        <div style="color:#666">Server</div>
        <select name="server">
          <option value="" ${server === "" ? "selected" : ""}>(all)</option>
          ${servers
            .map((s) => `<option value="${escapeHtml(s)}" ${s === server ? "selected" : ""}>${escapeHtml(s || "(empty)")}</option>`)
            .join("")}
        </select>
      </div>
      <button type="submit">Apply</button>
    </form>
  </div>

  <div class="card">
    <h3>Lines (all databases)</h3>
    <canvas id="lineChart" height="120"></canvas>
  </div>

  <div class="card">
    <h3>Bars (latest snapshot)</h3>
    <div style="color:#666">Snapshot: ${latest ? escapeHtml(new Date(latest.snapshot_at).toISOString()) : "—"}</div>
    <canvas id="barChart" height="120"></canvas>
  </div>

<script>
  const raw = ${JSON.stringify(seriesRes.rows)};
  const bar = ${JSON.stringify(barRes.rows)};

  // Build line datasets: one dataset per datname
  const byDb = new Map();
  for (const r of raw) {
    const t = new Date(r.snapshot_at).toISOString().slice(0,10);
    const key = r.datname;
    if (!byDb.has(key)) byDb.set(key, []);
    byDb.get(key).push({ x: t, y: Number(r.size_bytes) });
  }

  const lineDatasets = Array.from(byDb.entries()).map(([name, pts]) => ({
    label: name,
    data: pts,
    tension: 0.15
  }));

  new Chart(document.getElementById('lineChart'), {
    type: 'line',
    data: { datasets: lineDatasets },
    options: {
      parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { type: 'category' },
        y: { ticks: { callback: v => v } }
      }
    }
  });

  new Chart(document.getElementById('barChart'), {
    type: 'bar',
    data: {
      labels: bar.map(x => x.datname),
      datasets: [{ label: 'Size (bytes)', data: bar.map(x => Number(x.size_bytes)) }]
    },
    options: {
      scales: { x: { ticks: { autoSkip: false, maxRotation: 90, minRotation: 45 } } }
    }
  });
</script>

</body>
</html>
`);
});

app.get("/diff", requireAuth, async (req, res) => {
  const server = typeof req.query?.server === "string" ? req.query.server : "";

  const serversRes = await pool.query(
    `SELECT DISTINCT COALESCE(server_name, '') AS server_name
     FROM snapshots
     ORDER BY server_name`
  );
  const servers = serversRes.rows.map((r) => String(r.server_name || ""));

  const snapsRes = await pool.query(
    `SELECT id, snapshot_at
     FROM snapshots
     WHERE ($1 = '' OR server_name = $1)
     ORDER BY snapshot_at DESC
     LIMIT 10`,
    [server]
  );
  const snaps = snapsRes.rows;

  if (snaps.length === 0) {
    return res.type("html").send(`
<!doctype html><html><head><meta charset="utf-8"/><title>Diff</title></head>
<body style="font-family:system-ui,Segoe UI,Arial;margin:18px">
  <p><a href="/">Back</a></p>
  <p>No snapshots yet.</p>
</body></html>`);
  }

  const snapIds = snaps.map((s) => s.id);
  const sizesRes = await pool.query(
    `SELECT snapshot_id, datname, size_bytes
     FROM db_sizes
     WHERE snapshot_id = ANY($1::bigint[])`,
    [snapIds]
  );

  // Map: datname -> Map<snapshot_id, size_bytes>
  const byDb = new Map<string, Map<number, number>>();
  for (const r of sizesRes.rows) {
    const db = String(r.datname);
    const sid = Number(r.snapshot_id);
    const b = Number(r.size_bytes);
    if (!byDb.has(db)) byDb.set(db, new Map());
    byDb.get(db)!.set(sid, b);
  }

  // Totals per snapshot
  const totalsBySnap = new Map<number, number>();
  for (const sid of snapIds) totalsBySnap.set(sid, 0);
  for (const r of sizesRes.rows) {
    const sid = Number(r.snapshot_id);
    totalsBySnap.set(sid, (totalsBySnap.get(sid) || 0) + Number(r.size_bytes || 0));
  }

  // Sort DBs by last snapshot size desc
  const lastSnapId = Number(snaps[0].id);
  const dbsSorted = Array.from(byDb.keys()).sort((a, b) => {
    const aa = byDb.get(a)!.get(lastSnapId) || 0;
    const bb = byDb.get(b)!.get(lastSnapId) || 0;
    return bb - aa;
  });

  const snapsAsc = [...snaps].slice().reverse();
  const snapHeaders = snapsAsc.map((s) => new Date(s.snapshot_at).toISOString().slice(0, 10));
  const snapIdByIdx = snapsAsc.map((s) => Number(s.id));

  function pctChange(last: number, prev: number): string {
    if (!Number.isFinite(last) || !Number.isFinite(prev)) return "";
    if (prev === 0) return "";
    const p = ((last - prev) / prev) * 100;
    const n = Math.round(p * 10) / 10;
    return `${n}%`;
  }

  function estMonthly(last: number, prev: number, days: number): string {
    if (!Number.isFinite(last) || !Number.isFinite(prev)) return "";
    if (days <= 0) return "";
    const perDay = (last - prev) / days;
    const perMonth = perDay * 30;
    return fmtBytesPretty(Math.max(0, Math.round(perMonth)));
  }

  const lastAt = new Date(snaps[0].snapshot_at).getTime();
  const prevAt = snaps.length > 1 ? new Date(snaps[1].snapshot_at).getTime() : NaN;
  const daysBetween = Number.isFinite(prevAt) ? Math.max(1, Math.round((lastAt - prevAt) / (1000 * 60 * 60 * 24))) : 0;

  const totalLast = totalsBySnap.get(Number(snaps[0].id)) || 0;
  const totalPrev = snaps.length > 1 ? (totalsBySnap.get(Number(snaps[1].id)) || 0) : 0;

  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Diff</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;margin:18px}
    a{color:#0366d6;text-decoration:none}
    .topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0}
    table{border-collapse:collapse;width:100%}
    th,td{border-bottom:1px solid #eee;padding:8px;text-align:right}
    th:first-child, td:first-child{text-align:left}
    th{position:sticky;top:0;background:#fafafa}
    select,button{padding:8px}
    .muted{color:#666}
  </style>
</head>
<body>
  <div class="topbar">
    <strong>DBHistory</strong>
    <a href="/">Home</a>
    <a href="/charts">Charts</a>
    <a href="/diff">Diff</a>
    <a href="/snapshots">Snapshots</a>
    <span class="muted">|</span>
    <a href="/logout">Logout</a>
  </div>

  <div class="card">
    <form method="get" action="/diff" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
      <div>
        <div class="muted">Server</div>
        <select name="server">
          <option value="" ${server === "" ? "selected" : ""}>(all)</option>
          ${servers
            .map((s) => `<option value="${escapeHtml(s)}" ${s === server ? "selected" : ""}>${escapeHtml(s || "(empty)")}</option>`)
            .join("")}
        </select>
      </div>
      <button type="submit">Apply</button>
    </form>
    <div class="muted" style="margin-top:8px">Showing last 10 snapshots. Extra columns: % change (last vs prev), estimated monthly growth.</div>
  </div>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Database</th>
          ${snapHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}
          <th>%</th>
          <th>~Monthly</th>
        </tr>
      </thead>
      <tbody>
        ${dbsSorted
          .map((db) => {
            const m = byDb.get(db)!;
            const vals = snapIdByIdx.map((sid) => m.get(sid) || 0);
            const newestId = Number(snaps[0].id);
            const prevId = snaps.length > 1 ? Number(snaps[1].id) : NaN;
            const last = m.get(newestId) || 0;
            const prev = Number.isFinite(prevId) ? (m.get(prevId) || 0) : 0;
            return `
              <tr>
                <td>${escapeHtml(db)}</td>
                ${vals.map((v) => `<td>${escapeHtml(fmtBytesPretty(v))}</td>`).join("")}
                <td>${escapeHtml(pctChange(last, prev))}</td>
                <td>${escapeHtml(estMonthly(last, prev, daysBetween))}</td>
              </tr>
            `;
          })
          .join("")}
        <tr>
          <td><b>Total</b></td>
          ${snapIdByIdx.map((sid) => `<td><b>${escapeHtml(fmtBytesPretty(totalsBySnap.get(sid) || 0))}</b></td>`).join("")}
          <td><b>${escapeHtml(pctChange(totalLast, totalPrev))}</b></td>
          <td><b>${escapeHtml(estMonthly(totalLast, totalPrev, daysBetween))}</b></td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>
`);
});

app.get("/snapshots", requireAuth, async (req, res) => {
  const snapsRes = await pool.query(
    `SELECT id, snapshot_at, COALESCE(server_name,'') AS server_name
     FROM snapshots
     ORDER BY snapshot_at DESC
     LIMIT 200`
  );

  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Snapshots</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;margin:18px}
    a{color:#0366d6;text-decoration:none}
    .topbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0}
    table{border-collapse:collapse;width:100%}
    th,td{border-bottom:1px solid #eee;padding:8px;text-align:left}
    th{background:#fafafa}
    button{padding:6px 10px}
    .muted{color:#666}
  </style>
</head>
<body>
  <div class="topbar">
    <strong>DBHistory</strong>
    <a href="/">Home</a>
    <a href="/charts">Charts</a>
    <a href="/diff">Diff</a>
    <a href="/snapshots">Snapshots</a>
    <span class="muted">|</span>
    <a href="/logout">Logout</a>
  </div>

  <div class="card">
    <h3>Snapshots</h3>
    <table>
      <thead><tr><th>Snapshot</th><th>Server</th><th>Action</th></tr></thead>
      <tbody>
        ${snapsRes.rows
          .map((r) => {
            const snapIso = new Date(r.snapshot_at).toISOString();
            return `
              <tr>
                <td>${escapeHtml(snapIso)}</td>
                <td>${escapeHtml(r.server_name || "")}</td>
                <td>
                  <form method="post" action="/snapshots/delete" onsubmit="return confirm('Delete this snapshot?')">
                    <input type="hidden" name="snapshot_id" value="${escapeHtml(r.id)}" />
                    <input type="hidden" name="snapshot_at" value="${escapeHtml(snapIso)}" />
                    <button type="submit">Delete</button>
                  </form>
                </td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  </div>
</body>
</html>
`);
});

app.post("/snapshots/delete", requireAuth, async (req, res) => {
  try {
    const snapshot_id = Number(String((req.body as any)?.snapshot_id || "").trim());
    const snapshot_at_raw = String((req.body as any)?.snapshot_at || "").trim();

    const snapshot_date = snapshot_at_raw ? new Date(snapshot_at_raw) : null;
    if (!snapshot_date || Number.isNaN(snapshot_date.getTime())) {
      return res.status(400).type("html").send(`
        <p>Invalid snapshot_at</p>
        <p><a href="/snapshots">Back</a></p>
      `);
    }
    const snapshot_at = snapshot_date.toISOString();

    if (!Number.isFinite(snapshot_id) || snapshot_id <= 0) {
      return res.status(400).type("html").send(`<p>Invalid snapshot_id</p><p><a href="/snapshots">Back</a></p>`);
    }

    // delete by id (safer)
    await pool.query(`DELETE FROM snapshots WHERE id = $1`, [snapshot_id]);

    res.redirect("/snapshots?msg=" + encodeURIComponent(`Deleted ${snapshot_at}`));
  } catch (e: any) {
    console.error("delete snapshot failed:", e?.stack || e);
    res.status(500).type("html").send(`
      <h3>Delete failed</h3>
      <pre>${escapeHtml(String(e?.message || e))}</pre>
      <p><a href="/snapshots">Back</a></p>
    `);
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`DBHistory listening on ${PORT}`);
});
