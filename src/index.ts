import express from "express";
import multer from "multer";
import crypto from "crypto";
import { pool } from "./db";
import { parsePgSizeOutput } from "./parser";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.urlencoded({ extended: true }));

// -------------------- Helpers --------------------

function escapeHtml(s: string): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let u = 0;
  let v = abs;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const sign = bytes < 0 ? "-" : "";
  const num = u === 0 ? v.toFixed(0) : v.toFixed(2);
  return `${sign}${num} ${units[u]}`;
}

// Normalize timestamps so that Map keys always match even if PG returns different string formats
function snapKey(x: string): number {
  return new Date(x).getTime(); // epoch ms
}

// datetime-local: interpret as UTC by appending Z
function parseDatetimeLocalAsUTC(value?: string): Date | null {
  const v = (value || "").trim();
  if (!v) return null;
  const d = new Date(v + "Z");
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function getLastServer(): Promise<string | null> {
  const r = await pool.query<{ server_name: string }>(
    `SELECT server_name
     FROM uploads
     WHERE server_name IS NOT NULL AND server_name <> ''
     ORDER BY uploaded_at DESC
     LIMIT 1`
  );
  return r.rows[0]?.server_name ?? null;
}

// -------------------- Auth (simple signed cookie) --------------------

const COOKIE_NAME = "auth";
const PASSWORD = (process.env.APP_PASSWORD || "").trim();
const AUTH_SECRET = (process.env.AUTH_SECRET || PASSWORD).trim();
const SESSION_DAYS = 7;

if (!PASSWORD) {
  console.warn("WARNING: APP_PASSWORD is not set. Login will fail until you set it in Render env.");
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const h = header || "";
  for (const part of h.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function b64url(input: Buffer | string): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf-8");
  return b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unb64url(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const x = (s + pad).replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(x, "base64");
}

function sign(dataB64: string): string {
  return b64url(crypto.createHmac("sha256", AUTH_SECRET).update(dataB64).digest());
}

function makeToken(): string {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = b64url(JSON.stringify({ exp }));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = sign(payload);

  // timingSafeEqual needs same length
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  const obj = JSON.parse(unb64url(payload).toString("utf-8"));
  if (!obj?.exp || typeof obj.exp !== "number") return false;
  return Date.now() < obj.exp;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.path === "/login" || req.path === "/logout" || req.path === "/api/ingest") return next();

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];

  if (token && verifyToken(token)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.redirect("/login");
}

app.get("/login", (_req, res) => {
  res.type("html").send(`
    <h2>Login</h2>
    <form method="post" action="/login">
      <div style="margin-bottom:8px;">
        <label>Password:</label>
        <input type="password" name="password" style="width:260px;" autofocus />
      </div>
      <button type="submit">Sign in</button>
    </form>
  `);
});

app.post("/login", async (req, res) => {
  const pw = String((req.body as any)?.password || "");
  if (!PASSWORD || pw !== PASSWORD) {
    return res.status(401).type("html").send(`
      <h2>Login</h2>
      <p style="color:red;">Wrong password</p>
      <a href="/login">Try again</a>
    `);
  }

  const token = makeToken();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      SESSION_DAYS * 24 * 60 * 60
    }`
  );
  res.redirect("/");
});

app.get("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.redirect("/login");
});

// Apply auth to everything below
app.use(requireAuth);

// -------------------- Ingest API (for automation) --------------------
// Accepts plain text (psql output) and stores it as a snapshot.
// Auth: X-API-Key header must match INGEST_API_KEY environment variable.
// Usage example:
//   POST /api/ingest?server_name=prod-1&snapshot_at=2026-01-11T00:00:00Z
//   Header: X-API-Key: <key>
//   Body: lines like "dbname | 37 MB"

const INGEST_API_KEY = String(process.env.INGEST_API_KEY || "").trim();

// Accept any text body. (Must be registered before the route)
app.use(express.text({ type: "*/*", limit: "10mb" }));

app.post("/api/ingest", async (req, res) => {
  const apiKey = String(req.header("x-api-key") || "");
  if (!INGEST_API_KEY || apiKey !== INGEST_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const server_name = String(req.query.server_name || "").trim() || null;

  // snapshot_at can be ISO (recommended). If not provided, use now().
  const snapshotRaw = String(req.query.snapshot_at || "").trim();
  const snapshot_at = snapshotRaw ? new Date(snapshotRaw) : new Date();
  if (Number.isNaN(snapshot_at.getTime())) {
    return res.status(400).json({ error: "Invalid snapshot_at. Use ISO like 2026-01-11T00:00:00Z" });
  }

  const content = typeof req.body === "string" ? req.body : "";
  if (!content.trim()) {
    return res.status(400).json({ error: "Empty body" });
  }

  const parsed = parsePgSizeOutput(content);
  if (parsed.length === 0) {
    return res.status(400).json({ error: "Parse failed" });
  }

  const originalName = "api-ingest";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const up = await client.query<{ id: string }>(
      `INSERT INTO uploads (original_name, content, snapshot_at, server_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [originalName, content, snapshot_at.toISOString(), server_name]
    );
    const uploadId = up.rows[0].id;

    const values: Array<string | number | null> = [];
    const placeholders: string[] = [];
    let i = 1;

    for (const r of parsed) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(
        uploadId,
        snapshot_at.toISOString(),
        snapshot_at.toISOString(),
        server_name,
        r.db_name,
        r.size_bytes,
        r.size_pretty
      );
    }

    await client.query(
      `INSERT INTO db_sizes (upload_id, captured_at, snapshot_at, server_name, db_name, size_bytes, size_pretty)
       VALUES ${placeholders.join(", ")}`,
      values
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      rows: parsed.length,
      server_name,
      snapshot_at: snapshot_at.toISOString(),
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ error: e?.message || "failed" });
  } finally {
    client.release();
  }
});


