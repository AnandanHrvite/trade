"use strict";

/**
 * Markdown -> HTML for the two documents this app renders in a browser tab:
 * README.md and CHANGELOG.md on /docs. Deliberately a small CommonMark subset
 * (no dependency is added for it) but a *block-level* one: fenced code, ATX
 * headings, pipe tables, nestable lists, blockquotes, thematic breaks and
 * paragraphs are each recognised BEFORE any inline rule runs.
 *
 * That ordering is the whole point. The renderer this replaces was a chain of
 * .replace() calls over the entire file, so the inline and paragraph rules also
 * ran inside fenced blocks: the README's ASCII architecture diagram came back
 * with <br> tags threaded through it, all 690 pipe-table rows rendered as bare
 * monospace lines, and every bullet was a <div>. Anything this parser does not
 * recognise degrades to a paragraph - it must never throw, because its input is
 * a file a human edits by hand.
 *
 * Escaping happens at emit time: every scrap of document text passes through
 * escapeHtml() before it reaches the output, so a literal <script> in the
 * markdown is text, not markup.
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ESC[c]);
}

/** Heading text with the inline markers stripped - for the TOC and for slugs. */
function plainText(s) {
  return String(s)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

function slugify(text, taken) {
  let base = plainText(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  if (!base) base = "section";
  let slug = base, n = 2;
  while (taken.has(slug)) slug = base + "-" + (n++);
  taken.add(slug);
  return slug;
}

// -- Inline --------------------------------------------------------------
// Code spans come out first as placeholders so that no later rule (emphasis,
// links, escaping) can reach inside them: `**not bold**` must stay literal.
// U+0000 cannot appear in text a browser will show, which is what makes it a
// safe placeholder delimiter.
const PH = String.fromCharCode(0);
const RE_PH = new RegExp(PH + "(\\d+)" + PH, "g");

function renderInline(raw) {
  const codes = [];
  let s = String(raw).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => {
    codes.push(code.replace(/^ (.*) $/, "$1"));
    return PH + (codes.length - 1) + PH;
  });

  s = escapeHtml(s);

  // ![alt](src) before [text](href) - otherwise the link rule eats the image.
  // Only an http(s) or same-origin path becomes a real <img>; anything else
  // (javascript:, data:, a scheme invented later) degrades to its alt text.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (m, alt, src) =>
    /^(https?:\/\/|\/|\.{0,2}\/|[\w.-]+\/)/i.test(src) && !/^\w+:/i.test(src.replace(/^https?:/i, ""))
      ? '<img class="md-img" src="' + src + '" alt="' + alt + '" loading="lazy">'
      : '<span class="md-ref">' + alt + "</span>");

  // [text](target). An http(s) target is a real link that opens in a new tab.
  // Everything else in these two files is a path INSIDE the repo
  // ([sharedNav.js](src/utils/sharedNav.js)) - the server does not serve source
  // files, so linking it would hand the reader a 404. It renders as a marked-up
  // path reference carrying the full path in its tooltip instead.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (m, text, target) => {
    if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target))
      return '<a class="md-link" href="' + target + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    if (target.charAt(0) === "#")
      return '<a class="md-link" href="' + target + '">' + text + "</a>";
    return '<span class="md-ref" title="' + target + '">' + text + "</span>";
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Single-asterisk emphasis only. Underscore emphasis is NOT supported on
  // purpose: this repo's prose is full of bare env keys such as
  // EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED, and _..._ would italicise their
  // middle and swallow the underscores.
  s = s.replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return s.replace(RE_PH, (m, i) => '<code class="md-code">' + escapeHtml(codes[Number(i)]) + "</code>");
}

// -- Block helpers -------------------------------------------------------
const RE_FENCE   = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR      = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_LI      = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_QUOTE   = /^\s{0,3}>\s?(.*)$/;

function isTableRow(line)  { return /^\s*\|.*\|\s*$/.test(line); }
function isTableRule(line) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf("-") !== -1; }

function splitCells(line) {
  let s = line.trim();
  if (s.charAt(0) === "|") s = s.slice(1);
  if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell) {
  const c = cell.trim();
  const l = c.charAt(0) === ":";
  const r = c.slice(-1) === ":";
  if (l && r) return "center";
  if (r) return "right";
  return "";
}

function startsBlock(line) {
  return line.trim() === "" || RE_FENCE.test(line) || RE_HEADING.test(line) ||
         RE_HR.test(line) || RE_LI.test(line) || RE_QUOTE.test(line) || isTableRow(line);
}

/** One list item's children are every following item indented deeper than it. */
function renderListItems(items) {
  const tag = items[0].ordered ? "ol" : "ul";
  const body = items.map(it => {
    const text = renderInline(it.lines.join(" "));
    const kids = it.children.length ? renderListItems(it.children) : "";
    return "<li>" + text + kids + "</li>";
  }).join("");
  return "<" + tag + ' class="md-list">' + body + "</" + tag + ">";
}

