const express = require("express");
const multer = require("multer");
const { pool } = require("./db");
const { parsePgSizeOutput } = require("./parser");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  res.type("html").send(`
    <h2>PG Size Tracker</h2>
    <p>Upload a text file containing: datname | pg_size_pretty ...</p>
    <form action="/upload" method="post" enctype="multipart/form-data">
      <input type="file" name="file" accept=".txt,text/plain" required />
      <button type="submit">Upload</button>
    </form>
    <hr/>
    <p>API:</p>
    <ul>
      <li><a href="/api/databases">/api/databases</a> (latest sizes)</li>
      <li>/api/databases/&lt;name&gt;/history</li>
    </ul>
  `);
});

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");

  const content = req.file.buffer.toString("utf-8");
  const parsed = parsePgSizeOutput(content);

  if (parsed.length === 0) {
    return res.status(400).send("Could not parse any rows. Check the file format.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const up = await client.query(
      "INSERT INTO uploads (original_name, content) VALUES ($1, $2) RETURNING id, uploaded_at",
      [req.file.originalname, content]
    );
    const uploadId = up.rows[0].id;

    const values = [];
    const placeholders = [];
    let i = 1;

    for (const r of parsed) {
      // (upload_id, db_name, size_bytes, size_pretty)
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(uploadId, r.db_name, r.size_bytes, r.size_pretty);
    }

    await client.query(
      `INSERT INTO db_sizes (upload_id, db_name, size_bytes, size_pretty)
       VALUES ${placeholders.join(", ")}`,
      values
    );

    await client.query("COMMIT");

    res.type("html").send(`
      <h3>Uploaded OK</h3>
      <p>File: ${escapeHtml(req.file.originalname)}</p>
      <p>Parsed rows: ${parsed.length}</p>
      <p><a href="/api/databases">See latest sizes</a></p>
      <p><a href="/">Upload another</a></p>
    `);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).send("Upload failed: " + e.message);
  } finally {
    client.release();
  }
});

app.get("/api/databases", async (req, res) => {
  // latest row per db_name
  const q = `
    SELECT DISTINCT ON (db_name)
      db_name, size_bytes, size_pretty, captured_at
    FROM db_sizes
    ORDER BY db_name, captured_at DESC;
  `;
  const r = await pool.query(q);
  res.json(r.rows);
});

app.get("/api/databases/:name/history", async (req, res) => {
  const name = req.params.name;
  const limit = Math.min(Number(req.query.limit || 200), 1000);

  const q = `
    SELECT db_name, size_bytes, size_pretty, captured_at
    FROM db_sizes
    WHERE db_name = $1
    ORDER BY captured_at ASC
    LIMIT $2;
  `;
  const r = await pool.query(q, [name, limit]);
  res.json(r.rows);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
