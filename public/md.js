/* Small, safe Markdown-to-HTML converter (headings, bold, italics, lists, tables, lines). */
(function (root) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  }
  function isTableLine(l) { return /^\s*\|.*\|\s*$/.test(l); }
  function isSepLine(l) { return /^[\s|:\-]+$/.test(l) && l.indexOf('-') !== -1 && l.indexOf('|') !== -1; }
  function isSpecial(l) {
    return /^\s*$/.test(l) || /^#{1,4}\s+/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l) ||
      /^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) || isTableLine(l);
  }
  function md(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n');
    var out = [], i = 0, m;
    while (i < lines.length) {
      var l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) {
        var n = m[1].length; out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); i++; continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (isTableLine(l) && i + 1 < lines.length && isSepLine(lines[i + 1])) {
        var rows = [];
        while (i < lines.length && isTableLine(lines[i])) { rows.push(lines[i]); i++; }
        var cells = function (r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(rows[0]);
        var body = rows.slice(2).map(cells);
        out.push('<div class="tablewrap"><table' + (head.length >= 6 ? ' class="wide xwide"' : head.length >= 4 ? ' class="wide"' : '') + '><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + body.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>');
        continue;
      }
      if (/^\s*[-*•]\s+/.test(l)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { ul.push('<li>' + inline(lines[i].replace(/^\s*[-*•]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + ul.join('') + '</ul>'); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        var ol = [], start = parseInt(/^\s*(\d+)/.exec(l)[1], 10);
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
        out.push('<ol' + (start > 1 ? ' start="' + start + '"' : '') + '>' + ol.join('') + '</ol>'); continue;
      }
      var para = [];
      while (i < lines.length && !isSpecial(lines[i])) { para.push(inline(lines[i])); i++; }
      if (!para.length) { para.push(inline(l)); i++; }
      out.push('<p>' + para.join('<br>') + '</p>');
    }
    return out.join('\n');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { md: md, esc: esc };
  else { root.md = md; }
})(typeof window !== 'undefined' ? window : this);
