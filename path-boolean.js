/* Curve-preserving boolean operations using the locally bundled MIT Paper.js. */
(function (G) {
  'use strict';
  let paperScope;
  function getPaperScope(library = globalThis.paper) {
    if (!paperScope) { if (!library) throw new Error('离线布尔运算引擎未加载'); paperScope = new library.PaperScope(); paperScope.setup(new paperScope.Size(1, 1)); }
    paperScope.activate(); return paperScope;
  }
  function paperPath(contour, scope) {
    return new scope.Path({ insert: false, closed: contour.closed, fillRule: 'evenodd', fillColor: 'black', segments: contour.nodes.map((p, i) => {
      const outgoing = contour.segments[i], incoming = i > 0 ? contour.segments[i - 1] : contour.closed ? contour.segments.at(-1) : null;
      const a = incoming?.controls.at(-1), b = outgoing?.controls[0];
      return new scope.Segment(new scope.Point(p.x, p.y), a ? new scope.Point(a.x - p.x, a.y - p.y) : null, b ? new scope.Point(b.x - p.x, b.y - p.y) : null);
    }) });
  }
  function paperContours(item, { component = null, flipY = false } = {}) {
    const contours = [], round = n => Number(n.toFixed(8));
    const xy = p => G.point(round(p.x), round(flipY ? -p.y : p.y));
    function walk(path) {
      if (path.children) { path.children.forEach(walk); return; }
      if (path.className !== 'Path' || !path.segments.length) return;
      const c = G.newContour(xy(path.segments[0].point));
      for (let i = 0; i < path.curves.length; i++) {
        const curve = path.curves[i], p1 = curve.point1, p2 = curve.point2;
        const controls = curve.hasHandles() ? [xy(p1.add(curve.handle1)), xy(p2.add(curve.handle2))] : [];
        if (path.closed && i === path.curves.length - 1) G.closeContour(c, G.typeForControls(controls.length), controls);
        else G.append(c, xy(p2), G.typeForControls(controls.length), controls);
      }
      c.nodes.forEach((p, i) => {
        const segment = path.segments[i], a = segment.handleIn, b = segment.handleOut, product = a.length * b.length;
        if (product > 1e-16) p.smooth = Math.abs(a.cross(b)) / product < 1e-7 && a.dot(b) < 0;
      });
      if (component) c.component = component;
      contours.push(c);
    }
    walk(item); return contours;
  }
  function booleanOperands(contours) {
    const groups = new Map();
    for (const c of contours) { const key = c.component || c.id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); }
    return [...groups.values()];
  }
  function prepareGlifExport(doc) {
    const scope = getPaperScope(), closed = doc.contours.filter(c => c.closed), open = doc.contours.filter(c => !c.closed);
    if (!closed.length) return doc;
    let item = paperPath(closed[0], scope);
    try {
      // Fonts normally use nonzero winding, while the editor deliberately uses
      // even-odd. XOR all closed contours and orient the resulting boundaries.
      for (const contour of closed.slice(1)) {
        const nextPath = paperPath(contour, scope), result = item.exclude(nextPath, { insert: false });
        item.remove(); nextPath.remove(); item = result;
      }
      item.reorient(false, true);
      return { ...doc, contours: [...paperContours(item), ...open] };
    } finally { item.remove(); scope.project.clear(); }
  }
  function booleanOperation(doc, contourIds, operation, { tolerance = .25, baseId = null, library } = {}) {
    if (!['unite', 'intersect', 'subtract', 'exclude'].includes(operation)) throw new Error('不支持的布尔运算');
    const selected = doc.contours.filter(c => contourIds.has(c.id));
    if (selected.length < 2) throw new Error('请完整选择至少两条闭合轮廓');
    if (selected.some(c => !c.closed || c.segments.length < 2)) throw new Error('布尔运算仅支持闭合轮廓，请先闭合开放路径');
    const scope = getPaperScope(library), groups = booleanOperands(selected);
    if (groups.length < 2) throw new Error('至少需要两个独立构件；同一组合中的字腔不会当成单独实心形状，请先取消组合或再选一个构件');
    if (baseId) groups.sort((a, b) => Number(b.some(c => c.id === baseId)) - Number(a.some(c => c.id === baseId)));
    let result;
    try {
      for (const group of groups) {
        const converted = G.cubicDocument({ ...doc, contours: group }, tolerance);
        const paths = converted.doc.contours.map(c => paperPath(c, scope));
        const operand = paths.length === 1 ? paths[0] : new scope.CompoundPath({ children: paths, insert: false, fillRule: 'evenodd', fillColor: 'black' });
        if (!result) result = operand;
        else { const next = result[operation](operand, { insert: false }); result.remove(); operand.remove(); result = next; }
      }
      result.reorient?.(false, true);
      const groupId = 'boolean-' + G.uid();
      const contours = paperContours(result, { component: groupId }).filter(c => c.nodes.length >= 2 && c.segments.length >= 2);
      const output = G.clone(doc), first = doc.contours.findIndex(c => contourIds.has(c.id));
      output.contours = output.contours.filter(c => !contourIds.has(c.id));
      output.contours.splice(first, 0, ...contours);
      G.validateDocument(output);
      return { doc: output, contours, empty: !contours.length, tolerance };
    } finally { result?.remove(); scope.project.clear(); }
  }
  Object.assign(G, { getPaperScope, paperPath, paperContours, booleanOperands, booleanOperation, prepareGlifExport });
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof module !== 'undefined' && module.exports ? require('./glyph-io') : globalThis.HigherDegreeGeometry);
