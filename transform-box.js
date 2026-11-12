/* Shared, testable affine transforms for the nine-point inspector and canvas grips. */
(function (G) {
  'use strict';
  const anchorPositions = { nw: [0, 1], n: [.5, 1], ne: [1, 1], w: [0, .5], center: [.5, .5], e: [1, .5], sw: [0, 0], s: [.5, 0], se: [1, 0] };
  function frameReference(bounds, anchor = 'center') {
    const [u, v] = anchorPositions[anchor] || anchorPositions.center;
    return { x: bounds.minX + (bounds.maxX - bounds.minX) * u, y: bounds.minY + (bounds.maxY - bounds.minY) * v };
  }
  function affineMatrix({ scaleX = 1, scaleY = 1, angle = 0, shearX = 0, shearY = 0, dx = 0, dy = 0 } = {}, origin = { x: 0, y: 0 }) {
    const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const a = (cos - sin * shearY) * scaleX, b = (sin + cos * shearY) * scaleX;
    const c = (cos * shearX - sin) * scaleY, d = (sin * shearX + cos) * scaleY;
    return { a, b, c, d, e: origin.x - a * origin.x - c * origin.y + dx, f: origin.y - b * origin.x - d * origin.y + dy };
  }
  function affinePoint(point, matrix) { return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f }; }
  function applyAffine(points, matrix, originals = points) {
    points.forEach((p, i) => { const result = affinePoint(originals[i], matrix); p.x = result.x; p.y = result.y; });
  }
  function frameTransform(bounds, origin, mode, handle, start, target, { uniform = false, snapAngle = false } = {}) {
    if (mode === 'scale') {
      const source = frameReference(bounds, handle), x = source.x - origin.x, y = source.y - origin.y;
      let sx = handle.includes('w') || handle.includes('e') ? Math.abs(x) > 1e-10 ? (target.x - origin.x) / x : 1 : 1;
      let sy = handle.includes('n') || handle.includes('s') ? Math.abs(y) > 1e-10 ? (target.y - origin.y) / y : 1 : 1;
      if (uniform) { const ratio = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy; sx = sy = ratio; }
      return { matrix: affineMatrix({ scaleX: sx, scaleY: sy }, origin), scaleX: sx, scaleY: sy };
    }
    if (handle.length === 2) {
      let angle = (Math.atan2(target.y - origin.y, target.x - origin.x) - Math.atan2(start.y - origin.y, start.x - origin.x)) * 180 / Math.PI;
      angle = ((angle + 540) % 360) - 180; if (snapAngle) angle = Math.round(angle / 15) * 15;
      return { matrix: affineMatrix({ angle }, origin), angle };
    }
    const horizontal = handle === 'n' || handle === 's';
    const denominator = horizontal ? start.y - origin.y : start.x - origin.x;
    const shear = Math.abs(denominator) > 1e-10 ? (horizontal ? target.x - start.x : target.y - start.y) / denominator : 0;
    return { matrix: affineMatrix(horizontal ? { shearX: shear } : { shearY: shear }, origin), shear, horizontal };
  }
  function smoothNeighborhood(doc, id) {
    const entry = G.allPoints(doc).find(e => e.point.id === id); if (!entry) return null;
    const c = entry.contour, n = c.nodes.length;
    const indices = entry.kind === 'node' ? [entry.index] : [entry.control === 0 ? entry.index : -1, entry.control === c.segments[entry.index].controls.length - 1 ? (entry.index + 1) % n : -1].filter(i => i >= 0);
    const candidates = [];
    for (const i of indices) {
      const node = c.nodes[i], incoming = (i > 0 || c.closed) ? c.segments[(i - 1 + n) % n]?.controls.at(-1) : null, outgoing = c.segments[i]?.controls[0];
      if (node.smooth && incoming && outgoing) candidates.push({ node, incoming, outgoing, entry });
    }
    return candidates.sort((a, b) => G.distance(a.node, entry.point) - G.distance(b.node, entry.point))[0] || null;
  }
  function constrainMove(doc, baseline, selectedIds, primaryId, delta, { alt = false, ctrl = false, shift = false } = {}) {
    const originals = new Map(G.allPoints(baseline).map(e => [e.point.id, e.point]));
    const points = new Map(G.allPoints(doc).map(e => [e.point.id, e.point]));
    const primary = originals.get(primaryId), neighborhood = smoothNeighborhood(baseline, primaryId);
    const conjugate = !!(((ctrl && alt) || shift) && selectedIds.size === 1 && neighborhood?.entry.kind === 'control');
    let movement = { ...delta }, guide = null;
    const snap45 = vector => { const angle = Math.round(Math.atan2(vector.y, vector.x) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(vector.x, vector.y); return { x: Math.cos(angle) * length, y: Math.sin(angle) * length }; };
    if (primary && conjugate) {
      const node = neighborhood.node, direction = snap45({ x: primary.x + delta.x - node.x, y: primary.y + delta.y - node.y });
      movement = { x: node.x + direction.x - primary.x, y: node.y + direction.y - primary.y }; guide = { origin: node, direction };
    } else if (ctrl) {
      movement = snap45(delta); if (primary) guide = { origin: primary, direction: movement };
    } else if (alt && neighborhood) {
      const { incoming, outgoing, node } = neighborhood;
      const direction = { x: outgoing.x - incoming.x, y: outgoing.y - incoming.y }, length2 = direction.x ** 2 + direction.y ** 2;
      if (length2 > 1e-14) { const ratio = (delta.x * direction.x + delta.y * direction.y) / length2; movement = { x: direction.x * ratio, y: direction.y * ratio }; guide = { origin: node, direction }; }
    } else if (shift) {
      movement = Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
    }
    // Restore the baseline on each frame so releasing Ctrl/Alt removes temporary linkage.
    for (const [id, p] of points) { const old = originals.get(id); if (old) { p.x = old.x; p.y = old.y; } }
    for (const id of selectedIds) { const p = points.get(id), old = originals.get(id); if (p && old) { p.x = old.x + movement.x; p.y = old.y + movement.y; } }
    if (conjugate) {
      const { node, incoming, outgoing, entry } = neighborhood, currentNode = points.get(node.id);
      const opposite = incoming.id === primaryId ? outgoing : incoming, moved = points.get(primaryId), length = G.distance(opposite, node), direction = G.distance(moved, currentNode);
      if (direction > 1e-10) { const p = points.get(opposite.id); p.x = currentNode.x - (moved.x - currentNode.x) * length / direction; p.y = currentNode.y - (moved.y - currentNode.y) * length / direction; }
    }
    return { delta: movement, guide, mode: conjugate ? 'conjugate' : ctrl ? 'direction' : alt && neighborhood ? 'tangent' : null };
  }
  Object.assign(G, { anchorPositions, frameReference, affineMatrix, affinePoint, applyAffine, frameTransform, smoothNeighborhood, constrainMove });
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof module !== 'undefined' && module.exports ? require('./operations') : globalThis.HigherDegreeGeometry);