// -------------------- DB helpers for UI --------------------

async function getLatestSnapshot(): Promise<{ server_name: string | null; snapshot_at: string } | null> {
  const r = await pool.query<{ server_name: string | null; snapshot_at: string }>(
    `SELECT server_name, snapshot_at
     FROM uploads
     WHERE snapshot_at IS NOT NULL
     ORDER BY snapshot_at DESC, uploaded_at DESC
     LIMIT 1`
  );
  return r.rows[0] ?? null;
}

async function getSnapshotRows(server: string | null, snapshotAtISO: string) {
  const r = await pool.query<{
    server_name: string | null;
    snapshot_at: string;
    db_name: string;
    size_bytes: string;
  }>(
    `
    SELECT server_name, snapshot_at, db_name, size_bytes::text
    FROM db_sizes
    WHERE server_name IS NOT DISTINCT FROM $1
      AND snapshot_at = $2
    ORDER BY size_bytes DESC, db_name ASC
    `,
    [server, snapshotAtISO]
  );
  return r.rows;
}

// -------------------- Main page --------------------

app.get("/", async (_req, res) => {
  const lastServer = await getLastServer();
  const latest = await getLatestSnapshot();

  let summaryHtml = `<p style="color:#555">Пока нет срезов. Загрузите файл или вставьте текст ниже.</p>`;

  if (latest) {
    const rows = await getSnapshotRows(latest.server_name, latest.snapshot_at);
    const total = rows.reduce((sum, r) => sum + Number(r.size_bytes), 0);

    summaryHtml = `
      <h3>Последний срез</h3>
      <p>
        <b>Server:</b> ${escapeHtml(latest.server_name ?? "(empty)")}
        &nbsp; | &nbsp;
        <b>Snapshot:</b> ${escapeHtml(new Date(latest.snapshot_at).toISOString())}
        &nbsp; | &nbsp;
        <b>Total:</b> ${escapeHtml(formatBytes(total))}
      </p>

      <p>
        <a href="/charts">Charts</a> |
        <a href="/diff">Diff</a> |
        <a href="/snapshots">Snapshots</a> |
        <a href="/logout">Logout</a>
      </p>

      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; min-width:900px;">
        <thead>
          <tr style="background:#f2f2f2;">
            <th align="left">Database</th>
            <th align="right">Size</th>
            <th align="left">Snapshot (UTC)</th>
            <th align="left">Server</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
              <tr>
                <td>${escapeHtml(r.db_name)}</td>
                <td align="right">${escapeHtml(formatBytes(Number(r.size_bytes)))}</td>
                <td>${escapeHtml(new Date(r.snapshot_at).toISOString())}</td>
                <td>${escapeHtml(r.server_name ?? "(empty)")}</td>
              </tr>`
            )
            .join("")}
          <tr style="background:#fbfbfb;">
            <td><b>Total</b></td>
            <td align="right"><b>${escapeHtml(formatBytes(total))}</b></td>
            <td colspan="2"></td>
          </tr>
        </tbody>
      </table>
    `;
  } else {
    summaryHtml = `
      <p>
        <a href="/charts">Charts</a> |
        <a href="/diff">Diff</a> |
        <a href="/snapshots">Snapshots</a> |
        <a href="/logout">Logout</a>
      </p>
      <p style="color:#555">Пока нет срезов. Загрузите файл или вставьте текст ниже.</p>
    `;
  }

  res.type("html").send(`
    <h2>PG Size Tracker</h2>

    ${summaryHtml}

    <hr/>
    <h3>Загрузка среза</h3>
    <p style="color:#555">
      Можно загрузить файл или вставить текст. Дату среза можно задавать для исторических данных.
      Поле "Дата среза" (datetime-local) сохраняется как UTC (добавляется суффикс Z).
    </p>

    <form action="/upload" method="post" enctype="multipart/form-data" style="margin-bottom:16px;">
      <div style="margin-bottom:8px;">
        <label>Сервер (опционально): </label>
        <input name="server_name" placeholder="например: prod-frankfurt-1"
               value="${escapeHtml(lastServer ?? "")}" style="width:360px;" />
        <small style="color:#555">если пусто — используем последнее значение или оставим пустым</small>
      </div>

      <div style="margin-bottom:8px;">
        <label>Дата среза (опционально): </label>
        <input type="datetime-local" name="snapshot_at" />
      </div>

      <div style="margin-bottom:8px;">
        <label>Файл:</label>
        <input type="file" name="file" accept=".txt,text/plain" />
      </div>

      <div style="margin-bottom:8px;">
        <label>или вставь текст:</label><br/>
        <textarea name="text" rows="10" cols="120" placeholder="datname | pg_size_pretty ..."></textarea>
      </div>

      <button type="submit">Upload</button>
    </form>
  `);
});

// -------------------- Upload --------------------

type UploadMeta = {
  server_name: string | null;
  snapshot_at: Date | null;
};

async function resolveUploadMeta(req: express.Request): Promise<UploadMeta> {
  const snapshot_at = parseDatetimeLocalAsUTC(String((req.body as any)?.snapshot_at || ""));
  const providedServer = String((req.body as any)?.server_name || "").trim();
  if (providedServer) return { server_name: providedServer, snapshot_at };

  const last = await getLastServer();
  return { server_name: last, snapshot_at };
}

app.post("/upload", upload.single("file"), async (req, res) => {
  const meta = await resolveUploadMeta(req);

  const bodyText = String((req.body as any)?.text || "");
  const fileText = req.file ? req.file.buffer.toString("utf-8") : "";

  const content = fileText.trim().length > 0 ? fileText : bodyText;
  const originalName = req.file?.originalname || "pasted-text";

  if (!content || content.trim().length === 0) {
    return res.status(400).send("Нет данных: загрузите файл или вставьте текст.");
  }

  const parsed = parsePgSizeOutput(content);
  if (parsed.length === 0) {
    return res.status(400).send("Не удалось распарсить строки. Проверь формат текста.");
  }

  const snapshot_at = meta.snapshot_at ?? new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const up = await client.query<{ id: string }>(
      `INSERT INTO uploads (original_name, content, snapshot_at, server_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [originalName, content, snapshot_at.toISOString(), meta.server_name]
    );
    const uploadId = up.rows[0].id;

    const values: Array<string | number | null> = [];
    const placeholders: string[] = [];
    let i = 1;

    for (const r of parsed) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(
        uploadId,
        snapshot_at.toISOString(),
        snapshot_at.toISOString(),
        meta.server_name,
        r.db_name,
        r.size_bytes,
        r.size_pretty
      );
    }

    await client.query(
      `INSERT INTO db_sizes (upload_id, captured_at, snapshot_at, server_name, db_name, size_bytes, size_pretty)
       VALUES ${placeholders.join(", ")}`,
      values
    );

    await client.query("COMMIT");
    res.redirect("/");
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).send("Upload failed: " + e?.message);
  } finally {
    client.release();
  }
});

