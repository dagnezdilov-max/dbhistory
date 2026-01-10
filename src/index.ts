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

// datetime-local не содержит timezone.
// Мы трактуем введённое значение как UTC: "2026-01-11T10:00" -> "2026-01-11T10:00Z"
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

app.get("/", async (_req, res) => {
  const lastServer = await getLastServer();

  res.type("html").send(`
    <h2>PG Size Tracker</h2>

    <p><b>Загрузка среза</b> (файл или вставка текста). Дата среза и сервер — опциональны.</p>
    <p style="color:#555">
      Примечание: поле "Дата среза" (datetime-local) сохраняется как UTC (добавляется суффикс Z).
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
    <p><b>Навигация</b></p>
    <ul>
      <li><a href="/api/servers">/api/servers</a></li>
      <li><a href="/api/databases">/api/databases</a> (latest sizes; можно ?server=...)</li>
      <li>/api/databases/&lt;name&gt;/history?server=...&limit=200</li>
      <li><a href="/api/diff">/api/diff</a> (delta last vs previous; можно ?server=...)</li>
      <li><a href="/charts">/charts</a> (графики с переключением серверов)</li>
    </ul>
  `);
});

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
      // (upload_id, captured_at, snapshot_at, server_name, db_name, size_bytes, size_pretty)
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

    res.type("html").send(`
      <h3>Uploaded OK</h3>
      <p>Server: <b>${escapeHtml(meta.server_name ?? "(empty)")}</b></p>
      <p>Snapshot at (UTC): <b>${escapeHtml(snapshot_at.toISOString())}</b></p>
      <p>Rows parsed: <b>${parsed.length}</b></p>
      <p><a href="/api/databases${meta.server_name ? `?server=${encodeURIComponent(meta.server_name)}` : ""}">See latest sizes</a></p>
      <p><a href="/charts">Charts</a></p>
      <p><a href="/">Upload another</a></p>
    `);
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).send("Upload failed: " + e?.message);
  } finally {
    client.release();
  }
});

// --- API: servers
app.get("/api/servers", async (_req, res) => {
  const r = await pool.query<{ server_name: string }>(
    `SELECT DISTINCT server_name
     FROM uploads
     WHERE server_name IS NOT NULL AND server_name <> ''
     ORDER BY server_name`
  );
  res.json(r.rows.map(x => x.server_name));
});

// --- API: latest sizes (опционально фильтр по server)
app.get("/api/databases", async (req, res) => {
  const server = String(req.query.server || "").trim();

  const q = server
    ? `
      SELECT DISTINCT ON (db_name)
        server_name, db_name, size_bytes, size_pretty, snapshot_at
      FROM db_sizes
      WHERE server_name = $1
      ORDER BY db_name, snapshot_at DESC;
    `
    : `
      SELECT DISTINCT ON (server_name, db_name)
        server_name, db_name, size_bytes, size_pretty, snapshot_at
      FROM db_sizes
      ORDER BY server_name, db_name, snapshot_at DESC;
    `;

  const r = server ? await pool.query(q, [server]) : await pool.query(q);
  res.json(r.rows);
});

// --- API: history for db (server optional but recommended for charts)
app.get("/api/databases/:name/history", async (req, res) => {
  const name = req.params.name;
  const server = String(req.query.server || "").trim();
  const limit = Math.min(Number(req.query.limit || 200), 2000);

  if (!server) {
    return res.status(400).json({ error: "Please provide ?server=..." });
  }

  const q = `
    SELECT server_name, db_name, size_bytes, size_pretty, snapshot_at
    FROM db_sizes
    WHERE server_name = $1 AND db_name = $2
    ORDER BY snapshot_at ASC
    LIMIT $3;
  `;
  const r = await pool.query(q, [server, name, limit]);
  res.json(r.rows);
});

// --- API: diff (latest vs previous) per db, with optional server filter
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

// --- UI: charts page (servers switch + db switch + chart)
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
  <h2>DB Size Charts</h2>

  <div style="margin-bottom:12px;">
    <label>Server: </label>
    <select id="serverSelect"></select>

    <label style="margin-left:12px;">Database: </label>
    <select id="dbSelect"></select>

    <button id="reloadBtn" style="margin-left:12px;">Load</button>
  </div>

  <canvas id="chart" width="1100" height="420"></canvas>

  <p style="color:#555;">
    Подсказка: загружай исторические файлы, указывая дату среза — график выстроится по snapshot_at.
  </p>

<script>
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function bytesToGB(x) { return x / (1024**3); }

let chart;

async function loadServers() {
  const servers = await fetchJson('/api/servers');
  const sel = document.getElementById('serverSelect');
  sel.innerHTML = '';
  const optEmpty = document.createElement('option');
  optEmpty.value = '';
  optEmpty.textContent = '(empty)';
  sel.appendChild(optEmpty);

  for (const s of servers) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
}

async function loadDatabases(server) {
  const url = server ? ('/api/databases?server=' + encodeURIComponent(server)) : '/api/databases';
  const rows = await fetchJson(url);
  const sel = document.getElementById('dbSelect');
  sel.innerHTML = '';

  // rows format with server_name+db_name
  const dbNames = [...new Set(rows.map(r => r.db_name))].sort();
  for (const n of dbNames) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }
}

async function loadChart() {
  const server = document.getElementById('serverSelect').value;
  const db = document.getElementById('dbSelect').value;
  if (!server) {
    alert('Выбери server (для графиков требуется server).');
    return;
  }
  if (!db) return;

  const data = await fetchJson('/api/databases/' + encodeURIComponent(db) + '/history?server=' + encodeURIComponent(server) + '&limit=2000');

  const labels = data.map(x => new Date(x.snapshot_at).toISOString().slice(0,19).replace('T',' '));
  const values = data.map(x => bytesToGB(Number(x.size_bytes)));

  const ctx = document.getElementById('chart');
  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: server + ' / ' + db + ' (GB)',
        data: values
      }]
    },
    options: {
      responsive: false,
      scales: {
        y: { title: { display: true, text: 'GB' } },
        x: { title: { display: true, text: 'snapshot_at (UTC)' } }
      }
    }
  });
}

document.getElementById('reloadBtn').addEventListener('click', loadChart);
document.getElementById('serverSelect').addEventListener('change', async (e) => {
  await loadDatabases(e.target.value);
});

(async () => {
  await loadServers();
  const serverSel = document.getElementById('serverSelect');
  // auto select first real server if exists
  if (serverSel.options.length > 1) serverSel.selectedIndex = 1;
  await loadDatabases(serverSel.value);
  await loadChart();
})();
</script>

</body>
</html>
  `);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
