/** Collapse export formatting while leaving human-authored Unicode untouched. */
export function cleanReferenceText(value: string): string {
  return value
    .replace(/\\([&%_$#{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** RIS and BibTeX both commonly encode a person as "Last, First". */
export function normalizeAuthor(value: string): string {
  const author = cleanReferenceText(stripOuterBraces(value));
  const comma = author.indexOf(",");
  if (comma === -1) {
    return author;
  }

  const family = author.slice(0, comma).trim();
  const given = author.slice(comma + 1).trim();
  return [given, family].filter(Boolean).join(" ");
}

/** Split BibTeX's `and` only when it is not protected by grouping braces. */
export function parseBibTeXAuthors(value: string): string[] {
  const authors: string[] = [];
  let start = 0;
  let braceDepth = 0;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "{") {
      braceDepth++;
      continue;
    }
    if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth !== 0 || !/^\s+and\s+/i.test(value.slice(index))) {
      continue;
    }

    const separator = /^\s+and\s+/i.exec(value.slice(index));
    if (separator === null) {
      continue;
    }
    authors.push(value.slice(start, index));
    index += separator[0].length - 1;
    start = index + 1;
  }
  authors.push(value.slice(start));

  return authors.map(normalizeAuthor).filter(Boolean);
}

export function readYear(value: string | undefined): number | undefined {
  const match = value?.match(/\b\d{4}\b/);
  return match === undefined || match === null
    ? undefined
    : Number.parseInt(match[0], 10);
}

function stripOuterBraces(value: string): string {
  let result = value.trim();
  while (result.startsWith("{") && result.endsWith("}")) {
    let depth = 0;
    let enclosesWholeValue = true;
    for (let index = 0; index < result.length; index++) {
      if (result[index] === "\\") {
        index++;
      } else if (result[index] === "{") {
        depth++;
      } else if (result[index] === "}") {
        depth--;
        if (depth === 0 && index < result.length - 1) {
          enclosesWholeValue = false;
          break;
        }
      }
    }
    if (!enclosesWholeValue || depth !== 0) {
      break;
    }
    result = result.slice(1, -1).trim();
  }
  return result;
}