// -------------------- API --------------------

app.get("/api/servers", async (_req, res) => {
  const r = await pool.query<{ server_name: string }>(
    `SELECT DISTINCT server_name
     FROM uploads
     WHERE server_name IS NOT NULL AND server_name <> ''
     ORDER BY server_name`
  );
  res.json(r.rows.map((x) => x.server_name));
});

app.get("/api/snapshots", async (req, res) => {
  const server = String(req.query.server || "").trim();
  if (!server) return res.status(400).json({ error: "Please provide ?server=..." });

  const r = await pool.query<{ snapshot_at: string }>(
    `SELECT DISTINCT snapshot_at
     FROM uploads
     WHERE server_name = $1 AND snapshot_at IS NOT NULL
     ORDER BY snapshot_at DESC`,
    [server]
  );
  res.json(r.rows.map((x) => x.snapshot_at));
});

app.get("/api/snapshot", async (req, res) => {
  const server = String(req.query.server || "").trim();
  const snapshot_at = String(req.query.snapshot_at || "").trim();
  if (!server) return res.status(400).json({ error: "Please provide ?server=..." });
  if (!snapshot_at) return res.status(400).json({ error: "Please provide ?snapshot_at=..." });

  const r = await pool.query(
    `
    SELECT db_name, size_bytes, snapshot_at
    FROM db_sizes
    WHERE server_name = $1 AND snapshot_at = $2
    ORDER BY size_bytes DESC, db_name ASC
    `,
    [server, snapshot_at]
  );
  res.json(r.rows);
});

