export type ParsedRow = {
  db_name: string;
  size_pretty: string;
  size_bytes: number;
};

export function parseSizePrettyToBytes(s: string): number | null {
  const str = s.trim();
  const m = str.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!m) return null;

  const value = Number(m[1]);
  const unit = m[2].toLowerCase();

  const multipliers: Record<string, number> = {
    bytes: 1,
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
    pb: 1024 ** 5
  };

  const mul = multipliers[unit];
  if (!mul || !Number.isFinite(value)) return null;

  return Math.round(value * mul);
}

export function parsePgSizeOutput(text: string): ParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows: ParsedRow[] = [];

  for (const line of lines) {
    if (line.toLowerCase().startsWith("datname")) continue;
    if (line.startsWith("-")) continue;
    if (/\(\d+\s+rows\)/i.test(line)) continue;

    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 2) continue;

    const db_name = parts[0];
    const size_pretty = parts[1];
    const size_bytes = parseSizePrettyToBytes(size_pretty);

    if (!db_name || size_bytes === null) continue;

    rows.push({ db_name, size_pretty, size_bytes });
  }

  return rows;
}
