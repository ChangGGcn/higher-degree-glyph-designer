/* Folder workspace: independent glyph histories, lazy parsing, safe ZIP paths. */
(function (G) {
  'use strict';
  const normalizePath = path => {
    const normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').some(p => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(normalized) || /[\x00-\x1f]/.test(normalized)) throw new Error('文件相对路径无效');
    return normalized;
  };
  class GlyphProject {
    constructor(files, options = {}) {
      this.options = options; this.entries = []; this.byPath = new Map(); this.allFiles = new Map(); this.name = 'glyph-project'; this.activeId = null;
      for (const file of files) {
        const path = normalizePath(file.webkitRelativePath || file.relativePath || file.name);
        if (this.allFiles.has(path)) throw new Error('文件夹存在重复路径：' + path);
        this.allFiles.set(path, file);
      }
      const paths = [...this.allFiles.keys()];
      if (paths.length && paths[0].includes('/') && paths.every(p => p.split('/')[0] === paths[0].split('/')[0])) this.name = paths[0].split('/')[0];
      for (const [path, file] of this.allFiles) if (G.acceptedExtensions.includes(G.fileExtension(path))) {
        const entry = { id: path, path, file, text: null, doc: null, baseline: null, history: [], future: [], view: null, error: null, warnings: [], modified: false, exported: null, loading: null };
        this.entries.push(entry); this.byPath.set(path, entry);
      }
      this.entries.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
      this.metadata = new Map();
    }
    async readText(entry) {
      if (entry.text === null) {
        if (entry.file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB 上限');
        entry.text = await entry.file.text();
      }
      return entry.text;
    }
    async layerMetadata(path) {
      const directory = path.slice(0, path.lastIndexOf('/') + 1), parent = directory.replace(/[^/]+\/$/, ''), contentsPath = directory + 'contents.plist';
      if (this.metadata.has(directory)) return this.metadata.get(directory);
      const metadata = { names: new Map(), metrics: null };
      const getPairs = text => {
        const xml = G.parseXML(text.replace(/<!DOCTYPE[^>]*>/gi, ''), 'plist', this.options.Parser), dict = xml.documentElement.querySelector('dict');
        if (!dict) return [];
        const nodes = [...dict.children], pairs = [];
        for (let i = 0; i + 1 < nodes.length; i += 2) pairs.push([nodes[i].textContent, nodes[i + 1].textContent]);
        return pairs;
      };
      const contents = this.allFiles.get(contentsPath);
      if (contents && contents.size <= 5 * 1024 * 1024) {
        try { for (const [name, file] of getPairs(await contents.text())) { const resolved = directory + normalizePath(file); if (this.byPath.has(resolved)) metadata.names.set(name, resolved); } } catch (_) { /* Stem lookup remains available. */ }
      }
      const info = this.allFiles.get(parent + 'fontinfo.plist');
      if (info && info.size <= 5 * 1024 * 1024) {
        try {
          const pairs = new Map(getPairs(await info.text())), metrics = {};
          for (const [source, target] of [['unitsPerEm', 'upm'], ['ascender', 'ascender'], ['descender', 'descender'], ['capHeight', 'capHeight'], ['xHeight', 'xHeight']]) if (pairs.has(source) && Number.isFinite(Number(pairs.get(source)))) metrics[target] = Number(pairs.get(source));
          metadata.metrics = metrics;
        } catch (_) {}
      }
      this.metadata.set(directory, metadata); return metadata;
    }
    async load(id, chain = new Set()) {
      const entry = this.byPath.get(id); if (!entry) throw new Error('找不到字形文件');
      if (chain.has(id)) throw new Error('GLIF 构件存在循环引用：' + id);
      if (entry.doc) return entry;
      if (entry.error) throw new Error(entry.error);
      const branch = new Set(chain); branch.add(id);
      try {
        const text = await this.readText(entry), options = { ...this.options };
        if (G.fileExtension(entry.path) === 'glif') {
          const metadata = await this.layerMetadata(entry.path), references = G.glifReferences(text, this.options.Parser), bases = new Map();
          const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
          for (const name of references) {
            const path = metadata.names.get(name) || directory + name + '.glif';
            const base = await this.load(path, branch); bases.set(name, base.doc);
          }
          options.resolveComponent = name => bases.get(name); options.metrics = metadata.metrics;
        }
        const result = G.importText(text, entry.path, options); entry.doc = result.doc; entry.warnings = result.warnings; entry.baseline = G.serialize(result.doc); entry.error = null;
        return entry;
      } catch (error) { entry.error = error.message; throw error; }
    }
    capture(id, doc, history, future, view) {
      const entry = this.byPath.get(id); if (!entry || !entry.doc) return;
      entry.doc = G.clone(doc); entry.history = history; entry.future = future; entry.view = view && { ...view };
      entry.modified = G.serialize(doc) !== entry.baseline;
    }
    get changedCount() { return this.entries.filter(e => e.modified).length; }
    get pendingCount() { return this.entries.filter(e => e.modified && e.exported !== G.serialize(e.doc)).length; }
    async exportFiles({ mode = 'native', changedOnly = false, tolerance = .25, progress = () => {} } = {}) {
      const selected = this.entries.filter(e => !changedOnly || e.modified), files = new Map(), errors = [], exported = [];
      if (!selected.length) throw new Error(changedOnly ? '当前没有修改过的字形' : '文件夹内没有支持的字形');
      let totalBytes = 0;
      for (let i = 0; i < selected.length; i++) {
        const entry = selected[i]; progress(i + 1, selected.length);
        try {
          await this.load(entry.id);
          const native = mode === 'native', result = native ? { text: G.serialize(entry.doc) } : mode === 'cubic' ? G.cubicGlyphExport(entry.doc, tolerance) : G.glifExport(entry.doc, tolerance);
          const extension = mode === 'glif' ? '.glif' : '.glyph';
          let path = entry.path.replace(/\.[^/.]+$/, extension);
          // Preserve relative directories; distinguish foo.svg, foo.glif and foo.glyph.
          if (files.has(path.toLowerCase())) path = entry.path + extension;
          let suffix = 2, candidate = path;
          while (files.has(candidate.toLowerCase())) candidate = path.replace(/(\.[^.]+)$/, '-' + suffix++ + '$1');
          totalBytes += result.text.length * 3;
          if (totalBytes > 150 * 1024 * 1024) throw new Error('批量导出超过 150 MB，请缩小目录范围或只导出修改项');
          files.set(candidate.toLowerCase(), { path: normalizePath(candidate), text: result.text }); exported.push(entry);
        } catch (error) { errors.push({ path: entry.path, error: error.message }); }
        if (i % 12 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!files.size) throw new Error('没有可导出的字形：' + (errors[0]?.error || '请检查文件'));
      return { files: [...files.values()], errors, entries: exported };
    }
  }
  Object.assign(G, { GlyphProject, normalizeProjectPath: normalizePath });
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof module !== 'undefined' && module.exports ? require('./file-import') : globalThis.HigherDegreeGeometry);
