/**
 * Parse Adyen's "Test card numbers" Markdown page into a machine-readable
 * catalogue. The page is a sequence of `## Brand` headings followed by a
 * table whose first column carries the PAN (with spaces) and optional notes.
 */

export interface TestCard {
  brand: string;
  number: string;
  /** Column 2 of the table when it is a card type (Consumer, Debit, ...), else the brand row label. */
  variant?: string;
  country?: string;
  expiry?: string;
  cvc?: string;
  note?: string;
  /** True for rows under the "3D Secure 2" heading. */
  threeDS2: boolean;
}

const COUNTRY = /^[A-Z]{2}$/;
const EXPIRY = /^\d{2}\/\d{2,4}$/;
const CVC = /^(\d{3,4}|None|Not applicable)$/i;

export function parseTestCards(md: string): TestCard[] {
  const cards: TestCard[] = [];
  let brand = "";
  let threeDS2 = false;
  for (const raw of md.split("\n")) {
    if (raw.startsWith("## ")) {
      brand = raw.slice(3).trim();
      threeDS2 = /3d secure/i.test(brand);
      continue;
    }
    if (!raw.startsWith("|") || !brand || /^\|\s*-/.test(raw)) continue;
    const cells = raw
      .split("|")
      .slice(1, -1)
      .map((c) => c.replace(/\[[^\]]*\]\([^)]*\)/g, "").trim());
    const panIdx = cells.findIndex((c) => /^\d{4} ?\d{4}/.test(c));
    if (panIdx < 0) continue;
    const panCell = cells[panIdx];
    const number = (panCell.match(/[\d ]+/)?.[0] ?? "").replace(/\s+/g, "");
    if (number.length < 12) continue;
    const note = panCell.replace(/[\d ]+/, "").trim() || undefined;
    const rest = cells.filter((_, i) => i !== panIdx);
    const card: TestCard = { brand, number, threeDS2, note };
    for (const c of rest) {
      if (COUNTRY.test(c) && !card.country) card.country = c;
      else if (EXPIRY.test(c) && !card.expiry) card.expiry = c;
      else if (CVC.test(c) && !card.cvc) card.cvc = c;
      else if (c && !/^(user|password)$/i.test(c) && !card.variant && !/:/.test(c)) card.variant = c;
    }
    if (threeDS2 && panIdx > 0) card.variant = cells[0];
    cards.push(card);
  }
  return cards;
}
