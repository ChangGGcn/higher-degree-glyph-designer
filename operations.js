/* v0.3.0 arbitrary-degree editing operations. Original implementation; see REFERENCES.md. */
(function (G) {
  'use strict';
  const { point, uid, mix, distance, evaluate, segmentPoints } = G;
  const duplicatePoint = p => ({ ...p, id: uid() });
  function addControl(contour, index, maximum = null) {
    const segment = contour.segments[index];
    if (maximum !== null && segment.controls.length >= maximum) return null;
    const elevated = G.elevate(segmentPoints(contour, index));
    segment.controls = elevated.slice(1, -1).map(p => point(p.x, p.y));
    segment.type = G.typeForControls(segment.controls.length);
    return segment.controls[Math.floor(segment.controls.length / 2)];
  }
  function removeControls(doc, ids) {
    for (const c of doc.contours) c.segments.forEach(s => {
      s.controls = s.controls.filter(p => !ids.has(p.id)); s.type = G.typeForControls(s.controls.length);
    });
  }
  function nearestPoint(points, target) {
    if (points.length === 2) {
      const a = points[0], b = points[1], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const p = mix(a, b, t); return { t, point: p, distance: distance(p, target) };
    }
    // Search every sampled local minimum, then refine; endpoint minima are kept.
    const samples = Math.max(40, Math.min(1024, points.length * 3)), values = Array.from({ length: samples + 1 }, (_, i) => distance(evaluate(points, i / samples), target));
    let best = { t: 0, point: points[0], distance: values[0] };
    if (values[samples] < best.distance) best = { t: 1, point: points.at(-1), distance: values[samples] };
    for (let i = 0; i <= samples; i++) {
      if (values[i] > (values[i - 1] ?? Infinity) || values[i] > (values[i + 1] ?? Infinity)) continue;
      let a = Math.max(0, (i - 1) / samples), b = Math.min(1, (i + 1) / samples);
      for (let j = 0; j < 32; j++) {
        const t1 = a + (b - a) / 3, t2 = b - (b - a) / 3;
        if (distance(evaluate(points, t1), target) < distance(evaluate(points, t2), target)) b = t2; else a = t1;
      }
      const t = (a + b) / 2, p = evaluate(points, t), d = distance(p, target);
      if (d < best.distance) best = { t, point: p, distance: d };
    }
    return best;
  }
  function reshapeSegment(contour, index, t, delta, original) {
    const s = contour.segments[index], n = s.controls.length + 1;
    if (n < 2) throw new Error('直线必须先添加控制点');
    const weights = G.bernsteinWeights(n, t).slice(1, -1);
    const denominator = weights.reduce((sum, w) => sum + w * w, 0);
    if (denominator < 1e-12) return;
    s.controls.forEach((p, i) => { const base = original[i]; p.x = base.x + delta.x * weights[i] / denominator; p.y = base.y + delta.y * weights[i] / denominator; });
  }
  function cutAtNode(doc, contour, index) {
    const n = contour.nodes.length;
    if (!contour.closed && (index === 0 || index === n - 1)) return false;
    delete contour.component;
    if (contour.closed) {
      const start = contour.nodes[index];
      contour.nodes = [...contour.nodes.slice(index), ...contour.nodes.slice(0, index), duplicatePoint(start)];
      contour.segments = [...contour.segments.slice(index), ...contour.segments.slice(0, index)];
      contour.closed = false; contour.nodes[0].smooth = false; contour.nodes.at(-1).smooth = false;
    } else {
      const right = { id: uid(), closed: false, nodes: [duplicatePoint(contour.nodes[index]), ...contour.nodes.slice(index + 1)], segments: contour.segments.slice(index), ...(contour.name ? { name: contour.name + ' · 剪切' } : {}) };
      contour.nodes = contour.nodes.slice(0, index + 1); contour.segments = contour.segments.slice(0, index);
      right.nodes[0].smooth = false; contour.nodes.at(-1).smooth = false;
      doc.contours.splice(doc.contours.indexOf(contour) + 1, 0, right);
    }
    return true;
  }
  function cutAtParameter(doc, contour, index, t) {
    if (t < 1e-7) return cutAtNode(doc, contour, index);
    if (t > 1 - 1e-7) return cutAtNode(doc, contour, (index + 1) % contour.nodes.length);
    G.splitSegment(contour, index, t); return cutAtNode(doc, contour, index + 1);
  }
  function polynomialRoots(coefficients) {
    const coeff = coefficients.slice(), scale = Math.max(1, ...coeff.map(Math.abs)), epsilon = scale * 1e-10;
    while (coeff.length > 1 && Math.abs(coeff.at(-1)) < epsilon) coeff.pop();
    if (coeff.length < 2) return [];
    if (coeff.length === 2) { const t = -coeff[0] / coeff[1]; return t >= -1e-10 && t <= 1 + 1e-10 ? [Math.max(0, Math.min(1, t))] : []; }
    const evaluatePoly = t => coeff.reduceRight((value, c) => value * t + c, 0);
    const critical = polynomialRoots(coeff.slice(1).map((c, i) => c * (i + 1)));
    const intervals = [0, ...critical.filter(t => t > 0 && t < 1), 1], roots = [];
    for (const t of intervals) if (Math.abs(evaluatePoly(t)) < epsilon) roots.push(t);
    for (let i = 1; i < intervals.length; i++) {
      let lo = intervals[i - 1], hi = intervals[i], fa = evaluatePoly(lo), fb = evaluatePoly(hi);
      if (fa * fb >= 0 || Math.abs(fa) < epsilon || Math.abs(fb) < epsilon) continue;
      for (let j = 0; j < 55; j++) { const mid = (lo + hi) / 2, fm = evaluatePoly(mid); if (fa * fm <= 0) hi = mid; else { lo = mid; fa = fm; } }
      roots.push((lo + hi) / 2);
    }
    return roots.sort((a, b) => a - b).filter((t, i, list) => i === 0 || t - list[i - 1] > 1e-7);
  }
  function lineIntersections(points, start, end) {
    const dx = end.x - start.x, dy = end.y - start.y, length2 = dx * dx + dy * dy;
    if (length2 < 1e-12) return [];
    const values = points.map(p => (p.x - start.x) * dy - (p.y - start.y) * dx);
    if (values.every(v => Math.abs(v) < 1e-8)) return []; // overlapping edges have no unique cut position
    return bernsteinRoots(values).filter(t => {
      const p = evaluate(points, t), u = ((p.x - start.x) * dx + (p.y - start.y) * dy) / length2;
      return u >= -1e-8 && u <= 1 + 1e-8;
    });
  }
  function bernsteinRoots(values) {
    const scale = Math.max(1, ...values.map(Math.abs)), epsilon = scale * 1e-13, roots = [];
    if (values.every(v => Math.abs(v) < epsilon)) return [];
    const scalar = (row, t) => { const weights = G.bernsteinWeights(row.length - 1, t); let value = 0; for (let i = 0; i < row.length; i++) value += row[i] * weights[i]; return value; };
    function visit(row, t0, t1, depth) {
      let min = Infinity, max = -Infinity, last = 0, changes = 0;
      for (const value of row) { min = Math.min(min, value); max = Math.max(max, value); const sign = Math.abs(value) < epsilon ? 0 : Math.sign(value); if (sign) { if (last && last !== sign) changes++; last = sign; } }
      if (min > epsilon || max < -epsilon) return;
      if (Math.abs(row[0]) < epsilon) roots.push(t0);
      if (Math.abs(row.at(-1)) < epsilon) roots.push(t1);
      if (!changes) return;
      if (changes === 1 && row[0] * row.at(-1) < 0) {
        let a = 0, b = 1, fa = row[0];
        for (let i = 0; i < 45; i++) { const mid = (a + b) / 2, fm = scalar(row, mid); if (fa * fm <= 0) b = mid; else { a = mid; fa = fm; } }
        roots.push(t0 + (t1 - t0) * (a + b) / 2); return;
      }
      if (depth >= 40 || t1 - t0 < 1e-10) { roots.push((t0 + t1) / 2); return; }
      const data = Float64Array.from(row), n = row.length - 1, left = [row[0]], right = Array(n + 1); right[n] = row[n];
      for (let level = 1; level <= n; level++) { for (let i = 0; i <= n - level; i++) data[i] = (data[i] + data[i + 1]) / 2; left.push(data[0]); right[n - level] = data[n - level]; }
      const mid = (t0 + t1) / 2; visit(left, t0, mid, depth + 1); visit(right, mid, t1, depth + 1);
    }
    visit(values, 0, 1, 0);
    return roots.sort((a, b) => a - b).filter((t, i, list) => !i || t - list[i - 1] > 1e-7);
  }
  function extremaParameters(points) {
    const n = points.length - 1, ts = [];
    if (n < 2) return ts;
    for (const axis of ['x', 'y']) {
      const derivative = points.slice(1).map((p, i) => n * (p[axis] - points[i][axis]));
      ts.push(...bernsteinRoots(derivative));
    }
    return ts.filter(t => t > 1e-5 && t < 1 - 1e-5).sort((a, b) => a - b).filter((t, i, list) => i === 0 || t - list[i - 1] > 1e-5);
  }
  function addExtrema(contours) {
    let count = 0;
    for (const c of contours) for (let i = c.segments.length - 1; i >= 0; i--) {
      const ts = extremaParameters(segmentPoints(c, i)).reverse(); let upper = 1;
      for (const t of ts) { G.splitSegment(c, i, t / upper); upper = t; count++; }
    }
    return count;
  }
  function cutWithLine(doc, start, end, allowedIds) {
    const cuts = new Set();
    for (const c of [...doc.contours]) {
      if (allowedIds && !allowedIds.has(c.id)) continue;
      for (let i = c.segments.length - 1; i >= 0; i--) {
        const ts = lineIntersections(segmentPoints(c, i), start, end).sort((a, b) => b - a);
        let upper = 1;
        for (const t of ts) {
          if (t < 1e-7) cuts.add(c.nodes[i].id);
          else if (t > 1 - 1e-7) cuts.add(c.nodes[(i + 1) % c.nodes.length].id);
          else { const p = G.splitSegment(c, i, t / upper); cuts.add(p.id); upper = t; }
        }
      }
    }
    let count = 0;
    for (const id of cuts) for (const c of doc.contours) {
      const index = c.nodes.findIndex(p => p.id === id);
      if (index >= 0) { if (cutAtNode(doc, c, index)) count++; break; }
    }
    return count;
  }
  function joinEndpoints(doc, first, second) {
    let a = first.contour, b = second.contour;
    const ai = a.nodes.findIndex(p => p.id === first.point.id), bi = b.nodes.findIndex(p => p.id === second.point.id);
    if (a.closed || b.closed || ![0, a.nodes.length - 1].includes(ai) || ![0, b.nodes.length - 1].includes(bi)) throw new Error('请选择两个开放轮廓的端点');
    if (a === b) {
      if (ai === bi || a.nodes.length < 2) throw new Error('需要两个不同端点');
      if (distance(a.nodes[0], a.nodes.at(-1)) < 1e-7) { if (a.nodes.length < 3) throw new Error('合并后至少需要两个轮廓节点'); a.nodes.pop(); a.closed = true; }
      else G.closeContour(a, 'line');
      return a;
    }
    if (ai === 0) G.reverseContour(a);
    if (bi === b.nodes.length - 1) G.reverseContour(b);
    const coincident = distance(a.nodes.at(-1), b.nodes[0]) < 1e-7;
    if (!coincident) a.segments.push(G.makeSegment(a.nodes.at(-1), b.nodes[0], 'line'));
    a.nodes.push(...b.nodes.slice(coincident ? 1 : 0)); a.segments.push(...b.segments);
    doc.contours = doc.contours.filter(c => c !== b); delete a.component; return a;
  }
  function setStartPoint(contour, index) {
    if (!contour.closed) throw new Error('只有闭合轮廓可以更改起点');
    contour.nodes = [...contour.nodes.slice(index), ...contour.nodes.slice(0, index)];
    contour.segments = [...contour.segments.slice(index), ...contour.segments.slice(0, index)];
  }
  function pointBounds(points) {
    if (!points.length) return null;
    return { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) };
  }
  function transformPoints(points, { scaleX = 1, scaleY = 1, angle = 0, dx = 0, dy = 0, origin } = {}) {
    if (!points.length) return;
    const bounds = pointBounds(points), center = origin || { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    for (const p of points) { const x = (p.x - center.x) * scaleX, y = (p.y - center.y) * scaleY; p.x = center.x + x * cos - y * sin + dx; p.y = center.y + x * sin + y * cos + dy; }
  }
  function snapPosition(doc, position, { nodes = false, edges = false, grid = false, gridStep = 10, precision = 2, radius = 8, exclude = new Set() } = {}) {
    const round = n => precision < 0 ? n : Number(n.toFixed(precision));
    let result = { x: round(position.x), y: round(position.y) }, hint = null;
    if (grid) { result = { x: Math.round(position.x / gridStep) * gridStep, y: Math.round(position.y / gridStep) * gridStep }; hint = { type: 'grid', point: result }; }
    if (edges) {
      let nearest = radius;
      for (const c of doc.contours) c.segments.forEach((s, i) => {
        const ps = segmentPoints(c, i); if (ps.some(p => exclude.has(p.id))) return;
        const hit = nearestPoint(ps, position); if (hit.distance < nearest) { nearest = hit.distance; result = { ...hit.point }; hint = { type: 'edge', point: result }; }
      });
      if (!hint || hint.type === 'grid') {
        const xs = [0, doc.glyph.advanceWidth], ys = [0, doc.glyph.xHeight, doc.glyph.capHeight, doc.glyph.ascender, doc.glyph.descender];
        const x = xs.reduce((best, value) => Math.abs(value - position.x) < Math.abs(best - position.x) ? value : best, Infinity);
        const y = ys.reduce((best, value) => Math.abs(value - position.y) < Math.abs(best - position.y) ? value : best, Infinity);
        if (Math.abs(x - position.x) < radius) { result.x = x; hint = { type: 'alignment', x, point: result }; }
        if (Math.abs(y - position.y) < radius) { result.y = y; hint = { ...hint, type: 'alignment', y, point: result }; }
      }
    }
    if (nodes) {
      const candidates = doc.contours.flatMap(c => c.nodes).filter(p => !exclude.has(p.id));
      let best = null, nearest = radius;
      for (const p of candidates) { const d = distance(p, position); if (d < nearest) { nearest = d; best = p; } }
      if (best) { result = { x: best.x, y: best.y }; hint = { type: 'node', point: result }; }
      else if (!hint || hint.type === 'grid') {
        const x = candidates.filter(p => Math.abs(p.x - position.x) < radius).sort((a, b) => Math.abs(a.x - position.x) - Math.abs(b.x - position.x))[0];
        const y = candidates.filter(p => Math.abs(p.y - position.y) < radius).sort((a, b) => Math.abs(a.y - position.y) - Math.abs(b.y - position.y))[0];
        if (x) { result.x = x.x; hint = { type: 'alignment', x: x.x, point: result }; }
        if (y) { result.y = y.y; hint = { ...hint, type: 'alignment', y: y.y, point: result }; }
      }
    }
    return { point: result, hint };
  }
  function preserveSmooth(doc, changedIds, original) {
    const baseline = new Map(G.allPoints(original || doc).map(({ point: p }) => [p.id, p]));
    for (const c of doc.contours) c.nodes.forEach((node, i) => {
      if (!node.smooth) return;
      const incoming = c.segments[(i - 1 + c.nodes.length) % c.nodes.length]?.controls.at(-1), outgoing = c.segments[i]?.controls[0];
      if (!incoming || !outgoing) return;
      const moveIn = changedIds.has(incoming.id), moveOut = changedIds.has(outgoing.id);
      if (moveIn === moveOut) return;
      const source = moveIn ? incoming : outgoing, target = moveIn ? outgoing : incoming;
      const length = distance(baseline.get(target.id) || target, baseline.get(node.id) || node), direction = distance(source, node);
      if (direction > 1e-9) { target.x = node.x - (source.x - node.x) / direction * length; target.y = node.y - (source.y - node.y) / direction * length; }
    });
  }
  Object.assign(G, { addControl, removeControls, nearestPoint, reshapeSegment, cutAtNode, cutAtParameter, polynomialRoots, bernsteinRoots, lineIntersections, extremaParameters, addExtrema, cutWithLine, joinEndpoints, setStartPoint, pointBounds, transformPoints, snapPosition, preserveSmooth });
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof module !== 'undefined' && module.exports ? require('./geometry') : globalThis.QuarticGeometry);
