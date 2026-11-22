const COLLECT_SOURCE = String.raw`
function (opts) {
  var MAX = opts.maxNodes;
  var TEST_ID_ATTRS = opts.testIdAttrs;
  var doc = document;
  var de = doc.documentElement;
  var colors = new Map();
  var ctx = null;

  function parseRgb(text) {
    var m = /^rgba?\(([^)]+)\)$/.exec(text);
    if (m) {
      var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3 && p.every(function (n) { return !isNaN(n); })) return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(text);
    if (m) {
      var q = m[1].split(/[ \/]+/).filter(Boolean).map(parseFloat);
      if (q.length >= 3 && q.every(function (n) { return !isNaN(n); })) return { r: q[0] * 255, g: q[1] * 255, b: q[2] * 255, a: q.length > 3 ? q[3] : 1 };
    }
    return null;
  }

  function toRgba(text) {
    if (!text) return null;
    if (colors.has(text)) return colors.get(text);
    var out = parseRgb(text);
    if (!out) {
      try {
        if (!ctx) { var c = doc.createElement('canvas'); c.width = 1; c.height = 1; ctx = c.getContext('2d', { willReadFrequently: true }); }
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = text;
        ctx.fillRect(0, 0, 1, 1);
        var d = ctx.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      } catch (e) { out = null; }
    }
    colors.set(text, out);
    return out;
  }

  function box(r) { return { x: r.left, y: r.top, width: r.width, height: r.height }; }

  var INTERACTIVE_ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, slider: 1, spinbutton: 1, textbox: 1, combobox: 1, searchbox: 1, treeitem: 1 };
  var LAYER_ROLES = { dialog: 1, alertdialog: 1, tooltip: 1, menu: 1, listbox: 1 };
  var SKIP_TAGS = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1, title: 1, br: 1, wbr: 1, area: 1, base: 1, col: 1, colgroup: 1, datalist: 1, param: 1, source: 1, track: 1 };
  var REPLACED_TAGS = { img: 1, video: 1, canvas: 1, svg: 1, iframe: 1, object: 1, embed: 1, picture: 1 };
  var IMPLICIT_ROLES = { button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', li: 'listitem', label: 'label', th: 'columnheader', td: 'cell', dialog: 'dialog', nav: 'navigation', p: 'paragraph' };
  var INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', search: 'searchbox', number: 'spinbutton' };

  function isInteractive(el) {
    var tag = el.localName;
    if (tag === 'a') return el.hasAttribute('href');
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'input') return el.type !== 'hidden';
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES[role]) return true;
    return el.hasAttribute('onclick');
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.localName === 'input') return INPUT_ROLES[el.type] || 'textbox';
    return IMPLICIT_ROLES[el.localName];
  }

  function trim(s, n) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function nameOf(el) {
    var label = el.getAttribute('aria-label');
    if (label) return trim(label, 60);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(' ').map(function (id) { var t = doc.getElementById(id); return t ? t.textContent : ''; });
      var joined = trim(parts.join(' '), 60);
      if (joined) return joined;
    }
    if (el.labels && el.labels.length) return trim(el.labels[0].textContent, 60);
    var alt = el.getAttribute('alt');
    if (alt) return trim(alt, 60);
    var title = el.getAttribute('title');
    if (title) return trim(title, 60);
    if (el.localName === 'input' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) return trim(el.value, 60);
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return trim(placeholder, 60);
    return trim(el.textContent, 60);
  }

  function pathOf(el) {
    if (el.id && doc.getElementById(el.id) === el) return '#' + CSS.escape(el.id);
    var parts = [];
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && cur !== de && depth < 5; depth++) {
      var tid = null;
      for (var k = 0; k < TEST_ID_ATTRS.length; k++) { var v = cur.getAttribute(TEST_ID_ATTRS[k]); if (v) { tid = '[' + TEST_ID_ATTRS[k] + '="' + v + '"]'; break; } }
      if (tid) { parts.unshift(tid); break; }
      if (cur.id && doc.getElementById(cur.id) === cur) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var part = cur.localName;
      var parent = cur.parentElement;
      if (parent) {
        var same = 0, index = 0;
        for (var s = parent.firstElementChild; s; s = s.nextElementSibling) {
          if (s.localName === cur.localName) { same++; if (s === cur) index = same; }
        }
        if (same > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function describe(el, text) {
    var out = { selector: pathOf(el) };
    for (var k = 0; k < TEST_ID_ATTRS.length; k++) { var v = el.getAttribute(TEST_ID_ATTRS[k]); if (v) { out.testid = v; break; } }
    var role = roleOf(el);
    if (role) out.role = role;
    var name = nameOf(el);
    if (name) out.name = name;
    if (text) out.text = text;
    return out;
  }

  function formsStackingContext(cs, parentCs) {
    var pos = cs.position;
    if (pos === 'fixed' || pos === 'sticky') return true;
    if (cs.zIndex !== 'auto' && (pos !== 'static' || (parentCs && (parentCs.display.indexOf('flex') >= 0 || parentCs.display.indexOf('grid') >= 0)))) return true;
    if (parseFloat(cs.opacity) < 1) return true;
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || cs.clipPath !== 'none') return true;
    if (cs.maskImage && cs.maskImage !== 'none') return true;
    if (cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal') return true;
    if (/transform|opacity|filter|perspective|clip-path|mask/.test(cs.willChange)) return true;
    if (/layout|paint|strict|content/.test(cs.contain)) return true;
    return false;
  }

  var nodes = [];
  var truncated = false;
  var rootEl = null;
  if (opts.root) {
    for (var ri = 0; ri < TEST_ID_ATTRS.length && !rootEl; ri++) {
      rootEl = doc.querySelector('[' + TEST_ID_ATTRS[ri] + '="' + String(opts.root).replace(/"/g, '\\"') + '"]');
    }
    if (!rootEl) {
      try { rootEl = doc.querySelector(opts.root); } catch (e) { return { error: 'Invalid --root selector: ' + opts.root }; }
    }
    if (!rootEl) return { error: 'No element found for --root ' + opts.root };
  }

  function flatChildren(el) {
    if (el.shadowRoot) return Array.prototype.slice.call(el.shadowRoot.children);
    if (el.localName === 'slot') {
      var assigned = el.assignedElements({ flatten: true });
      return assigned.length ? assigned : Array.prototype.slice.call(el.children);
    }
    return Array.prototype.slice.call(el.children);
  }

  function ownTextRect(el) {
    var rect = null;
    var any = false;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !n.data.trim()) continue;
      any = true;
      var range = doc.createRange();
      range.selectNodeContents(n);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width <= 0 || r.height <= 0) continue;
        if (!rect) rect = { l: r.left, t: r.top, r: r.right, b: r.bottom };
        else { rect.l = Math.min(rect.l, r.left); rect.t = Math.min(rect.t, r.top); rect.r = Math.max(rect.r, r.right); rect.b = Math.max(rect.b, r.bottom); }
      }
    }
    return { any: any, rect: rect ? { x: rect.l, y: rect.t, width: rect.r - rect.l, height: rect.b - rect.t } : null };
  }

  function ownText(el) {
    var s = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.data;
    return trim(s, 60);
  }

  function visit(el, parentIndex, parentCs, inRoot) {
    if (nodes.length >= MAX) { truncated = true; return; }
    if (SKIP_TAGS[el.localName]) return;
    var cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    if (cs.display !== 'contents' && typeof el.checkVisibility === 'function' && !el.checkVisibility()) return;
    var here = inRoot || el === rootEl;
    if (cs.display === 'contents') {
      var kids = flatChildren(el);
      for (var c = 0; c < kids.length; c++) visit(kids[c], parentIndex, cs, here);
      return;
    }
    var tag = el.localName;
    var isRoot = el === de || el === doc.body;
    var r = el.getBoundingClientRect();
    var text = ownTextRect(el);
    var interactive = isInteractive(el);
    var replaced = !!REPLACED_TAGS[tag] || tag === 'input' || tag === 'select' || tag === 'textarea';
    var ox = isRoot ? 'visible' : cs.overflowX;
    var oy = isRoot ? 'visible' : cs.overflowY;
    var clips = ox !== 'visible' || oy !== 'visible';
    var layerRole = LAYER_ROLES[el.getAttribute('role')] === 1;
    var dialogLike = tag === 'dialog' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
    var hasContent = text.any || interactive || replaced;
    var scrollInfo = null;
    if (text.any && el.clientWidth > 0 && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      scrollInfo = { width: el.scrollWidth, clientWidth: el.clientWidth, height: el.scrollHeight, clientHeight: el.clientHeight };
    }
    var labelRect = null;
    if (tag === 'input' && el.labels && el.labels.length) {
      var lr = el.labels[0].getBoundingClientRect();
      if (lr.width > 0 && lr.height > 0) labelRect = box(lr);
    }
    var fill = cs.webkitTextFillColor || cs.color;
    var node = {
      parent: parentIndex,
      tag: tag,
      rect: box(r),
      textRect: text.rect,
      ownText: text.any,
      interactive: interactive,
      replaced: replaced,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      visible: cs.visibility === 'visible',
      opacity: parseFloat(cs.opacity),
      position: cs.position,
      overflowX: ox,
      overflowY: oy,
      clipBox: clips ? { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight } : null,
      ellipsis: cs.textOverflow.indexOf('ellipsis') >= 0,
      lineClamp: cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '',
      scroll: scrollInfo,
      stacking: tag === 'html' || formsStackingContext(cs, parentCs),
      containingBlock: cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none',
      transformed: cs.transform !== 'none',
      layer: cs.position === 'fixed' || cs.position === 'sticky' || layerRole || dialogLike || el.hasAttribute('popover') || (cs.position !== 'static' && parseInt(cs.zIndex, 10) > 0),
      dialog: dialogLike,
      fixed: cs.position === 'fixed' || cs.position === 'sticky',
      inline: cs.display === 'inline',
      pointerEvents: cs.pointerEvents !== 'none',
      labelRect: labelRect,
      color: toRgba(fill),
      background: toRgba(cs.backgroundColor),
      backgroundImage: cs.backgroundImage !== 'none',
      backgroundClipText: cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text',
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      inRoot: here || !rootEl,
      target: hasContent && (here || !rootEl) ? describe(el, ownText(el)) : null
    };
    var index = nodes.length;
    nodes.push(node);
    if (tag === 'svg') return;
    var children = flatChildren(el);
    for (var i = 0; i < children.length; i++) visit(children[i], index, cs, here);
  }

  visit(de, -1, null, false);

  var rootCs = getComputedStyle(de);
  var scheme = rootCs.colorScheme || '';
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var darkCanvas = scheme.indexOf('dark') >= 0 && (scheme.indexOf('light') < 0 || prefersDark);
  return {
    viewport: { width: de.clientWidth, height: de.clientHeight },
    coarse: window.matchMedia('(pointer: coarse)').matches,
    canvas: darkCanvas ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 },
    nodes: nodes,
    truncated: truncated
  };
}
`

export const MAX_AUDIT_NODES = 6000

export type CollectOptions = { root?: string; testIdAttrs: readonly string[] }

export const collectScript = (options: CollectOptions): string =>
  `(${COLLECT_SOURCE})(${JSON.stringify({ root: options.root ?? null, testIdAttrs: options.testIdAttrs, maxNodes: MAX_AUDIT_NODES })})`
