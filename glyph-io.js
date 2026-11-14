/* Shared cubic conversion and standard UFO GLIF export. */
(function (G) {
  'use strict';
  const round = n => Number(n.toFixed(6));
  const clean = p => G.point(round(p.x), round(p.y));
  const escapeXML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  function cubicDocument(doc, tolerance = .25) {
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('转换容差必须大于零');
    let cubicCount = 0, maxError = 0;
    const output = { format: 'higher-degree-glyph', version: 3, glyph: G.clone(doc.glyph), contours: [] };
    for (const c of doc.contours) {
      const first = clean(c.nodes[0]); if (c.nodes[0].smooth !== undefined) first.smooth = c.nodes[0].smooth;
      const converted = G.newContour(first);
      if (c.component) converted.component = c.component;
      if (c.name) converted.name = c.name;
      c.segments.forEach((segment, i) => {
        const points = G.segmentPoints(c, i), finalSegment = i === c.segments.length - 1;
        if (!segment.controls.length) {
          const end = clean(points.at(-1)); if (points.at(-1).smooth !== undefined) end.smooth = points.at(-1).smooth;
          if (c.closed && finalSegment) G.closeContour(converted, 'line'); else G.append(converted, end, 'line');
          return;
        }
        const cubics = G.toCubics(points, G.conversionTolerance(tolerance));
        cubics.forEach((part, j) => {
          const lastPart = j === cubics.length - 1, p = part.points.map(clean), end = p[3];
          end.smooth = !lastPart || !!points.at(-1).smooth;
          if (c.closed && finalSegment && lastPart) G.closeContour(converted, 'cubic', p.slice(1, 3));
          else G.append(converted, end, 'cubic', p.slice(1, 3));
          cubicCount++; maxError = Math.max(maxError, part.error);
        });
      });
      output.contours.push(converted);
    }
    return { doc: output, cubicCount, maxError, tolerance };
  }
  function cubicGlyphExport(doc, tolerance = .25) {
    const result = cubicDocument(doc, tolerance);
    G.validateDocument(result.doc); // Ensure a downloaded native file can be re-imported.
    return { ...result, text: G.serialize(result.doc) };
  }
  function glifExport(doc, tolerance = .25) {
    const result = cubicDocument(doc, tolerance);
    if (G.prepareGlifExport) result.doc = G.prepareGlifExport(result.doc);
    result.cubicCount = result.doc.contours.reduce((count, c) => count + c.segments.filter(s => s.type === 'cubic').length, 0);
    const g = result.doc.glyph;
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<glyph name="${escapeXML(g.name)}" format="2">`, `  <advance width="${round(g.advanceWidth)}"/>`];
    if (g.unicode) lines.push(`  <unicode hex="${g.unicode.toUpperCase()}"/>`);
    const emitPoint = (p, type, smooth = false) => lines.push(`      <point x="${round(p.x)}" y="${round(p.y)}"${type ? ` type="${type}"` : ''}${smooth && type && type !== 'move' ? ' smooth="yes"' : ''}/>`);
    if (result.doc.contours.length) {
      lines.push('  <outline>');
      for (const c of result.doc.contours) {
        lines.push('    <contour>');
        // GLIF point types describe the incoming segment. A closed contour's
        // final off-curves precede the first on-curve cyclically.
        emitPoint(c.nodes[0], c.closed ? c.segments.at(-1).type === 'line' ? 'line' : 'curve' : 'move', c.nodes[0].smooth);
        c.segments.forEach((s, i) => {
          s.controls.forEach(p => emitPoint(p));
          if (!(c.closed && i === c.segments.length - 1)) emitPoint(c.nodes[i + 1], s.type === 'line' ? 'line' : 'curve', c.nodes[i + 1].smooth);
        });
        lines.push('    </contour>');
      }
      lines.push('  </outline>');
    }
    // A namespaced lib entry preserves metrics without inventing GLIF attributes.
    lines.push('  <lib>', '    <dict>', '      <key>com.higher-degree-glyph-designer.metrics</key>', '      <dict>');
    for (const key of ['upm', 'ascender', 'descender', 'capHeight', 'xHeight']) lines.push(`        <key>${key}</key><real>${g[key]}</real>`);
    lines.push('      </dict>', '    </dict>', '  </lib>', '</glyph>', '');
    return { ...result, text: lines.join('\n') };
  }
  Object.assign(G, { cubicDocument, cubicGlyphExport, glifExport });
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof module !== 'undefined' && module.exports ? require('./geometry') : globalThis.HigherDegreeGeometry);
