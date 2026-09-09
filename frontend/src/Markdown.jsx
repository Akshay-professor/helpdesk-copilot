/**
 * Markdown
 *
 * The model writes markdown - **bold**, tables, bullet lists - and we were
 * printing it raw, so customers saw:
 *
 *   | Order ID | Description | Total |
 *   |----------|-------------|-------|
 *   | **ord_1001** | Pro Plan | $240 |
 *
 * Hand-written rather than a library, for two reasons:
 *
 *   1. It builds React ELEMENTS, never HTML strings. There is no
 *      dangerouslySetInnerHTML anywhere here, so model output - which is
 *      partly attacker-influenced whenever a customer's own words reach it -
 *      cannot inject markup. A markdown library that renders to HTML would
 *      need sanitising on top; this needs none by construction.
 *
 *   2. The subset the model actually produces is small. Tables, bullets,
 *      numbered lists, bold, and inline code cover essentially everything.
 *      Sixty lines beats a dependency and a sanitiser.
 */

/** Inline: **bold**, *italic*, `code`. Returns an array of React children. */
function inline(text, keyPrefix = "i") {
  const parts = [];
  // One pass, one regex, alternatives ordered so ** wins over *.
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  let n = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;

    if (tok.startsWith("**")) parts.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) parts.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else parts.push(<em key={key}>{tok.slice(1, -1)}</em>);

    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const isTableRow = (l) => l.trim().startsWith("|") && l.trim().endsWith("|");
const isDivider = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
const cells = (l) =>
  l.trim().slice(1, -1).split("|").map((c) => c.trim());

export default function Markdown({ text }) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- TABLE ---------------------------------------------------------
    // A table is the one thing that is genuinely unreadable unrendered, and
    // the model reaches for it constantly (orders, invoices, refunds).
    if (isTableRow(line) && isDivider(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        <div className="md-table-wrap" key={`t-${i}`}>
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, x) => (
                  <th key={x}>{inline(h, `th-${x}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y}>
                  {r.map((c, x) => (
                    <td key={x}>{inline(c, `td-${y}-${x}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // ---- BULLET LIST ---------------------------------------------------
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={`u-${i}`}>
          {items.map((it, x) => (
            <li key={x}>{inline(it, `li-${x}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // ---- NUMBERED LIST -------------------------------------------------
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      out.push(
        <ol key={`o-${i}`}>
          {items.map((it, x) => (
            <li key={x}>{inline(it, `oi-${x}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // ---- HEADING -------------------------------------------------------
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(
        <div className={`md-h md-h${h[1].length}`} key={`h-${i}`}>
          {inline(h[2], `hh-${i}`)}
        </div>
      );
      i++;
      continue;
    }

    // ---- BLANK ---------------------------------------------------------
    if (line.trim() === "") {
      out.push(<div className="md-gap" key={`g-${i}`} />);
      i++;
      continue;
    }

    // ---- PARAGRAPH -----------------------------------------------------
    out.push(<p key={`p-${i}`}>{inline(line, `pp-${i}`)}</p>);
    i++;
  }

  return <div className="md">{out}</div>;
}
