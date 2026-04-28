/**
 * Lightweight Markdown renderer for chat bubbles.
 *
 * Converts a subset of Markdown to HTML without external dependencies.
 * Supports: fenced code blocks, inline code, bold, italic, headers,
 * links, unordered/ordered lists, and line breaks.
 *
 * Security: output is sanitized (no raw HTML passthrough).
 */

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      const langAttr = lang ? ` class="language-${esc(lang)}"` : "";
      out.push(
        `<pre class="md-pre"><code${langAttr}>${esc(codeLines.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      out.push(`<h${level + 2} class="md-heading">${inlineFormat(headingMatch[2]!)}</h${level + 2}>`);
      i++;
      continue;
    }

    // Unordered list
    if (/^[\-\*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\-\*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[\-\*]\s+/, ""));
        i++;
      }
      out.push(
        `<ul class="md-list">${items.map((it) => `<li>${inlineFormat(it)}</li>`).join("")}</ul>`,
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(
        `<ol class="md-list">${items.map((it) => `<li>${inlineFormat(it)}</li>`).join("")}</ol>`,
      );
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === "") {
      out.push("<br/>");
      i++;
      continue;
    }

    // Normal paragraph
    out.push(`<p class="md-p">${inlineFormat(line)}</p>`);
    i++;
  }

  return out.join("");
}

function inlineFormat(text: string): string {
  let s = esc(text);
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // Italic
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(/_(.+?)_/g, "<em>$1</em>");
  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  // Links
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  return s;
}

export function Markdown({ text }: { text: string }) {
  if (!text) return null;
  const html = renderMarkdown(text);
  return (
    <div
      class="md-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
