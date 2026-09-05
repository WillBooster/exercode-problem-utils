import { parse as parseYaml } from 'yaml';

// The judge front-matter parser (a port of jxson/front-matter) requires the document to start with
// `---` immediately followed by the line end (no trailing whitespace) and end the block with a
// `---` or `...` line; the closer must be alone on its line (`(?!.)` below), or the judge treats
// the whole document as body with empty attributes. The judge's alternative `= yaml =` delimiter
// is intentionally unsupported here because no generator emits it.
const FRONTMATTER_REGEX = /^\uFEFF?---\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*\r?(?:\n|(?!.))/m;

/**
 * Splits a Markdown document into YAML frontmatter attributes and the remaining body.
 * Throws when the frontmatter block is present but contains invalid YAML.
 */
export function parseFrontmatter(text: string): { attributes: unknown; body: string } {
  const match = FRONTMATTER_REGEX.exec(text);
  if (!match || match.index !== 0) {
    // A document that starts with --- was clearly meant to carry frontmatter; failing here beats
    // letting the schema report "name is missing" for a file whose name: line is plainly visible.
    if (/^﻿?---/.test(text)) {
      throw new Error(
        'frontmatter block not recognized; the opening --- must be followed immediately by LF (no trailing whitespace or CRLF) and the closing --- must be alone on its line'
      );
    }
    return { attributes: {}, body: text };
  }
  return { attributes: parseYaml(match[1] ?? '') ?? {}, body: text.slice(match[0].length) };
}
