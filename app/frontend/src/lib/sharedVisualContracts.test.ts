import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHART_AXIS_TEXT,
  CHART_AXIS_TEXT_DENSE,
  CHART_AXIS_TEXT_PIXEL,
  CHART_COLORS,
  SPEND_STACKED_AREA,
  SPEND_STACKED_AREA_CSS_VARS,
  SPEND_STACKED_AREA_ORDER,
  type SpendStackedAreaKey,
} from "./chartPalette";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = () => readFileSync(join(ROOT, "index.css"), "utf8");

const OPAQUE_HEX = /^#[0-9A-Fa-f]{6}$/;

function themeBlock(sheet: string, selector: ":root" | ".dark"): string {
  const pattern =
    selector === ":root" ? /:root(?:\s*,\s*\.entrance)?\s*\{([^}]+)\}/ : /\.dark\s*\{([^}]+)\}/;
  const block = sheet.match(pattern)?.[1];
  expect(block, `expected a ${selector} { … } block in index.css`).toBeTruthy();
  return block!;
}

function parseRgbTriplet(block: string, cssVar: string): [number, number, number] | null {
  const match = block.match(
    new RegExp(`${cssVar}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`),
  );
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseOpaqueHex(block: string, cssVar: string): string | null {
  return block.match(new RegExp(`${cssVar}:\\s*(#[0-9A-Fa-f]{6})`))?.[1] ?? null;
}

function channelLuma([r, g, b]: [number, number, number]): number {
  return r + g + b;
}

describe("shared visual contracts", () => {
  it("defines theme-aware record-row hover token and utility", () => {
    const sheet = css();
    const rootBlock = themeBlock(sheet, ":root");
    const darkBlock = themeBlock(sheet, ".dark");

    expect(parseRgbTriplet(rootBlock, "--c-record-row-hover")).not.toBeNull();
    expect(parseRgbTriplet(darkBlock, "--c-record-row-hover")).not.toBeNull();

    expect(sheet).toContain(".record-row-hover");
    expect(sheet).toContain("transition-colors");
    expect(sheet).toContain(":focus-within");
    expect(sheet).toContain("rgb(var(--c-record-row-hover))");
  });

  it("keeps light record-row hover subtle relative to ink-700", () => {
    const rootBlock = themeBlock(css(), ":root");
    const ink700 = parseRgbTriplet(rootBlock, "--c-ink-700");
    const rowHover = parseRgbTriplet(rootBlock, "--c-record-row-hover");
    expect(ink700, "--c-ink-700 in :root").not.toBeNull();
    expect(rowHover, "--c-record-row-hover in :root").not.toBeNull();

    const maxChannelDelta = 3;
    const channelsBounded = rowHover!.every(
      (channel, index) => Math.abs(channel - ink700![index]) <= maxChannelDelta,
    );
    expect(
      channelsBounded,
      "light record-row hover should match or stay within a few steps of ink-700",
    ).toBe(true);
    expect(channelLuma(rowHover!)).toBeGreaterThanOrEqual(channelLuma(ink700!) - maxChannelDelta * 3);
  });

  it("uses a lighter dark-mode record-row hover than ink-600", () => {
    const darkBlock = themeBlock(css(), ".dark");
    const ink600 = parseRgbTriplet(darkBlock, "--c-ink-600");
    const rowHover = parseRgbTriplet(darkBlock, "--c-record-row-hover");
    expect(ink600, "--c-ink-600 in .dark").not.toBeNull();
    expect(rowHover, "--c-record-row-hover in .dark").not.toBeNull();
    expect(channelLuma(rowHover!)).toBeGreaterThan(channelLuma(ink600!));
  });

  it("keeps Spend stacked-area CSS tokens opaque and aligned with chartPalette", () => {
    const sheet = css();
    const rootBlock = themeBlock(sheet, ":root");
    const darkBlock = themeBlock(sheet, ".dark");

    const paletteKeys = Object.keys(SPEND_STACKED_AREA_CSS_VARS) as SpendStackedAreaKey[];
    expect(SPEND_STACKED_AREA_ORDER).toEqual(paletteKeys);

    for (const key of SPEND_STACKED_AREA_ORDER) {
      const cssVar = SPEND_STACKED_AREA_CSS_VARS[key];
      expect(cssVar).toBe(`--c-spend-area-${key}`);

      const lightFromCss = parseOpaqueHex(rootBlock, cssVar);
      const darkFromCss = parseOpaqueHex(darkBlock, cssVar);
      expect(lightFromCss, `${cssVar} in :root`).not.toBeNull();
      expect(darkFromCss, `${cssVar} in .dark`).not.toBeNull();

      expect(lightFromCss).toMatch(OPAQUE_HEX);
      expect(darkFromCss).toMatch(OPAQUE_HEX);
      expect(lightFromCss).toBe(SPEND_STACKED_AREA.light[key]);
      expect(darkFromCss).toBe(SPEND_STACKED_AREA.dark[key]);
      expect(lightFromCss).not.toEqual(darkFromCss);
    }

    expect(rootBlock).not.toMatch(/--c-spend-area-[a-z]+:\s*[^;]*rgba/i);
    expect(darkBlock).not.toMatch(/--c-spend-area-[a-z]+:\s*[^;]*\//);
  });

  it("exposes Spend area series in chartPalette while keeping shared axis/grid", () => {
    expect(CHART_COLORS.grid).toBeTruthy();
    expect(CHART_COLORS.axis).toBeTruthy();
    for (const key of SPEND_STACKED_AREA_ORDER) {
      expect(SPEND_STACKED_AREA.light[key]).toMatch(OPAQUE_HEX);
      expect(SPEND_STACKED_AREA.dark[key]).toMatch(OPAQUE_HEX);
    }
  });

  it("standardizes SVG axis typography on the app font at three sizing densities", () => {
    expect(CHART_AXIS_TEXT).toEqual({
      fontFamily: "inherit",
      fontSize: 10,
      fontWeight: 400,
    });
    expect(CHART_AXIS_TEXT_DENSE).toEqual({
      fontFamily: "inherit",
      fontSize: 9,
      fontWeight: 400,
    });
    expect(CHART_AXIS_TEXT_PIXEL).toEqual({
      fontFamily: "inherit",
      fontSize: 12,
      fontWeight: 400,
    });
  });
});
