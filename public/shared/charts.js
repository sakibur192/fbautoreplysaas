/* ============================================================
   Tiny dependency-free chart kit shared by /admin and /superadmin.
   Inline SVG + a little CSS: hover tooltips, entrance animation,
   prefers-reduced-motion respected. Exposes window.BX.
   ============================================================ */
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;
  var PALETTE = ['#7c3aed', '#ec4899', '#06b6d4', '#16a34a', '#f59e0b', '#64748b'];

  var css = [
    '.bx-chart{position:relative;width:100%}',
    '.bx-chart svg{display:block;width:100%;height:auto;overflow:visible}',
    '.bx-grid{stroke:#e5e7eb;stroke-width:1;stroke-dasharray:3 4}',
    '.bx-axis{fill:#9ca3af;font:11px Inter,system-ui,sans-serif}',
    '.bx-tip{position:absolute;pointer-events:none;background:#111827;color:#fff;padding:6px 10px;border-radius:8px;font:12px Inter,system-ui,sans-serif;white-space:nowrap;opacity:0;transform:translate(-50%,-100%);transition:opacity .12s;z-index:5;box-shadow:0 8px 20px rgba(0,0,0,.25)}',
    '.bx-tip b{font-weight:700}',
    '.bx-tip small{display:block;opacity:.7;font-size:11px}',
    '.bx-bar{transform-box:fill-box;transform-origin:bottom;animation:bxGrow .6s cubic-bezier(.2,.8,.2,1) both}',
    '.bx-area-line{stroke-dasharray:1;stroke-dashoffset:1;animation:bxDraw 1s ease forwards}',
    '.bx-area-fill{animation:bxFade .9s ease both}',
    '.bx-donut-seg{transition:stroke-width .15s}',
    '.bx-donut-seg:hover{stroke-width:20}',
    '@keyframes bxGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}',
    '@keyframes bxDraw{to{stroke-dashoffset:0}}',
    '@keyframes bxFade{from{opacity:0}to{opacity:1}}',
    '.bx-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:12px;color:#6b7280}',
    '.bx-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:baseline}',
    '.bx-donut-wrap{display:flex;align-items:center;gap:18px;flex-wrap:wrap}',
    '.bx-donut-wrap .bx-chart{width:150px;flex-shrink:0}',
    '.bx-donut-wrap .bx-legend{flex-direction:column;margin:0}',
    '.bx-donut-wrap .bx-legend b{color:#111827}',
    '.bx-hbar{margin:9px 0}',
    '.bx-hbar .top{display:flex;justify-content:space-between;font-size:13px;gap:10px}',
    '.bx-hbar .top span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bx-hbar .top span:last-child{color:#6b7280;flex-shrink:0}',
    '.bx-hbar .track{height:8px;background:#f1f5f9;border-radius:99px;margin-top:5px;overflow:hidden}',
    '.bx-hbar .fill{height:100%;border-radius:99px;width:0;transition:width .8s cubic-bezier(.2,.8,.2,1)}',
    '.bx-empty{color:#9ca3af;font-size:13px;padding:26px 0;text-align:center}',
    '.bx-delta{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:99px;margin-left:6px;vertical-align:middle}',
    '.bx-delta.up{background:#dcfce7;color:#166534}.bx-delta.down{background:#fee2e2;color:#991b1b}.bx-delta.flat{background:#f1f5f9;color:#64748b}',
    '.bx-delta.new{background:#ede9fe;color:#5b21b6}',
    '.bx-range{display:inline-flex;background:#f1f5f9;border-radius:99px;padding:3px;gap:2px}',
    '.bx-range button{background:transparent!important;color:#64748b!important;box-shadow:none!important;transform:none!important;border-radius:99px;padding:5px 13px;font-size:12px;font-weight:600}',
    '.bx-range button.on{background:#fff!important;color:#5b21b6!important;box-shadow:0 1px 4px rgba(0,0,0,.12)!important}',
    '@media (prefers-reduced-motion: reduce){.bx-bar,.bx-area-line,.bx-area-fill{animation:none!important;stroke-dashoffset:0!important}.bx-hbar .fill{transition:none}}'
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 1 }); }
  function fmtMoney(n) { return '৳' + Math.round(Number(n || 0)).toLocaleString('en-US'); }
  function fmtUsd(n) { n = Number(n || 0); return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4)); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(key) { var p = String(key).split('-'); return parseInt(p[2], 10) + ' ' + MONTHS[parseInt(p[1], 10) - 1]; }

  // ▲ 12% vs the previous period. invert = true when "up" is bad (costs).
  function delta(cur, prev, invert) {
    cur = Number(cur || 0); prev = Number(prev || 0);
    if (!prev && !cur) return { text: '—', cls: 'flat' };
    if (!prev) return { text: 'New', cls: 'new' };
    var pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return { text: '0%', cls: 'flat' };
    var good = invert ? pct < 0 : pct > 0;
    return { text: (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%', cls: good ? 'up' : 'down' };
  }
  function deltaHtml(cur, prev, invert) { var d = delta(cur, prev, invert); return '<span class="bx-delta ' + d.cls + '" title="vs the previous period">' + d.text + '</span>'; }

  function niceMax(v) {
    if (v <= 0) return 4;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function tipFor(host) {
    var tip = document.createElement('div');
    tip.className = 'bx-tip';
    host.appendChild(tip);
    return tip;
  }
  function emptyState(el, msg) { el.innerHTML = '<div class="bx-empty">' + esc(msg || 'No data yet') + '</div>'; }

  var W = 640, H = 210, PL = 38, PR = 10, PT = 12, PB = 24;

  function frame(el, max, labels, ticksFmt) {
    el.innerHTML = '';
    el.classList.add('bx-chart');
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', preserveAspectRatio: 'xMidYMid meet' });
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var y = PT + ((H - PT - PB) * i) / steps;
      svg.appendChild(svgEl('line', { x1: PL, x2: W - PR, y1: y, y2: y, 'class': 'bx-grid' }));
      var t = svgEl('text', { x: PL - 6, y: y + 4, 'text-anchor': 'end', 'class': 'bx-axis' });
      t.textContent = (ticksFmt || fmtNum)(max - (max * i) / steps);
      svg.appendChild(t);
    }
    var n = labels.length;
    var idxs = n <= 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
    idxs.forEach(function (ix, k) {
      var x = PL + ((W - PL - PR) * (n === 1 ? 0.5 : ix / (n - 1)));
      var t = svgEl('text', { x: x, y: H - 6, 'text-anchor': k === 0 ? 'start' : k === idxs.length - 1 ? 'end' : 'middle', 'class': 'bx-axis' });
      t.textContent = dayLabel(labels[ix]);
      svg.appendChild(t);
    });
    el.appendChild(svg);
    return svg;
  }

  function hover(el, svg, count, xFor, build) {
    var tip = tipFor(el);
    var band = (W - PL - PR) / count;
    for (var i = 0; i < count; i++) {
      (function (i) {
        var r = svgEl('rect', { x: PL + band * i, y: PT, width: band, height: H - PT - PB, fill: 'transparent' });
        r.addEventListener('mouseenter', function () {
          var box = svg.getBoundingClientRect(), host = el.getBoundingClientRect();
          var scale = box.width / W;
          tip.innerHTML = build(i);
          tip.style.left = (box.left - host.left + xFor(i) * scale) + 'px';
          tip.style.top = (box.top - host.top + PT * scale) + 'px';
          tip.style.opacity = 1;
        });
        r.addEventListener('mouseleave', function () { tip.style.opacity = 0; });
        svg.appendChild(r);
      })(i);
    }
  }

  // Line + soft area. values/labels are parallel arrays (labels = YYYY-MM-DD).
  function area(el, labels, values, o) {
    o = o || {};
    if (!values || !values.length || !values.some(function (v) { return v > 0; })) return emptyState(el, o.empty || 'Nothing to show for this period yet');
    var max = niceMax(Math.max.apply(null, values));
    var svg = frame(el, max, labels, o.axisFmt);
    var color = o.color || PALETTE[0], id = 'bxg' + (++uid), n = values.length;
    var defs = svgEl('defs', {});
    var g = svgEl('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.32 }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defs.appendChild(g); svg.appendChild(defs);
    function xFor(i) { return PL + (W - PL - PR) * (n === 1 ? 0.5 : i / (n - 1)); }
    function yFor(v) { return PT + (H - PT - PB) * (1 - v / max); }
    var pts = values.map(function (v, i) { return [xFor(i), yFor(v)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    svg.appendChild(svgEl('path', { d: line + ' L' + pts[n - 1][0] + ' ' + (H - PB) + ' L' + pts[0][0] + ' ' + (H - PB) + ' Z', fill: 'url(#' + id + ')', 'class': 'bx-area-fill' }));
    svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', pathLength: 1, 'class': 'bx-area-line' }));
    var dot = svgEl('circle', { r: 4.5, fill: '#fff', stroke: color, 'stroke-width': 2.4, opacity: 0 });
    svg.appendChild(dot);
    hover(el, svg, n, xFor, function (i) {
      dot.setAttribute('cx', xFor(i)); dot.setAttribute('cy', yFor(values[i])); dot.setAttribute('opacity', 1);
      return '<b>' + (o.tipFmt || fmtNum)(values[i]) + '</b> ' + esc(o.unit || '') + '<small>' + dayLabel(labels[i]) + '</small>';
    });
    el.addEventListener('mouseleave', function () { dot.setAttribute('opacity', 0); });
    svg.setAttribute('aria-label', (o.title || 'Chart') + ', ' + n + ' days');
  }

  function bars(el, labels, values, o) {
    o = o || {};
    if (!values || !values.length || !values.some(function (v) { return v > 0; })) return emptyState(el, o.empty || 'Nothing to show for this period yet');
    var max = niceMax(Math.max.apply(null, values));
    var svg = frame(el, max, labels, o.axisFmt);
    var color = o.color || PALETTE[1], id = 'bxg' + (++uid), n = values.length;
    var defs = svgEl('defs', {});
    var g = svgEl('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': color }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.55 }));
    defs.appendChild(g); svg.appendChild(defs);
    var band = (W - PL - PR) / n, bw = Math.max(3, Math.min(28, band * 0.66));
    function xFor(i) { return PL + band * i + band / 2; }
    values.forEach(function (v, i) {
      var h = (H - PT - PB) * (v / max);
      if (v <= 0) return;
      svg.appendChild(svgEl('rect', { x: xFor(i) - bw / 2, y: H - PB - h, width: bw, height: h, rx: Math.min(4, bw / 2), fill: 'url(#' + id + ')', 'class': 'bx-bar', style: 'animation-delay:' + Math.min(i * 18, 400) + 'ms' }));
    });
    hover(el, svg, n, xFor, function (i) {
      return '<b>' + (o.tipFmt || fmtNum)(values[i]) + '</b> ' + esc(o.unit || '') + '<small>' + (o.hours ? esc(labels[i]) : dayLabel(labels[i])) + '</small>';
    });
    svg.setAttribute('aria-label', (o.title || 'Chart'));
  }

  // 24 hour-of-day bars: labels are plain strings, not dates.
  function hours(el, values, o) {
    o = o || {};
    var labels = values.map(function (_, h) { return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm'); });
    if (!values.some(function (v) { return v > 0; })) return emptyState(el, o.empty || 'No customer messages yet');
    var max = niceMax(Math.max.apply(null, values));
    el.innerHTML = ''; el.classList.add('bx-chart');
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    for (var i = 0; i <= 4; i++) {
      var y = PT + ((H - PT - PB) * i) / 4;
      svg.appendChild(svgEl('line', { x1: PL, x2: W - PR, y1: y, y2: y, 'class': 'bx-grid' }));
      var t = svgEl('text', { x: PL - 6, y: y + 4, 'text-anchor': 'end', 'class': 'bx-axis' }); t.textContent = fmtNum(max - (max * i) / 4); svg.appendChild(t);
    }
    [0, 6, 12, 18, 23].forEach(function (h) {
      var x = PL + ((W - PL - PR) / 24) * h + ((W - PL - PR) / 24) / 2;
      var t = svgEl('text', { x: x, y: H - 6, 'text-anchor': 'middle', 'class': 'bx-axis' }); t.textContent = labels[h]; svg.appendChild(t);
    });
    el.appendChild(svg);
    var band = (W - PL - PR) / 24, bw = band * 0.66, color = o.color || PALETTE[2], peak = values.indexOf(Math.max.apply(null, values));
    values.forEach(function (v, h) {
      if (v <= 0) return;
      var ht = (H - PT - PB) * (v / max);
      svg.appendChild(svgEl('rect', { x: PL + band * h + (band - bw) / 2, y: H - PB - ht, width: bw, height: ht, rx: 3, fill: h === peak ? PALETTE[0] : color, opacity: h === peak ? 1 : 0.65, 'class': 'bx-bar', style: 'animation-delay:' + h * 15 + 'ms' }));
    });
    hover(el, svg, 24, function (h) { return PL + band * h + band / 2; }, function (h) { return '<b>' + fmtNum(values[h]) + '</b> messages<small>' + labels[h] + '</small>'; });
  }

  function donut(el, parts, o) {
    o = o || {};
    var total = parts.reduce(function (s, p) { return s + (p.value || 0); }, 0);
    if (!total) return emptyState(el, o.empty || 'Nothing to show yet');
    var wrap = document.createElement('div'); wrap.className = 'bx-donut-wrap';
    var host = document.createElement('div'); host.className = 'bx-chart';
    var R = 52, C = 2 * Math.PI * R, off = 0;
    var svg = svgEl('svg', { viewBox: '0 0 140 140', role: 'img', 'aria-label': o.title || 'Breakdown' });
    svg.appendChild(svgEl('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: '#f1f5f9', 'stroke-width': 16 }));
    var tip = tipFor(host);
    parts.forEach(function (p, i) {
      if (!p.value) return;
      var len = (p.value / total) * C;
      var seg = svgEl('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: p.color || PALETTE[i % PALETTE.length], 'stroke-width': 16, 'stroke-dasharray': Math.max(0, len - 2) + ' ' + (C - Math.max(0, len - 2)), 'stroke-dashoffset': -off, transform: 'rotate(-90 70 70)', 'class': 'bx-donut-seg' });
      seg.addEventListener('mouseenter', function () { tip.innerHTML = '<b>' + fmtNum(p.value) + '</b> ' + esc(p.label) + '<small>' + Math.round((p.value / total) * 100) + '%</small>'; tip.style.left = '50%'; tip.style.top = '10px'; tip.style.opacity = 1; });
      seg.addEventListener('mouseleave', function () { tip.style.opacity = 0; });
      svg.appendChild(seg);
      off += len;
    });
    var c1 = svgEl('text', { x: 70, y: 70, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 800, fill: '#111827' }); c1.textContent = o.center !== undefined ? o.center : fmtNum(total); svg.appendChild(c1);
    var c2 = svgEl('text', { x: 70, y: 87, 'text-anchor': 'middle', 'font-size': 10, fill: '#9ca3af' }); c2.textContent = o.centerLabel || 'total'; svg.appendChild(c2);
    host.appendChild(svg);
    var legend = document.createElement('div'); legend.className = 'bx-legend';
    legend.innerHTML = parts.map(function (p, i) { return '<span><i style="background:' + (p.color || PALETTE[i % PALETTE.length]) + '"></i>' + esc(p.label) + ' <b>' + fmtNum(p.value) + '</b></span>'; }).join('');
    el.innerHTML = ''; wrap.appendChild(host); wrap.appendChild(legend); el.appendChild(wrap);
  }

  // Horizontal ranked bars (HTML, so long labels wrap/ellipsis nicely).
  function hbars(el, rows, o) {
    o = o || {};
    if (!rows || !rows.length) return emptyState(el, o.empty || 'Nothing to show yet');
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;
    el.innerHTML = rows.map(function (r, i) {
      return '<div class="bx-hbar"><div class="top"><span>' + esc(r.label) + '</span><span>' + esc(r.text !== undefined ? r.text : fmtNum(r.value)) + '</span></div>' +
        '<div class="track"><div class="fill" data-w="' + Math.max(3, Math.round((r.value / max) * 100)) + '" style="background:' + (r.color || PALETTE[i % PALETTE.length]) + '"></div></div></div>';
    }).join('');
    requestAnimationFrame(function () { el.querySelectorAll('.fill').forEach(function (f) { f.style.width = f.getAttribute('data-w') + '%'; }); });
  }

  window.BX = { PALETTE: PALETTE, esc: esc, fmtNum: fmtNum, fmtMoney: fmtMoney, fmtUsd: fmtUsd, dayLabel: dayLabel, delta: delta, deltaHtml: deltaHtml, area: area, bars: bars, hours: hours, donut: donut, hbars: hbars };
})();
