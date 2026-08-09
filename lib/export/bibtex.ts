export type BibtexPaper = {
  title: string;
  authors?: readonly string[];
  year?: number;
  venue?: string;
  doi?: string;
  abstract?: string;
};

/** Braced BibTeX values still need literal braces distinguished from delimiters. */
function escapeBibtexValue(value: string): string {
  const escapes: Readonly<Record<string, string>> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "%": "\\%",
    "&": "\\&",
    "#": "\\#",
    _: "\\_",
    $: "\\$",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return value.replace(/[\\{}%&#_$~^]/g, (character) => escapes[character] ?? character);
}

/**
 * Styles are allowed to sentence-case titles, so words carrying intentional
 * capitals get their own braces. Unicode is inspected, never transliterated,
 * in field values; only cite keys are narrowed to portable ASCII below.
 */
function protectTitleCapitals(title: string): string {
  return escapeBibtexValue(title).replace(
    /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu,
    (word) => (word !== word.toLocaleLowerCase() ? `{${word}}` : word),
  );
}

function citeKeyPart(value: string, fallback: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
  return ascii.length > 0 ? ascii : fallback;
}

function firstAuthorFamily(authors: readonly string[] | undefined): string {
  const author = authors?.[0]?.trim();
  if (author === undefined || author.length === 0) {
    return "Anon";
  }
  if (author.includes(",")) {
    return citeKeyPart(author.split(",", 1)[0] ?? "", "Anon");
  }
  const parts = author.split(/\s+/);
  return citeKeyPart(parts.at(-1) ?? "", "Anon");
}

function firstTitleWord(title: string): string {
  const word = title.match(/[\p{L}\p{N}]+/u)?.[0] ?? "";
  return citeKeyPart(word, "Paper");
}

function baseCiteKey(paper: BibtexPaper): string {
  return `${firstAuthorFamily(paper.authors)}${paper.year ?? "nd"}${firstTitleWord(paper.title)}`;
}

/** a … z, then aa … az, so pathological collision sets remain unique. */
function alphabeticSuffix(index: number): string {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

function entriesWithKeys(
  papers: readonly BibtexPaper[],
): { paper: BibtexPaper; key: string }[] {
  const bases = papers.map(baseCiteKey);
  const totals = new Map<string, number>();
  for (const base of bases) {
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return papers.map((paper, index) => {
    const base = bases[index] ?? "AnonndPaper";
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      paper,
      key:
        (totals.get(base) ?? 0) > 1
          ? `${base}${alphabeticSuffix(occurrence)}`
          : base,
    };
  });
}

function field(name: string, value: string | number): string {
  return `  ${name} = {${typeof value === "number" ? value : escapeBibtexValue(value)}}`;
}

/** One conventional article entry per paper, in the library's existing order. */
export function papersToBibtex(papers: readonly BibtexPaper[]): string {
  if (papers.length === 0) {
    return "";
  }

  const entries = entriesWithKeys(papers).map(({ paper, key }) => {
    const fields = [`  title = {${protectTitleCapitals(paper.title)}}`];
    if (paper.authors !== undefined && paper.authors.length > 0) {
      fields.push(field("author", paper.authors.join(" and ")));
    }
    if (paper.year !== undefined) {
      fields.push(field("year", paper.year));
    }
    if (paper.venue !== undefined) {
      fields.push(field("journal", paper.venue));
    }
    if (paper.doi !== undefined) {
      fields.push(field("doi", paper.doi));
    }
    if (paper.abstract !== undefined) {
      fields.push(field("abstract", paper.abstract));
    }
    return `@article{${key},\n${fields.join(",\n")}\n}`;
  });

  return `${entries.join("\n\n")}\n`;
}
