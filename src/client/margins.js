// Where the page furniture lives: running heads, the bioRxiv license banner,
// footers. A selection that crosses a page break picks up whatever sits at the
// top of the next page, so the text we send to the translator has to drop it.
//
// Geometry does most of the work. Some PDFs put the whole banner in one text
// item and report the body font size for it, so a size test alone misses it;
// the thin hard band at the very top catches those. The wider small-type band
// catches running heads that sit a little lower.

export const TOP_BAND = 0.07; // fraction of page height, hard cut
export const TOP_SMALL_BAND = 0.16; // small type this close to the top is a head
export const BOTTOM_SMALL_BAND = 0.1; // small type this close to the bottom is a footer

/**
 * True when this piece is page furniture rather than the passage.
 * `top` is the distance from the page's top edge, `bottom` from its bottom edge,
 * `small` says the type is clearly smaller than the page's body text.
 */
export function isMarginFurniture({ first, last, small, top, bottom, height }) {
  if (!(height > 0)) return false;
  if (top < height * TOP_BAND) return first ? Boolean(small) : true;
  if (small && !first && top < height * TOP_SMALL_BAND) return true;
  if (small && !last && bottom < height * BOTTOM_SMALL_BAND) return true;
  return false;
}
