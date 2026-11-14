/* Local file adapters. XML is parsed inertly; SVG resources are restricted. */
(function (G) {
  'use strict';
  const acceptedExtensions = ['glyph', 'json', 'glif', 'svg'];
  const extension = name => String(name).split('.').at(-1).toLowerCase();
  function parseXML(text, root, Parser = globalThis.DOMParser) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持包含 DTD 或实体声明的 XML');
    if (!Parser) throw new Error('当前环境没有 XML 解析器');
    const xml = new Parser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length || xml.documentElement.localName !== root) throw new Error('文件不是有效的 ' + root.toUpperCase() + ' XML');
    return xml;
  }
  const children = (el, name) => [...el.children].filter(child => child.localName === name);
  function numberAttribute(el, name, fallback) {
    const raw = el.getAttribute(name); if (raw === null && fallback !== undefined) return fallback;
    if (raw === null || !raw.trim() || !Number.isFinite(Number(raw))) throw new Error('缺少或无效的数字属性：' + name);
    return Number(raw);
  }
  function glifImport(text, { filename = 'untitled.glif', metrics, resolveComponent, Parser } = {}) {
    const xml = parseXML(text, 'glyph', Parser), root = xml.documentElement;
    if (!['1', '2'].includes(root.getAttribute('format'))) throw new Error('仅支持 GLIF 1 / 2');
    const doc = G.emptyDocument(), warnings = [];
    Object.assign(doc.glyph, metrics || {});
    doc.glyph.name = root.getAttribute('name') || filename.replace(/\.[^.]+$/, '');
    const advance = children(root, 'advance')[0]; doc.glyph.advanceWidth = advance ? numberAttribute(advance, 'width', 0) : 0;
    const unicodes = children(root, 'unicode'); doc.glyph.unicode = unicodes[0]?.getAttribute('hex')?.toUpperCase().padStart(4, '0') || '';
    if (unicodes.length > 1) warnings.push('保留首个 Unicode 码位');
    const lib = children(root, 'lib')[0], dict = lib && children(lib, 'dict')[0];
    if (dict) {
      const elements = [...dict.children];
      const index = elements.findIndex(el => el.localName === 'key' && el.textContent === 'com.higher-degree-glyph-designer.metrics');
      if (index >= 0 && elements[index + 1]?.localName === 'dict') {
        const values = [...elements[index + 1].children];
        for (let i = 0; i + 1 < values.length; i += 2) if (['upm', 'ascender', 'descender', 'capHeight', 'xHeight'].includes(values[i].textContent)) doc.glyph[values[i].textContent] = Number(values[i + 1].textContent);
      }
    }
    const outline = children(root, 'outline')[0];
    if (outline) {
      for (const contour of children(outline, 'contour')) {
        let points = children(contour, 'point').map(el => ({ x: numberAttribute(el, 'x'), y: numberAttribute(el, 'y'), type: el.getAttribute('type') || 'offcurve', smooth: el.getAttribute('smooth') === 'yes' }));
        if (!points.length) continue;
        if (points.some(p => !['move', 'line', 'curve', 'qcurve', 'offcurve'].includes(p.type))) throw new Error('GLIF 节点类型不支持');
        let start = points.findIndex(p => p.type !== 'offcurve'), allOff = start < 0;
        if (allOff) {
          const first = G.mix(points.at(-1), points[0], .5); points = [{ ...first, type: 'qcurve', smooth: true }, ...points]; start = 0;
        }
        const open = points[start].type === 'move';
        if (open && (start !== 0 || points.slice(1).some(p => p.type === 'move'))) throw new Error('GLIF 开放轮廓的 move 点必须位于首位');
        points = [...points.slice(start), ...points.slice(0, start)];
        const c = G.newContour({ ...G.point(points[0].x, points[0].y), smooth: points[0].smooth }), off = [];
        const endIndex = open ? points.length : points.length + 1;
        for (let i = 1; i < endIndex; i++) {
          const p = points[i % points.length], closing = !open && i === points.length;
          if (p.type === 'offcurve') { off.push(p); continue; }
          if (p.type === 'move') throw new Error('轮廓内出现额外 move 点');
          if (p.type === 'line' && off.length) throw new Error('GLIF line 点前不能有控制点');
          if (p.type === 'curve' && off.length > 2) throw new Error('GLIF curve 段最多两个控制点');
          if (p.type === 'qcurve' && off.length > 1) {
            for (let j = 0; j < off.length - 1; j++) {
              const mid = G.mix(off[j], off[j + 1], .5);
              G.append(c, { ...G.point(mid.x, mid.y), smooth: true }, 'quadratic', [off[j]]);
            }
          }
          const controls = p.type === 'qcurve' && off.length ? [off.at(-1)] : off;
          if (closing && c.nodes.length === 1 && controls.length) {
            const [left, right] = G.subdivide([c.nodes[0], ...controls, c.nodes[0]], .5);
            G.append(c, { ...G.point(left.at(-1).x, left.at(-1).y), smooth: true }, G.typeForControls(controls.length), left.slice(1, -1));
            G.closeContour(c, G.typeForControls(controls.length), right.slice(1, -1));
          } else if (closing) G.closeContour(c, G.typeForControls(controls.length), controls);
          else G.append(c, { ...G.point(p.x, p.y), smooth: p.smooth }, G.typeForControls(controls.length), controls);
          off.length = 0;
        }
        if (off.length) throw new Error('GLIF 开放轮廓不能以控制点结尾');
        doc.contours.push(c);
      }
      for (const component of children(outline, 'component')) {
        const base = component.getAttribute('base');
        if (!base || !resolveComponent) throw new Error('此 GLIF 含引用构件；请导入包含基字形的文件夹');
        const baseDoc = resolveComponent(base);
        if (!baseDoc) throw new Error('找不到构件基字形：' + base);
        const contours = G.validateDocument(baseDoc).contours, a = numberAttribute(component, 'xScale', 1), b = numberAttribute(component, 'xyScale', 0), c = numberAttribute(component, 'yxScale', 0), d = numberAttribute(component, 'yScale', 1), e = numberAttribute(component, 'xOffset', 0), f = numberAttribute(component, 'yOffset', 0);
        const group = 'glif-component-' + G.uid();
        for (const contour of contours) { contour.component = group; G.allPoints({ contours: [contour] }).forEach(({ point: p }) => { const x = p.x, y = p.y; p.x = a * x + c * y + e; p.y = b * x + d * y + f; }); }
        doc.contours.push(...contours); warnings.push('引用构件已展开：' + base);
      }
    }
    if (['anchor', 'guideline', 'image'].some(name => children(root, name).length)) warnings.push('只导入轮廓与度量，未导入锚点 / 辅助线 / 图片');
    return { doc: G.validateDocument(doc), warnings, source: 'glif' };
  }
  function svgImport(text, { filename = 'untitled.svg', Parser, library } = {}) {
    const xml = parseXML(text, 'svg', Parser), root = xml.documentElement, warnings = [];
    const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc', 'metadata', 'style', 'defs']);
    for (const el of [...root.querySelectorAll('*')]) {
      if (el.closest('metadata')) continue;
      if (!allowed.has(el.localName)) throw new Error(`SVG 包含暂不支持的 ${el.localName}；请先转换为普通轮廓路径`);
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || /href$/i.test(attr.name) || /url\s*\(/i.test(attr.value)) throw new Error('SVG 不支持脚本、外部引用或 url() 资源');
      }
      if (el.localName === 'style' && /@import|url\s*\(|expression\s*\(|(?:clip-path|mask|filter)\s*:/i.test(el.textContent)) throw new Error('SVG 样式含外部资源、动态表达式或未展开的裁剪效果');
    }
    for (const attr of [...root.attributes]) if (/^on/i.test(attr.name) || /href$/i.test(attr.name) || /url\s*\(/i.test(attr.value)) throw new Error('SVG 根节点包含不支持的外部资源');
    if (root.querySelector('text,image,use,foreignObject,script')) throw new Error('SVG 请先展开文字、图片与引用');
    if ([root, ...root.querySelectorAll('*')].some(el => el.hasAttribute('clip-path') || el.hasAttribute('mask') || /clip-path|mask|filter/.test(el.getAttribute('style') || ''))) throw new Error('SVG 裁剪、蒙版或滤镜请先展开为路径');
    const scope = G.getPaperScope(library); let item;
    try {
      item = scope.project.importSVG(root, { insert: false, expandShapes: true, applyMatrix: true });
      if (!item) throw new Error('SVG 中没有可导入的路径');
      const paths = [], filled = [];
      function visit(node, inherited) {
        const matrix = inherited ? inherited.appended(node.matrix) : node.matrix.clone();
        if (node.visible === false || node.opacity === 0 || node.clipMask) return;
        if (node.children && node.className !== 'CompoundPath') { node.children.forEach(child => visit(child, matrix)); return; }
        if (!['Path', 'CompoundPath'].includes(node.className)) return;
        const p = node.clone({ insert: false }); p.matrix.reset(); p.transform(matrix); p.applyMatrix = true;
        if (node.fillColor && node.fillColor.alpha > 0) {
          if (p.children) p.children.forEach(c => { c.closed = true; }); else p.closed = true;
          filled.push(p);
        } else if (node.strokeColor && node.strokeColor.alpha > 0) { warnings.push('描边按开放中心线导入，未扩展描边宽度'); paths.push(p); }
        else p.remove();
      }
      visit(item, null);
      let merged = null;
      for (const p of filled) { if (!merged) merged = p; else { const next = merged.unite(p, { insert: false }); merged.remove(); p.remove(); merged = next; } }
      if (merged) { const normalized = merged.resolveCrossings(); if (normalized !== merged) merged.remove(); merged = normalized; merged.reorient(merged.fillRule !== 'evenodd', true); }
      const contours = merged ? G.paperContours(merged, { flipY: true }) : []; merged?.remove();
      for (const p of paths) {
        for (const c of G.paperContours(p, { flipY: true })) {
          if (c.closed) { c.nodes.push({ ...c.nodes[0], id: G.uid() }); c.closed = false; }
          contours.push(c);
        }
        p.remove();
      }
      if (!contours.length) throw new Error('SVG 中没有可编辑的矢量路径');
      const doc = G.emptyDocument(); doc.contours = contours; doc.glyph.name = filename.split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '') || 'svg';
      const b = G.bounds(doc), height = Math.max(1, b.maxY - b.minY), targetHeight = doc.glyph.capHeight;
      // Convert arbitrary SVG pixels to a useful font grid without distorting aspect ratio.
      const scale = targetHeight / height;
      G.allPoints(doc).forEach(({ point: p }) => { p.x = (p.x - b.minX) * scale + 50; p.y = (p.y - b.minY) * scale; });
      doc.glyph.advanceWidth = Math.max(1, (b.maxX - b.minX) * scale + 100);
      warnings.push('SVG 按比例适配至 700 单位高度、50 单位左边距；颜色合并为单色轮廓');
      return { doc: G.validateDocument(doc), warnings: [...new Set(warnings)], source: 'svg' };
    } finally { item?.remove(); scope.project.clear(); }
  }
  function importText(text, filename, options = {}) {
    const ext = extension(filename);
    if (ext === 'glif') return glifImport(text, { ...options, filename });
    if (ext === 'svg') return svgImport(text, { ...options, filename });
    if (ext === 'glyph' || ext === 'json') {
      let raw; try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (_) { throw new Error('需要本工具 JSON .glyph；Glyphs 的 OpenStep .glyph 暂不支持'); }
      return { doc: G.validateDocument(raw), warnings: [], source: 'native' };
    }
    throw new Error('支持 .glyph、.glif、.svg 和本工具 JSON 文件');
  }
  function glifReferences(text, Parser) {
    const xml = parseXML(text, 'glyph', Parser); return [...xml.querySelectorAll('outline > component')].map(el => el.getAttribute('base')).filter(Boolean);
  }
  Object.assign(G, { acceptedExtensions, fileExtension: extension, parseXML, importText, glifImport, glifReferences, svgImport });
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof module !== 'undefined' && module.exports ? require('./path-boolean') : globalThis.HigherDegreeGeometry);
