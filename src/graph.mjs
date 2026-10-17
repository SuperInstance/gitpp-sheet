// Render a fold as a graph with confidence on it.
//
// The point is NOT a prettier picture. It is that a graph can show
// something a table cannot: WHERE a low-confidence cell comes from.
//
// In a table, a cell at 0.31 confidence is a number in a column. In a
// graph, that cell is visibly downstream of one specific uncertain
// comparison, and you can see which other cells share that comparison.
//
// SVG rather than a canvas library: it is inspectable, it diffs in git,
// and it needs no runtime dependency. The output is a file, not a
// picture of a file.

const CLASS_COLOR = {
  override: "#e05252",
  task: "#4a90d9",
  witness: "#7b8794",
  unclassifiable: "#b06fd0",
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * @param sheet  from buildSheet()
 * @param records [{id, kind, parents, effects}]
 */
export function renderGraph(sheet, records, opts = {}) {
  const width = opts.width ?? 1000;
  const height = opts.height ?? 560;
  const byId = new Map(records.map((r) => [r.id, r]));

  // Layer the records by their depth in the parent DAG, so edges point
  // downward and a reader can see the dependency direction.
  const depth = new Map();
  const computeDepth = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;                       // cycle
    seen.add(id);
    const r = byId.get(id);
    const ps = (r?.parents ?? []).filter((p) => byId.has(p));
    const d = ps.length ? 1 + Math.max(...ps.map((p) => computeDepth(p, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  for (const r of records) computeDepth(r.id);

  const layers = new Map();
  for (const r of records) {
    const d = depth.get(r.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(r);
  }

  // Position: a layer per depth, left to right within the layer.
  const pos = new Map();
  const layerH = 90;
  for (const [d, rs] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const w = (width - 120) / rs.length;
    rs.forEach((r, i) => {
      pos.set(r.id, { x: 60 + i * w + w / 2, y: 60 + d * layerH });
    });
  }

  const cellFor = (id) => sheet.cells.find((c) => c.setter === id);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, Menlo, monospace">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#0f1115"/>`);

  // Edges first, so nodes sit on top.
  for (const r of records) {
    const to = pos.get(r.id);
    for (const p of r.parents ?? []) {
      const from = pos.get(p);
      if (!from || !to) continue;
      const broken = !sheet.cells.some((c) => c.dependsOn.includes(r.id) && c.dependsOn.includes(p));
      parts.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"
        stroke="${broken ? "#3a3f4b" : "#4a5160"}" stroke-width="1.2" ${broken ? 'stroke-dasharray="3 3"' : ""}/>`);
    }
  }

  // Nodes.
  for (const r of records) {
    const p = pos.get(r.id);
    if (!p) continue;
    const cell = cellFor(r.id);
    const kind = r.kind && CLASS_COLOR[r.kind] ? r.kind : "unclassifiable";
    const fill = CLASS_COLOR[kind];
    const conf = cell?.confidence ?? 1.0;
    // A dashed halo marks a record that set a cell with low confidence.
    const halo = cell && cell.fragile
      ? `<circle cx="${p.x}" cy="${p.y}" r="26" fill="none" stroke="#f5a623" stroke-width="1.6" stroke-dasharray="4 3"/>`
      : "";
    const label = esc(r.id.length > 14 ? r.id.slice(0, 13) + "…" : r.id);
    const confText = cell ? `${(conf * 100).toFixed(0)}%` : "";
    parts.push(`${halo}`);
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="17" fill="${fill}" fill-opacity="0.82" stroke="#0f1115" stroke-width="2"/>`);
    parts.push(`<text x="${p.x}" y="${p.y + 4}" font-size="10" fill="#fff" text-anchor="middle">${label}</text>`);
    if (confText) {
      parts.push(`<text x="${p.x}" y="${p.y + 32}" font-size="9" fill="${cell.fragile ? "#f5a623" : "#8b93a1"}" text-anchor="middle">${confText}</text>`);
    }
  }

  // Legend.
  const legend = [["override", "override"], ["task", "task"], ["witness", "witness"], ["unclassifiable", "unclassifiable"]];
  let lx = 60;
  for (const [label] of legend) {
    parts.push(`<circle cx="${lx}" cy="${height - 24}" r="7" fill="${CLASS_COLOR[label]}" fill-opacity="0.82"/>`);
    parts.push(`<text x="${lx + 13}" y="${height - 20}" font-size="10" fill="#8b93a1">${label}</text>`);
    lx += 30 + label.length * 6.5;
  }
  parts.push(`<circle cx="${lx + 20}" cy="${height - 24}" r="9" fill="none" stroke="#f5a623" stroke-width="1.4" stroke-dasharray="3 2"/>`);
  parts.push(`<text x="${lx + 35}" y="${height - 20}" font-size="10" fill="#8b93a1">set a fragile cell</text>`);

  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * A compact TEXT rendering of the same information, for terminals and
 * for diffing in git. A graph you cannot read as text is a picture.
 */
export function renderText(sheet, records) {
  const lines = [];
  const nameOf = new Map(records.map((r) => [r.id, r]));
  lines.push("  key".padEnd(22) + "value".padEnd(20) + "setter".padEnd(12) + "conf".padEnd(8) + "effect");
  lines.push("  " + "-".repeat(74));
  for (const c of sheet.cells) {
    const v = JSON.stringify(c.value);
    const setter = c.setter ? (nameOf.get(c.setter)?.kind ?? "?") : "-";
    const eff = c.contested ? `${c.dependsOn.length - 1} contested` : "settled";
    lines.push("  " + c.key.slice(0, 20).padEnd(22) + v.slice(0, 18).padEnd(20) +
      String(setter).slice(0, 10).padEnd(12) +
      (c.confidence * 100).toFixed(0).padStart(3) + "%  " + eff +
      (c.fragile ? "  <-- FRAGILE" : ""));
  }
  return lines.join("\n");
}