function renderListBlock(block) {
  const flat = [];
  let cur = null;
  for (const line of block) {
    const m = line.match(RE_LI);
    if (m) {
      cur = { indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), lines: [m[3]], children: [] };
      flat.push(cur);
    } else if (cur && line.trim()) {
      cur.lines.push(line.trim());   // lazy continuation of the item above
    }
  }
  if (!flat.length) return "";
  const roots = [], stack = [];
  for (const it of flat) {
    while (stack.length && it.indent <= stack[stack.length - 1].indent) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(it);
    else roots.push(it);
    stack.push(it);
  }
  return renderListItems(roots);
}

/**
 * @param {string} md               raw markdown
 * @param {object} [opts]
 * @param {number} [opts.tocMaxLevel=3]  deepest heading level to list in the TOC
 * @param {string} [opts.idPrefix='']    namespace for heading ids (both documents
 *                                       render into ONE page, so their slugs must
 *                                       not collide)
 * @returns {{html:string, toc:Array<{level:number,text:string,id:string}>}}
 */
function renderMarkdown(md, opts) {
  const o          = opts || {};
  const tocMax     = o.tocMaxLevel === undefined ? 3 : o.tocMaxLevel;
  const idPrefix   = o.idPrefix || "";
  const lines      = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out        = [];
  const toc        = [];
  const takenSlugs = new Set();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // Fenced code - copied out verbatim, never inline-rendered.
    const fence = line.match(RE_FENCE);
    if (fence) {
      const marker = fence[2].charAt(0);
      const lang   = fence[3] || "";
      const buf    = [];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(RE_FENCE);
        if (m && m[2].charAt(0) === marker && m[2].length >= fence[2].length && !m[3]) { i++; break; }
        buf.push(lines[i]);
        i++;
      }
      out.push('<pre class="md-pre"' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") +
               "><code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
      continue;
    }

    const heading = line.match(RE_HEADING);
    if (heading) {
      const level = heading[1].length;
      const text  = heading[2];
      const id    = idPrefix + slugify(text, takenSlugs);
      if (level >= 2 && level <= tocMax) toc.push({ level, text: plainText(text), id });
      out.push("<h" + level + ' class="md-h md-h' + level + '" id="' + id + '">' +
               renderInline(text) +
               '<a class="md-anchor" href="#' + id + '" aria-label="Link to this section">#</a>' +
               "</h" + level + ">");
      i++;
      continue;
    }

    if (RE_HR.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }

    // Pipe table - only when the row after the header is an alignment rule, so
    // a lone "| something |" line stays a paragraph.
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head  = splitCells(line);
      const align = splitCells(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) { body.push(splitCells(lines[i])); i++; }
      const th = head.map((c, n) => "<th" + (align[n] ? ' style="text-align:' + align[n] + '"' : "") +
                                    ">" + renderInline(c) + "</th>").join("");
      const tr = body.map(row =>
        "<tr>" + head.map((_, n) =>
          "<td" + (align[n] ? ' style="text-align:' + align[n] + '"' : "") + ">" +
          renderInline(row[n] === undefined ? "" : row[n]) + "</td>").join("") + "</tr>").join("");
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>' + th +
               "</tr></thead><tbody>" + tr + "</tbody></table></div>");
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (buf.length && lines[i].trim() && !startsBlock(lines[i])))) {
        const m = lines[i].match(RE_QUOTE);
        buf.push(m ? m[1] : lines[i].trim());
        i++;
      }
      out.push('<blockquote class="md-quote">' +
               renderMarkdown(buf.join("\n"), { tocMaxLevel: 0, idPrefix: idPrefix + "q-" }).html +
               "</blockquote>");
      continue;
    }

    if (RE_LI.test(line)) {
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (RE_LI.test(l)) { buf.push(l); i++; continue; }
        // An indented, non-blank line continues the item above it; a blank line
        // only continues the list when a further item follows it.
        if (l.trim() && /^\s{2,}/.test(l) && !RE_FENCE.test(l)) { buf.push(l); i++; continue; }
        if (l.trim() === "" && i + 1 < lines.length && RE_LI.test(lines[i + 1])) { i++; continue; }
        break;
      }
      out.push(renderListBlock(buf));
      continue;
    }

    // Paragraph - runs to the next blank line or block start.
    const para = [line];
    i++;
    while (i < lines.length && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p class="md-p">' + renderInline(para.join(" ")) + "</p>");
  }

  return { html: out.join("\n"), toc };
}

module.exports = { renderMarkdown, escapeHtml, plainText };