app.get("/api/lines", async (req, res) => {
  const server = String(req.query.server || "").trim();
  if (!server) return res.status(400).json({ error: "Please provide ?server=..." });

  const r = await pool.query(
    `
    SELECT db_name, snapshot_at, size_bytes
    FROM db_sizes
    WHERE server_name = $1
    ORDER BY snapshot_at ASC, db_name ASC
    `,
    [server]
  );
  res.json(r.rows);
});

app.get("/api/diff", async (req, res) => {
  const server = String(req.query.server || "").trim();

  const q = server
    ? `
      WITH ranked AS (
        SELECT
          server_name, db_name, size_bytes, size_pretty, snapshot_at,
          ROW_NUMBER() OVER (PARTITION BY server_name, db_name ORDER BY snapshot_at DESC) AS rn
        FROM db_sizes
        WHERE server_name = $1
      )
      SELECT
        cur.server_name,
        cur.db_name,
        cur.size_bytes AS latest_bytes,
        cur.size_pretty AS latest_pretty,
        cur.snapshot_at AS latest_at,
        prev.size_bytes AS prev_bytes,
        prev.size_pretty AS prev_pretty,
        prev.snapshot_at AS prev_at,
        (cur.size_bytes - COALESCE(prev.size_bytes, cur.size_bytes)) AS delta_bytes,
        CASE
          WHEN prev.size_bytes IS NULL OR prev.size_bytes = 0 THEN NULL
          ELSE ( (cur.size_bytes - prev.size_bytes)::numeric / prev.size_bytes::numeric ) * 100
        END AS delta_percent
      FROM ranked cur
      LEFT JOIN ranked prev
        ON prev.server_name = cur.server_name AND prev.db_name = cur.db_name AND prev.rn = 2
      WHERE cur.rn = 1
      ORDER BY delta_bytes DESC;
    `
    : `
      WITH ranked AS (
        SELECT
          server_name, db_name, size_bytes, size_pretty, snapshot_at,
          ROW_NUMBER() OVER (PARTITION BY server_name, db_name ORDER BY snapshot_at DESC) AS rn
        FROM db_sizes
      )
      SELECT
        cur.server_name,
        cur.db_name,
        cur.size_bytes AS latest_bytes,
        cur.size_pretty AS latest_pretty,
        cur.snapshot_at AS latest_at,
        prev.size_bytes AS prev_bytes,
        prev.size_pretty AS prev_pretty,
        prev.snapshot_at AS prev_at,
        (cur.size_bytes - COALESCE(prev.size_bytes, cur.size_bytes)) AS delta_bytes,
        CASE
          WHEN prev.size_bytes IS NULL OR prev.size_bytes = 0 THEN NULL
          ELSE ( (cur.size_bytes - prev.size_bytes)::numeric / prev.size_bytes::numeric ) * 100
        END AS delta_percent
      FROM ranked cur
      LEFT JOIN ranked prev
        ON prev.server_name IS NOT DISTINCT FROM cur.server_name
       AND prev.db_name = cur.db_name
       AND prev.rn = 2
      WHERE cur.rn = 1
      ORDER BY delta_bytes DESC;
    `;

  const r = server ? await pool.query(q, [server]) : await pool.query(q);
  res.json(r.rows);
});

