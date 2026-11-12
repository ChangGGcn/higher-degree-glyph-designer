/* Higher Degree — stable Bernstein geometry, original implementation. */
(function (root) {
  'use strict';
  let sequence = 0;
  const uid = () => 'p' + (++sequence).toString(36);
  const point = (x, y) => ({ id: uid(), x, y });
  const clone = value => JSON.parse(JSON.stringify(value));
  const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const segmentTypes = ['line', 'quadratic', 'cubic', 'quartic'];
  const typeForControls = count => segmentTypes[count] || 'bezier';
  function elevate(points) {
    const n = points.length - 1;
    return [points[0], ...points.slice(1).map((p, i) => mix(p, points[i], (i + 1) / (n + 1))), points.at(-1)];
  }
  function evaluate(points, t) {
    if (t <= 0) return { x: points[0].x, y: points[0].y };
    if (t >= 1) return { x: points.at(-1).x, y: points.at(-1).y };
    const weights = bernsteinWeights(points.length - 1, t);
    let x = 0, y = 0;
    for (let i = 0; i < points.length; i++) { x += points[i].x * weights[i]; y += points[i].y * weights[i]; }
    return { x, y };
  }
  function bernsteinWeights(n, t) {
    const weights = new Float64Array(n + 1);
    if (t <= 0) { weights[0] = 1; return weights; }
    if (t >= 1) { weights[n] = 1; return weights; }
    // Start at the binomial mode, preventing factorial overflow and endpoint underflow.
    const mode = Math.min(n, Math.floor((n + 1) * t)); weights[mode] = 1; let total = 1;
    for (let i = mode; i > 0; i--) { weights[i - 1] = weights[i] * i / (n - i + 1) * (1 - t) / t; total += weights[i - 1]; }
    for (let i = mode; i < n; i++) { weights[i + 1] = weights[i] * (n - i) / (i + 1) * t / (1 - t); total += weights[i + 1]; }
    for (let i = 0; i <= n; i++) weights[i] /= total;
    return weights;
  }
  function subdivide(points, t = 0.5) {
    const n = points.length - 1, xs = Float64Array.from(points, p => p.x), ys = Float64Array.from(points, p => p.y);
    const left = [points[0]], right = Array(n + 1); right[n] = points[n];
    for (let level = 1; level <= n; level++) {
      for (let i = 0; i <= n - level; i++) { xs[i] += (xs[i + 1] - xs[i]) * t; ys[i] += (ys[i + 1] - ys[i]) * t; }
      left.push({ x: xs[0], y: ys[0] }); right[n - level] = { x: xs[n - level], y: ys[n - level] };
    }
    return [left, right];
  }
  function elevateCubic(p) {
    return [p[0], mix(p[0], p[1], 0.75), mix(p[1], p[2], 0.5), mix(p[2], p[3], 0.25), p[3]];
  }
  function reduceQuartic(p) {
    const cubic = [p[0], mix(p[0], p[1], 4 / 3), mix(p[4], p[3], 4 / 3), p[4]];
    // Quartic minus elevated cubic = 6*t²*(1-t)² * (P2 - (Q1+Q2)/2).
    // Thus the maximum same-parameter Euclidean error is exactly 3/8 of this vector.
    return { cubic, error: 0.375 * distance(p[2], mix(cubic[1], cubic[2], 0.5)) };
  }
  function reduceBezier(p) {
    if (p.length === 5) return reduceQuartic(p);
    const n = p.length - 1, cubic = [p[0], mix(p[0], p[1], n / 3), mix(p[n], p[n - 1], n / 3), p[n]], denom = n * (n - 1) * (n - 2);
    let error = 0;
    for (let i = 1; i < n; i++) {
      const j = n - i, weights = [j * (j - 1) * (j - 2), 3 * i * j * (j - 1), 3 * i * (i - 1) * j, i * (i - 1) * (i - 2)];
      let x = 0, y = 0; for (let k = 0; k < 4; k++) { x += weights[k] / denom * cubic[k].x; y += weights[k] / denom * cubic[k].y; }
      error = Math.max(error, Math.hypot(p[i].x - x, p[i].y - y));
    }
    // Difference control polygons give a conservative convex-hull error bound.
    return { cubic, error };
  }
  function derivativePoints(points, order = 1) {
    let row = points;
    for (let k = 0; k < order; k++) { const n = row.length - 1; row = row.slice(1).map((p, i) => ({ x: n * (p.x - row[i].x), y: n * (p.y - row[i].y) })); }
    return row;
  }
  function toCubics(points, tolerance = 0.25) {
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('误差必须为正数');
    if (points.length < 2) throw new Error('曲线至少需要两个端点');
    if (points.length < 5) {
      let cubic = points;
      while (cubic.length < 4) cubic = elevate(cubic);
      return [{ points: cubic, error: 0, t0: 0, t1: 1 }];
    }
    const output = [];
    // Large degrees use a Hermite remainder bound instead of quadratic-cost splitting.
    if (points.length > 129) {
      const derivative = derivativePoints(points), fourth = derivativePoints(points, 4);
      const bound = fourth.reduce((max, p) => Math.max(max, Math.hypot(p.x, p.y)), 0) / 384;
      const visitInterval = (t0, t1, a, b, da, db, depth) => {
        const h = t1 - t0, error = bound * h ** 4;
        if (error <= tolerance) { output.push({ points: [a, { x: a.x + da.x * h / 3, y: a.y + da.y * h / 3 }, { x: b.x - db.x * h / 3, y: b.y - db.y * h / 3 }, b], error, t0, t1 }); return; }
        if (depth >= 20 || output.length >= 65536) throw new Error('曲线细分量过大，请增大近似容差');
        const tm = (t0 + t1) / 2, mid = evaluate(points, tm), dm = evaluate(derivative, tm);
        visitInterval(t0, tm, a, mid, da, dm, depth + 1); visitInterval(tm, t1, mid, b, dm, db, depth + 1);
      };
      visitInterval(0, 1, points[0], points.at(-1), derivative[0], derivative.at(-1), 0); return output;
    }
    function visit(p, t0, t1, depth) {
      const reduced = reduceBezier(p);
      if (reduced.error <= tolerance) {
        output.push({ points: reduced.cubic, error: reduced.error, t0, t1 }); return;
      }
      if (depth >= 20) throw new Error('曲线细分超出安全限制');
      const halves = subdivide(p);
      const tm = (t0 + t1) / 2;
      visit(halves[0], t0, tm, depth + 1); visit(halves[1], tm, t1, depth + 1);
    }
    visit(points, 0, 1, 0);
    return output;
  }
  function segmentPoints(contour, index) {
    const segment = contour.segments[index];
    return [contour.nodes[index], ...segment.controls, contour.nodes[(index + 1) % contour.nodes.length]];
  }
  function makeSegment(start, end, type = 'quartic') {
    const count = Number.isInteger(type) ? type : type === 'bezier' ? 4 : segmentTypes.indexOf(type);
    if (count < 0 || count > 19998) throw new Error('控制点数量超出文档容量');
    return { id: uid(), type: typeForControls(count), controls: Array.from({ length: count }, (_, i) => (i + 1) / (count + 1)).map(t => {
      const p = mix(start, end, t); return point(p.x, p.y);
    }) };
  }
  const newContour = start => ({ id: uid(), closed: false, nodes: [start], segments: [] });
  function append(contour, end, type = 'quartic', controls) {
    const segment = makeSegment(contour.nodes.at(-1), end, controls ? controls.length : type);
    if (controls) { segment.controls = controls.map(p => point(p.x, p.y)); segment.type = typeForControls(controls.length); }
    contour.segments.push(segment); contour.nodes.push(end); return segment;
  }
  function closeContour(contour, type = 'line', controls) {
    if (contour.closed || contour.nodes.length < 2) return false;
    const segment = makeSegment(contour.nodes.at(-1), contour.nodes[0], controls ? controls.length : type);
    if (controls) { segment.controls = controls.map(p => point(p.x, p.y)); segment.type = typeForControls(controls.length); }
    contour.segments.push(segment); contour.closed = true; return true;
  }
  function splitSegment(contour, index, t) {
    if (!(t > 0 && t < 1)) throw new Error('分割位置必须位于曲线内部');
    const segment = contour.segments[index];
    const [left, right] = subdivide(segmentPoints(contour, index), t);
    const mid = point(left.at(-1).x, left.at(-1).y);
    mid.smooth = true;
    const piece = p => ({ id: uid(), type: segment.type, controls: p.slice(1, -1).map(v => point(v.x, v.y)) });
    contour.nodes.splice(index + 1, 0, mid);
    contour.segments.splice(index, 1, piece(left), piece(right));
    return mid;
  }
  function reverseContour(contour) {
    const oldNodes = contour.nodes.slice(), oldSegments = contour.segments.slice();
    contour.nodes.reverse();
    contour.segments = contour.closed
      ? oldNodes.map((_, i) => oldSegments[(oldNodes.length - 2 - i + oldNodes.length) % oldNodes.length])
      : oldSegments.reverse();
    contour.segments.forEach(s => s.controls.reverse());
  }
  function allPoints(doc) {
    return doc.contours.flatMap(c => [
      ...c.nodes.map((p, index) => ({ point: p, contour: c, index, kind: 'node' })),
      ...c.segments.flatMap((s, index) => s.controls.map((p, control) => ({ point: p, contour: c, index, control, kind: 'control' })))
    ]);
  }
  function removeNodes(contour, ids) {
    const keep = contour.nodes.map((p, i) => ids.has(p.id) ? -1 : i).filter(i => i >= 0);
    if (keep.length === contour.nodes.length) return;
    const closed = contour.closed && keep.length >= 2;
    const nodes = keep.map(i => contour.nodes[i]);
    const count = closed ? nodes.length : Math.max(0, nodes.length - 1);
    const segments = [];
    for (let i = 0; i < count; i++) {
      const source = keep[i], next = keep[(i + 1) % keep.length];
      segments.push(next === (source + 1) % contour.nodes.length && contour.segments[source]
        ? contour.segments[source] : makeSegment(nodes[i], nodes[(i + 1) % nodes.length], 'line'));
    }
    Object.assign(contour, { nodes, segments, closed });
  }
  function bounds(doc) {
    const points = allPoints(doc).map(entry => entry.point);
    if (!points.length) return { minX: 0, maxX: doc.glyph.advanceWidth, minY: doc.glyph.descender, maxY: doc.glyph.ascender };
    return points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y) }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  }
  function emptyDocument() {
    return { format: 'higher-degree-glyph', version: 3,
      glyph: { name: 'untitled', unicode: '', upm: 1000, advanceWidth: 600, ascender: 800, descender: -200, capHeight: 700, xHeight: 500 }, contours: [] };
  }
  function sampleDocument() {
    const doc = emptyDocument();
    Object.assign(doc.glyph, { name: 'a', unicode: '0061', advanceWidth: 540 });
    const c = newContour(point(472, 0));
    const line = (x, y) => append(c, point(x, y), 'line');
    const curve = (x1, y1, x2, y2, x, y) => {
      const end = point(x, y);
      const p = elevateCubic([c.nodes.at(-1), { x: x1, y: y1 }, { x: x2, y: y2 }, end]);
      append(c, end, 'quartic', p.slice(1, -1));
    };
    line(384, 0); line(377, 64);
    curve(343, 13, 293, -12, 225, -12);
    curve(115, -12, 60, 73, 60, 235);
    curve(60, 397, 143, 500, 260, 500);
    curve(309, 500, 352, 477, 380, 438);
    line(384, 488); line(472, 488); closeContour(c);
    c.segments[4].controls[1].x -= 24;
    const inner = newContour(point(370, 242));
    const innerCurve = (x1, y1, x2, y2, x, y, close = false) => {
      const end = close ? inner.nodes[0] : point(x, y);
      const p = elevateCubic([inner.nodes.at(-1), { x: x1, y: y1 }, { x: x2, y: y2 }, end]);
      if (close) closeContour(inner, 'quartic', p.slice(1, -1));
      else append(inner, end, 'quartic', p.slice(1, -1));
    };
    innerCurve(370, 356, 334, 417, 271, 417);
    innerCurve(202, 417, 160, 350, 160, 243);
    innerCurve(160, 126, 198, 72, 268, 72);
    innerCurve(331, 72, 370, 132, 370, 242, true);
    doc.contours.push(c, inner); return doc;
  }
  function validateDocument(raw) {
    const fail = message => { throw new Error(message); };
    if (!raw || !(raw.format === 'quartic-glyph' && [1, 2].includes(raw.version) || raw.format === 'higher-degree-glyph' && raw.version === 3)) fail('需要 Higher Degree v3 或旧 Quartic v1/v2 格式的 .glyph 文件');
    const g = raw.glyph;
    if (!g || typeof g.name !== 'string' || !g.name.trim() || g.name.length > 128) fail('字形名称无效');
    if (typeof g.unicode !== 'string' || !/^(?:[0-9a-fA-F]{4,6})?$/.test(g.unicode)) fail('Unicode 应为 4–6 位十六进制码位');
    const codepoint = parseInt(g.unicode, 16);
    if (codepoint > 0x10FFFF || codepoint >= 0xD800 && codepoint <= 0xDFFF) fail('Unicode 码位无效');
    for (const key of ['upm', 'advanceWidth', 'ascender', 'descender', 'capHeight', 'xHeight']) {
      if (!Number.isFinite(g[key]) || Math.abs(g[key]) > 100000) fail('字形度量值无效：' + key);
    }
    if (g.upm < 16 || g.advanceWidth < 0 || g.ascender <= 0 || g.descender > 0 || g.ascender <= g.descender || g.xHeight < 0 || g.capHeight < g.xHeight || g.capHeight > g.ascender) fail('请检查字形度量的大小关系');
    if (!Array.isArray(raw.contours) || raw.contours.length > 256) fail('轮廓数量无效或超出 256 个');
    let count = 0;
    function cleanPoint(p) {
      if (++count > 20000) fail('控制点数量超出 20,000 个');
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) fail('点坐标必须是有效数字且绝对值不超过 1,000,000');
      if (p.smooth !== undefined && typeof p.smooth !== 'boolean') fail('节点类型无效');
      return { ...point(p.x, p.y), ...(p.smooth !== undefined ? { smooth: p.smooth } : {}) };
    }
    const contours = raw.contours.map(c => {
      if (!c || !Array.isArray(c.nodes) || !Array.isArray(c.segments) || typeof c.closed !== 'boolean' || c.nodes.length < 1) fail('轮廓结构无效');
      if (c.closed && c.nodes.length < 2 || c.segments.length !== c.nodes.length - (c.closed ? 0 : 1)) fail('节点与曲线段数量不匹配');
      const nodes = c.nodes.map(cleanPoint);
      const segments = c.segments.map(s => {
        if (!s || !Array.isArray(s.controls) || s.type !== typeForControls(s.controls.length)) fail('曲线类型与控制点数量不匹配');
        if (raw.version === 1 && !['line', 'quartic'].includes(s.type)) fail('旧版文件仅支持直线和四次曲线');
        if (raw.version === 2 && s.controls.length > 3) fail('v2 文件不支持高于四次的曲线，请使用 v3');
        return { id: uid(), type: s.type, controls: s.controls.map(cleanPoint) };
      });
      for (const key of ['component', 'name']) if (c[key] !== undefined && (typeof c[key] !== 'string' || c[key].length > 128)) fail('构件名称无效');
      return { id: uid(), closed: c.closed, nodes, segments, ...(c.component ? { component: c.component } : {}), ...(c.name ? { name: c.name } : {}) };
    });
    return { format: 'higher-degree-glyph', version: 3, glyph: Object.fromEntries(['name', 'unicode', 'upm', 'advanceWidth', 'ascender', 'descender', 'capHeight', 'xHeight'].map(k => [k, g[k]])), contours };
  }
  function serialize(doc) {
    return JSON.stringify(doc, (key, value) => key === 'id' ? undefined : value, 2);
  }
  const escapeXML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const fmt = n => String(Number(n.toFixed(6)));
  const pair = p => `${fmt(p.x)} ${fmt(p.y)}`;
  const conversionTolerance = tolerance => Math.max(tolerance - 0.000002, tolerance * 0.99);
  function svgExport(doc, tolerance = 0.25) {
    let cubicCount = 0, maxError = 0;
    const closed = [], open = [];
    for (const contour of doc.contours) {
      if (!contour.segments.length) continue;
      let d = 'M ' + pair(contour.nodes[0]);
      contour.segments.forEach((segment, i) => {
        const p = segmentPoints(contour, i);
        if (segment.type === 'line') d += ' L ' + pair(p.at(-1));
        else {
          // Reserve rounding error below 1e-6 font units for serialized coordinates.
          for (const cubic of toCubics(p, conversionTolerance(tolerance))) {
            d += ' C ' + cubic.points.slice(1).map(pair).join(' ');
            cubicCount++; maxError = Math.max(maxError, cubic.error);
          }
        }
      });
      if (contour.closed) closed.push(d + ' Z'); else open.push(d);
    }
    const b = bounds(doc), g = doc.glyph;
    const x = Math.min(0, b.minX), top = Math.max(g.ascender, b.maxY), bottom = Math.min(g.descender, b.minY), right = Math.max(g.advanceWidth, b.maxX);
    const paths = [];
    if (closed.length) paths.push(`    <path fill="currentColor" fill-rule="evenodd" d="${closed.join(' ')}"/>`);
    if (open.length) paths.push(`    <path fill="none" stroke="currentColor" stroke-width="1" d="${open.join(' ')}"/>`);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(x)} ${fmt(-top)} ${fmt(right - x)} ${fmt(top - bottom)}" color="#16151b">\n  <title>${escapeXML(g.name)}</title>\n  <desc>Higher-degree glyph converted to cubic Bezier; tolerance ${fmt(tolerance)} font units. Open contours use a 1-unit stroke.</desc>\n  <g transform="scale(1,-1)">\n${paths.join('\n')}\n  </g>\n</svg>\n`;
    return { svg, cubicCount, maxError, openCount: open.length };
  }
  const api = { uid, point, clone, mix, distance, segmentTypes, typeForControls, elevate, bernsteinWeights, evaluate, subdivide, elevateCubic, reduceQuartic, reduceBezier, derivativePoints, toCubics, segmentPoints, makeSegment, newContour, append, closeContour, splitSegment, reverseContour, allPoints, removeNodes, bounds, emptyDocument, sampleDocument, validateDocument, serialize, svgExport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuarticGeometry = api;
  root.HigherDegreeGeometry = api;
  api.conversionTolerance = conversionTolerance;
})(typeof globalThis !== 'undefined' ? globalThis : this);
