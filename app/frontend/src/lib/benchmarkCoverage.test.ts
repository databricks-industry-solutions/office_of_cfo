import { describe, expect, it } from "vitest";
import { clipUsToPeerHistory, peerHistoryFloor } from "./benchmarkCoverage";

const at = (...years: number[]) => years.map((y) => ({ t: Date.parse(`${y}-12-31`) }));

describe("peerHistoryFloor", () => {
  it("returns the oldest peer point", () => {
    const series = new Map([
      ["Us", at(2015, 2016, 2017)],
      ["Peer A", at(2022, 2023, 2024)],
      ["Peer B", at(2021, 2022, 2023)],
    ]);
    expect(peerHistoryFloor(series)).toBe(Date.parse("2021-12-31"));
  });

  it("ignores peers too short to be drawn", () => {
    const series = new Map([
      ["Us", at(2015, 2016)],
      ["Peer A", at(2019)],
      ["Peer B", at(2022, 2023)],
    ]);
    expect(peerHistoryFloor(series)).toBe(Date.parse("2022-12-31"));
  });

  it("is null when no peer has a line", () => {
    expect(peerHistoryFloor(new Map([["Us", at(2015, 2016)]]))).toBeNull();
  });
});

describe("clipUsToPeerHistory", () => {
  it("drops our points older than the oldest peer point", () => {
    const series = new Map([
      ["Us", at(2018, 2021, 2022, 2023)],
      ["Peer A", at(2021, 2022, 2023)],
    ]);
    const clipped = clipUsToPeerHistory(series);
    expect(clipped.get("Us")).toHaveLength(3);
    expect(clipped.get("Us")![0].t).toBe(Date.parse("2021-12-31"));
  });

  it("leaves peer series untouched", () => {
    const peer = at(2021, 2022, 2023);
    const clipped = clipUsToPeerHistory(new Map([["Us", at(2010, 2022)], ["Peer A", peer]]));
    expect(clipped.get("Peer A")).toEqual(peer);
  });

  it("leaves us alone when there is no peer line", () => {
    const us = at(2015, 2016, 2017);
    const clipped = clipUsToPeerHistory(new Map([["Us", us]]));
    expect(clipped.get("Us")).toEqual(us);
  });

  it("does not mutate the input map", () => {
    const series = new Map([["Us", at(2010, 2022)], ["Peer A", at(2021, 2022)]]);
    clipUsToPeerHistory(series);
    expect(series.get("Us")).toHaveLength(2);
  });
});