// -------------------- Charts page (2 charts + back button) --------------------

app.get("/charts", async (_req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>DB Size Charts</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div style="margin-bottom:12px;">
    <a href="/" style="display:inline-block; padding:6px 10px; border:1px solid #ccc; text-decoration:none;">← Back</a>
    <a href="/logout" style="margin-left:10px;">Logout</a>
  </div>

  <h2>DB Size Charts</h2>

  <div style="margin-bottom:12px;">
    <label>Server: </label>
    <select id="serverSelect"></select>
    <button id="reloadBtn" style="margin-left:12px;">Reload</button>
  </div>

  <h3>1) Lines: all databases</h3>
  <canvas id="lineChart" width="1100" height="420"></canvas>

  <h3 style="margin-top:28px;">2) Bars: databases for selected snapshot</h3>
  <div style="margin-bottom:12px;">
    <label>Snapshot: </label>
    <select id="snapshotSelect" style="min-width:360px;"></select>
    <button id="loadBarsBtn" style="margin-left:12px;">Load bars</button>
  </div>
  <canvas id="barChart" width="1100" height="420"></canvas>

<script>
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function bytesToGB(x) { return x / (1024**3); }

let lineChart, barChart;

async function loadServers() {
  const servers = await fetchJson('/api/servers');
  const sel = document.getElementById('serverSelect');
  sel.innerHTML = '';
  for (const s of servers) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
  if (sel.options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no servers yet)';
    sel.appendChild(opt);
  }
}

async function loadSnapshots(server) {
  const sel = document.getElementById('snapshotSelect');
  sel.innerHTML = '';
  if (!server) return;
  const snaps = await fetchJson('/api/snapshots?server=' + encodeURIComponent(server));
  for (const s of snaps) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = new Date(s).toISOString().replace('T',' ').slice(0,19) + 'Z';
    sel.appendChild(opt);
  }
}

function buildLineDatasets(rows) {
  const snapshots = [...new Set(rows.map(r => r.snapshot_at))].sort();
  const dbs = [...new Set(rows.map(r => r.db_name))].sort();

  const byKey = new Map();
  for (const r of rows) {
    byKey.set(r.db_name + '||' + r.snapshot_at, Number(r.size_bytes));
  }

  const labels = snapshots.map(s => new Date(s).toISOString().replace('T',' ').slice(0,19) + 'Z');

  const datasets = dbs.map(db => {
    const data = snapshots.map(s => {
      const v = byKey.get(db + '||' + s);
      return (v === undefined) ? null : bytesToGB(v);
    });
    return { label: db, data };
  });

  return { labels, datasets };
}

async function loadLines() {
  const server = document.getElementById('serverSelect').value;
  if (!server) return;

  const rows = await fetchJson('/api/lines?server=' + encodeURIComponent(server));
  const built = buildLineDatasets(rows);

  const ctx = document.getElementById('lineChart');
  if (lineChart) lineChart.destroy();

  lineChart = new Chart(ctx, {
    type: 'line',
    data: { labels: built.labels, datasets: built.datasets },
    options: {
      responsive: false,
      plugins: { legend: { display: true } },
      scales: {
        y: { title: { display: true, text: 'GB' } },
        x: { title: { display: true, text: 'snapshot_at (UTC)' } }
      }
    }
  });
}

async function loadBars() {
  const server = document.getElementById('serverSelect').value;
  const snapshot = document.getElementById('snapshotSelect').value;
  if (!server || !snapshot) return;

  const rows = await fetchJson('/api/snapshot?server=' + encodeURIComponent(server) + '&snapshot_at=' + encodeURIComponent(snapshot));
  const labels = rows.map(r => r.db_name);
  const values = rows.map(r => bytesToGB(Number(r.size_bytes)));

  const ctx = document.getElementById('barChart');
  if (barChart) barChart.destroy();

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: server + ' / ' + (new Date(snapshot).toISOString().slice(0,19)+'Z') + ' (GB)',
        data: values
      }]
    },
    options: {
      responsive: false,
      plugins: { legend: { display: true } },
      scales: {
        y: { title: { display: true, text: 'GB' } }
      }
    }
  });
}

