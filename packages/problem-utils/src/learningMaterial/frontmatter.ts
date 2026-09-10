import { parse as parseYaml } from 'yaml';

// The judge front-matter parser (a port of jxson/front-matter) requires the document to start with
// `---` or `= yaml =` immediately followed by the line end (LF or CRLF, no trailing whitespace) and
// end the block with the same delimiter or a `...` line; the closer must be alone on its line
// (`(?!.)` below), or the judge treats the whole document as body with empty attributes.
const FRONTMATTER_REGEX = /^\uFEFF?(= yaml =|---)\r?\n([\s\S]*?)^(?:\1|\.\.\.)[ \t]*\r?(?:\n|(?!.))/m;
const FRONTMATTER_OPENER_REGEX = /^\uFEFF?(?:= yaml =|---)/;

/**
 * Splits a Markdown document into YAML frontmatter attributes and the remaining body.
 * Throws when the frontmatter block is present but contains invalid YAML.
 */
export function parseFrontmatter(text: string): { attributes: unknown; body: string } {
  const match = FRONTMATTER_REGEX.exec(text);
  if (!match || match.index !== 0) {
    // A document that starts with --- was clearly meant to carry frontmatter; failing here beats
    // letting the schema report "name is missing" for a file whose name: line is plainly visible.
    if (FRONTMATTER_OPENER_REGEX.test(text)) {
      throw new Error(
        'frontmatter block not recognized; the opening --- (or = yaml =) must be followed immediately by the line end (no trailing whitespace) and the closing delimiter must be alone on its line'
      );
    }
    return { attributes: {}, body: text };
  }
  return { attributes: parseYaml(match[2] ?? '') ?? {}, body: text.slice(match[0].length) };
}
