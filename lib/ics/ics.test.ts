import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIcsCalendar } from "./ics";

afterEach(() => {
  vi.useRealTimers();
});

describe("buildIcsCalendar", () => {
  it("writes a complete UTC event with CRLF endings and an exact minute duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T19:20:30.456Z"));

    const calendar = buildIcsCalendar({
      uid: "session-123@margin",
      title: "Margin journal club",
      description: "A paper for the lab",
      startMs: Date.UTC(2026, 11, 31, 23, 30, 5),
      durationMinutes: 60,
      url: "https://margin.example/app/sessions/session-123",
    });

    expect(calendar).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Margin//Journal Club//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        "UID:session-123@margin",
        "DTSTAMP:20260808T192030Z",
        "DTSTART:20261231T233005Z",
        "DTEND:20270101T003005Z",
        "SUMMARY:Margin journal club",
        "DESCRIPTION:A paper for the lab",
        "URL:https://margin.example/app/sessions/session-123",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    expect(calendar.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("escapes RFC text characters in event fields and includes a location", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const calendar = buildIcsCalendar({
      uid: "session,123;lab\\margin",
      title: "Reading, writing; and \\ revision\ncontinued",
      description: "Paper, one; draft\\copy\r\nSession link\rBackup\nDone",
      startMs: Date.UTC(2026, 0, 2, 3, 4, 5),
      durationMinutes: 90,
      url: "https://margin.example/sessions/a,b;c",
      location: "Room 1, Main; West\\Wing\nSecond floor",
    });

    expect(calendar).toContain("UID:session\\,123\\;lab\\\\margin\r\n");
    expect(calendar).toContain(
      "SUMMARY:Reading\\, writing\\; and \\\\ revision\\ncontinued\r\n",
    );
    expect(calendar).toContain(
      "DESCRIPTION:Paper\\, one\\; draft\\\\copy\\nSession link\\nBackup\\nDone\r\n",
    );
    expect(calendar).toContain(
      "LOCATION:Room 1\\, Main\\; West\\\\Wing\\nSecond floor\r\n",
    );
    expect(calendar).toContain(
      "URL:https://margin.example/sessions/a,b;c\r\n",
    );
    expect(calendar).toContain("DTEND:20260102T043405Z\r\n");
  });

  it("counts the continuation space when folding long content lines", () => {
    const calendar = buildIcsCalendar({
      uid: "folding-test",
      title: "a".repeat(142),
      description: "Fold the summary",
      startMs: Date.UTC(2026, 0, 1),
      durationMinutes: 60,
      url: "https://margin.example/session",
    });

    const lines = calendar.split("\r\n");
    const summaryIndex = lines.findIndex((line) => line.startsWith("SUMMARY:"));

    expect(lines.slice(summaryIndex, summaryIndex + 3)).toEqual([
      `SUMMARY:${"a".repeat(67)}`,
      ` ${"a".repeat(74)}`,
      " a",
    ]);
  });

  it("folds by UTF-8 octets without splitting a multibyte character", () => {
    const calendar = buildIcsCalendar({
      uid: "unicode-folding-test",
      title: `${"é".repeat(40)}🧪`,
      description: "A UTF-8 title",
      startMs: Date.UTC(2026, 0, 1),
      durationMinutes: 60,
      url: "https://margin.example/session",
    });

    const lines = calendar.split("\r\n").filter((line) => line.length > 0);
    const summaryIndex = lines.findIndex((line) => line.startsWith("SUMMARY:"));

    expect(lines.slice(summaryIndex, summaryIndex + 2)).toEqual([
      `SUMMARY:${"é".repeat(33)}`,
      ` ${"é".repeat(7)}🧪`,
    ]);
    for (const line of lines) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    }
  });
});