document.getElementById('reloadBtn').addEventListener('click', async () => {
  await loadSnapshots(document.getElementById('serverSelect').value);
  await loadLines();
});
document.getElementById('loadBarsBtn').addEventListener('click', loadBars);

document.getElementById('serverSelect').addEventListener('change', async (e) => {
  await loadSnapshots(e.target.value);
  await loadLines();
  await loadBars();
});

(async () => {
  await loadServers();
  const serverSel = document.getElementById('serverSelect');
  if (serverSel.options.length > 0) serverSel.selectedIndex = 0;
  await loadSnapshots(serverSel.value);
  await loadLines();
  await loadBars();
})();
</script>

</body>
</html>
  `);
});

// -------------------- Diff page (10 snapshots + % + monthly growth + totals) --------------------

app.get("/diff", async (req, res) => {
  const serversR = await pool.query<{ server_name: string }>(
    `SELECT DISTINCT server_name
     FROM uploads
     WHERE server_name IS NOT NULL AND server_name <> ''
     ORDER BY server_name`
  );
  const servers = serversR.rows.map((x) => x.server_name);

  const server = String(req.query.server || servers[0] || "").trim();
  if (!server) {
    return res.type("html").send(`
      <p>No servers yet.</p>
      <p><a href="/">Back</a></p>
    `);
  }

  const snapsR = await pool.query<{ snapshot_at: string }>(
    `SELECT DISTINCT snapshot_at
     FROM uploads
     WHERE server_name = $1 AND snapshot_at IS NOT NULL
     ORDER BY snapshot_at DESC
     LIMIT 10`,
    [server]
  );

  const snapshotsDesc = snapsR.rows.map((x) => x.snapshot_at);
  const snapshots = [...snapshotsDesc].reverse(); // oldest -> newest
  const snapshotKeys = snapshots.map(snapKey);

  if (snapshots.length === 0) {
    return res.type("html").send(`
      <p>No snapshots for server ${escapeHtml(server)}.</p>
      <p><a href="/">Back</a></p>
    `);
  }

  const dataR = await pool.query<{ db_name: string; snapshot_at: string; size_bytes: string }>(
    `
    SELECT db_name, snapshot_at, size_bytes::text
    FROM db_sizes
    WHERE server_name = $1 AND snapshot_at = ANY($2::timestamptz[])
    `,
    [server, snapshots]
  );

  // db -> (snapKey -> bytes)
  const byDb = new Map<string, Map<number, number>>();
  for (const r of dataR.rows) {
    if (!byDb.has(r.db_name)) byDb.set(r.db_name, new Map<number, number>());
    byDb.get(r.db_name)!.set(snapKey(r.snapshot_at), Number(r.size_bytes));
  }

  const lastKey = snapshotKeys[snapshotKeys.length - 1];
  const prevKey = snapshotKeys.length >= 2 ? snapshotKeys[snapshotKeys.length - 2] : null;

  // Sort DBs by latest size (largest first)
  const dbNames = [...byDb.keys()].sort((a, b) => {
    const ma = byDb.get(a)!;
    const mb = byDb.get(b)!;
    const va = ma.get(lastKey) ?? 0;
    const vb = mb.get(lastKey) ?? 0;
    if (vb !== va) return vb - va;
    return a.localeCompare(b);
  });

  const lastSnap = snapshots[snapshots.length - 1];
  const prevSnap = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

  const daysDiff =
    prevSnap ? (new Date(lastSnap).getTime() - new Date(prevSnap).getTime()) / (1000 * 60 * 60 * 24) : null;

  function pctChange(cur: number | null, prevv: number | null): string {
    if (cur === null || prevv === null || prevv === 0) return "";
    const pct = ((cur - prevv) / prevv) * 100;
    return pct.toFixed(2) + "%";
  }

  function monthlyGrowth(cur: number | null, prevv: number | null): string {
    if (cur === null || prevv === null || !daysDiff || daysDiff <= 0) return "";
    const delta = cur - prevv;
    const perMonth = (delta / daysDiff) * 30; // approximate 30-day month
    return formatBytes(perMonth);
  }

  const serverOptions = servers
    .map((s) => `<option value="${escapeHtml(s)}" ${s === server ? "selected" : ""}>${escapeHtml(s)}</option>`)
    .join("");

  const headerSnapshots = snapshots
    .map((s) => `<th align="right">${escapeHtml(new Date(s).toISOString().slice(0, 10))}</th>`)
    .join("");

  const rowsHtml = dbNames
    .map((db) => {
      const m = byDb.get(db)!;

      const values = snapshotKeys.map((k) => (m.has(k) ? m.get(k)! : null));

      const cur = m.has(lastKey) ? m.get(lastKey)! : null;
      const prv = prevKey !== null && m.has(prevKey) ? m.get(prevKey)! : null;

      return `
        <tr>
          <td>${escapeHtml(db)}</td>
          ${values.map((v) => `<td align="right">${v === null ? "" : escapeHtml(formatBytes(v))}</td>`).join("")}
          <td align="right">${escapeHtml(pctChange(cur, prv))}</td>
          <td align="right">${escapeHtml(monthlyGrowth(cur, prv))}</td>
        </tr>
      `;
    })
    .join("");

  // TOTAL row (sum across DBs per snapshot)
  const totalsBySnapshot: number[] = snapshotKeys.map((k) => {
    let sum = 0;
    for (const db of dbNames) {
      const m = byDb.get(db)!;
      const v = m.get(k);
      if (v !== undefined) sum += v;
    }
    return sum;
  });

  const totalLast = totalsBySnapshot[totalsBySnapshot.length - 1] ?? null;
  const totalPrev = totalsBySnapshot.length >= 2 ? totalsBySnapshot[totalsBySnapshot.length - 2] : null;

  const totalRowHtml = `
    <tr style="background:#fbfbfb;">
      <td><b>TOTAL</b></td>
      ${totalsBySnapshot.map((v) => `<td align="right"><b>${escapeHtml(formatBytes(v))}</b></td>`).join("")}
      <td align="right"><b>${escapeHtml(pctChange(totalLast, totalPrev))}</b></td>
      <td align="right"><b>${escapeHtml(monthlyGrowth(totalLast, totalPrev))}</b></td>
    </tr>
  `;

  res.type("html").send(`
    <div style="margin-bottom:12px;">
      <a href="/" style="display:inline-block; padding:6px 10px; border:1px solid #ccc; text-decoration:none;">← Back</a>
      <a href="/logout" style="margin-left:10px;">Logout</a>
    </div>

    <h2>Diff (last 10 snapshots)</h2>

    <form method="get" action="/diff" style="margin-bottom:12px;">
      <label>Server: </label>
      <select name="server">${serverOptions}</select>
      <button type="submit" style="margin-left:10px;">Load</button>
    </form>

    <p style="color:#555">
      Sorted by latest size (largest first). Columns: 10 snapshots (oldest → newest), then % change (last vs prev), then monthly growth estimate.
    </p>

    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; min-width:1100px;">
      <thead>
        <tr style="background:#f2f2f2;">
          <th align="left">Database</th>
          ${headerSnapshots}
          <th align="right">% (last vs prev)</th>
          <th align="right">Monthly growth</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        ${totalRowHtml}
      </tbody>
    </table>
  `);
});


// -------------------- Snapshots manager (delete snapshots) --------------------

app.get("/snapshots", async (req, res) => {
  const serversR = await pool.query<{ server_name: string }>(
    `SELECT DISTINCT server_name
     FROM uploads
     WHERE server_name IS NOT NULL AND server_name <> ''
     ORDER BY server_name`
  );
  const servers = serversR.rows.map((x) => x.server_name);

  const server = String(req.query.server || servers[0] || "").trim();
  if (!server) {
    return res.type("html").send(`
      <div style="margin-bottom:12px;">
        <a href="/" style="display:inline-block; padding:6px 10px; border:1px solid #ccc; text-decoration:none;">← Back</a>
        <a href="/logout" style="margin-left:10px;">Logout</a>
      </div>
      <p>No servers yet.</p>
    `);
  }

  const snapsR = await pool.query<{ snapshot_at: string; uploads_count: string; total_bytes: string }>(
    `
    SELECT
      u.snapshot_at,
      COUNT(*)::text AS uploads_count,
      COALESCE(SUM(d.size_bytes), 0)::text AS total_bytes
    FROM uploads u
    LEFT JOIN db_sizes d
      ON d.upload_id = u.id
    WHERE u.server_name = $1 AND u.snapshot_at IS NOT NULL
    GROUP BY u.snapshot_at
    ORDER BY u.snapshot_at DESC
    LIMIT 60
    `,
    [server]
  );

  const serverOptions = servers
    .map((s) => `<option value="${escapeHtml(s)}" ${s === server ? "selected" : ""}>${escapeHtml(s)}</option>`)
    .join("");

  const rowsHtml = snapsR.rows
    .map((r) => {
      const snapIso = new Date(r.snapshot_at).toISOString();
      const total = formatBytes(Number(r.total_bytes));
      return `
        <tr>
          <td>${escapeHtml(snapIso)}</td>
          <td align="right">${escapeHtml(r.uploads_count)}</td>
          <td align="right">${escapeHtml(total)}</td>
          <td>
            <form method="post" action="/snapshots/delete" onsubmit="return confirm('Delete snapshot ${escapeHtml(snapIso)} for server ${escapeHtml(server)}?');">
              <input type="hidden" name="server_name" value="${escapeHtml(server)}" />
              <input type="hidden" name="snapshot_at" value="${escapeHtml(snapIso)}" />
              <button type="submit">Delete</button>
            </form>
          </td>
        </tr>
      `;
    })
    .join("");

  res.type("html").send(`
    <div style="margin-bottom:12px;">
      <a href="/" style="display:inline-block; padding:6px 10px; border:1px solid #ccc; text-decoration:none;">← Back</a>
      <a href="/logout" style="margin-left:10px;">Logout</a>
    </div>

    <h2>Snapshots</h2>

    <form method="get" action="/snapshots" style="margin-bottom:12px;">
      <label>Server: </label>
      <select name="server">${serverOptions}</select>
      <button type="submit" style="margin-left:10px;">Load</button>
    </form>

    <p style="color:#555">
      This page deletes snapshots by (server_name + snapshot_at). It deletes all uploads matching that snapshot and cascades to db_sizes.
    </p>

    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; min-width:900px;">
      <thead>
        <tr style="background:#f2f2f2;">
          <th align="left">Snapshot (UTC)</th>
          <th align="right">Uploads</th>
          <th align="right">Total size</th>
          <th align="left">Action</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || '<tr><td colspan="4" style="color:#555">No snapshots found</td></tr>'}
      </tbody>
    </table>
  `);
});

app.post("/snapshots/delete", async (req, res) => {
  const server = String((req.body as any)?.server_name || "").trim();
  const snapshot_at_raw = String((req.body as any)?.snapshot_at || "").trim();
  const snapshot_date = snapshot_at_raw ? new Date(snapshot_at_raw) : null;
  if (!snapshot_date || Number.isNaN(snapshot_date.getTime())) {
    return res.status(400).type("html").send(`
      <p>Invalid snapshot_at</p>
      <p><a href="/snapshots">Back</a></p>
    `);
  }
  const snapshot_at = snapshot_date.toISOString();

  if (!server || !snapshot_at) {
    return res.status(400).type("html").send(`
      <p>Missing server_name or snapshot_at</p>
      <p><a href="/snapshots">Back</a></p>
    `);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const del = await client.query<{ c: string }>(
      `WITH deleted AS (
         DELETE FROM uploads
         WHERE server_name = $1 AND snapshot_at = $2
         RETURNING id
       )
       SELECT COUNT(*)::text AS c FROM deleted`,
      [server, snapshot_at]
    );

    await client.query("COMMIT");

    const count = del.rows[0]?.c ?? "0";
    res.type("html").send(`
      <p>Deleted uploads: <b>${escapeHtml(count)}</b></p>
      <p><a href="/snapshots?server=${encodeURIComponent(server)}">Back to snapshots</a></p>
      <p><a href="/">Home</a></p>
    `);
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).type("html").send(`<p>Delete failed: ${escapeHtml(e?.message || "error")}</p><p><a href="/snapshots">Back</a></p>`);
  } finally {
    client.release();
  }
});

// -------------------- Listen --------------------

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log("Listening on " + PORT);
});
