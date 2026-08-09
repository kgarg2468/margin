export type IcsEvent = {
  uid: string;
  title: string;
  description: string;
  startMs: number;
  durationMinutes: number;
  url: string;
  location?: string;
};

function utcTimestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

const utf8 = new TextEncoder();

function foldContentLine(line: string): string {
  const folded: string[] = [];
  let current = "";
  let currentOctets = 0;

  for (const character of line) {
    const characterOctets = utf8.encode(character).byteLength;
    if (currentOctets + characterOctets > 75) {
      folded.push(current);
      current = ` ${character}`;
      currentOctets = 1 + characterOctets;
    } else {
      current += character;
      currentOctets += characterOctets;
    }
  }
  folded.push(current);

  return folded.join("\r\n");
}

export function buildIcsCalendar(event: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Margin//Journal Club//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${utcTimestamp(Date.now())}`,
    `DTSTART:${utcTimestamp(event.startMs)}`,
    `DTEND:${utcTimestamp(
      event.startMs + event.durationMinutes * 60_000,
    )}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `URL:${event.url}`,
    ...(event.location === undefined
      ? []
      : [`LOCATION:${escapeText(event.location)}`]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return `${lines.map(foldContentLine).join("\r\n")}\r\n`;
}
