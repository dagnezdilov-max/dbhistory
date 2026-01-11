import express from "express";
import multer from "multer";
import { pool } from "./db";
import { parsePgSizeOutput } from "./parser";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.urlencoded({ extended: true }));

type UploadMeta = {
  server_name: string | null;
  snapshot_at: Date | null;
};

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

// datetime-local: трактуем введённое значение как UTC (добавляем Z)
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

async function resolveUploadMeta(req: express.Request): Promise<UploadMeta> {
  const snapshot_at = parseDatetimeLocalAsUTC(String((req.body as any)?.snapshot_at || ""));
  const providedServer = String((req.body as any)?.server_name || "").trim();
  if (providedServer) return { server_name: providedServer, snapshot_at };

  // если не указан сервер — оставляем предыдущее значение (если есть), иначе null
  const last = await getLastServer();
  return { server_name: last, snapshot_at };
}

// ---- Queries for UI

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
    size_pretty: string;
  }>(
    `
    SELECT server_name, snapshot_at, db_name, size_bytes::text, size_pretty
    FROM db_sizes
    WHERE server_name IS NOT DISTINCT FROM $1
      AND snapshot_at = $2
    ORDER BY size_bytes DESC, db_name ASC
    `,
    [server, snapshotAtISO]
  );
  return r.rows;
}

// ---- Main page

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

      <p style="margin-top:10px;">
        <a href="/charts">Открыть графики</a>
      </p>
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

    <hr/>
    <p><b>API</b></p>
    <ul>
      <li><a href="/api/servers">/api/servers</a></li>
      <li><a href="/api/diff">/api/diff</a> (delta last vs previous; можно ?server=...)</li>
    </ul>
  `);
});

// ---- Upload

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

  // Если дата среза не указана — используем now()
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

// ---- API

app.get("/api/servers", async (_req, res) => {
  const r = await pool.query<{ server_name: string }>(
    `SELECT DISTINCT server_name
     FROM uploads
     WHERE server_name IS NOT NULL AND server_name <> ''
     ORDER BY server_name`
  );
  res.json(r.rows.map((x) => x.server_name));
});

// snapshots list per server (for bar chart dropdown)
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

// rows for a given snapshot (bar chart)
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

// rows for line chart: all dbs across time for a server
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

// diff endpoint (как раньше, но оставим)
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

// ---- Charts page (2 charts + back button)

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
  // rows: [{db_name, snapshot_at, size_bytes}]
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
  const { labels, datasets } = buildLineDatasets(rows);

  const ctx = document.getElementById('lineChart');
  if (lineChart) lineChart.destroy();

  lineChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
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

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(\`Listening on \${PORT}\`));
