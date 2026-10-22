import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlendedCostChart, monthLabel } from "./EfficiencyPanels";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const points = [
  2.0, 1.86, 1.75, 1.72, 1.70, 1.49,
  1.47, 1.45, 1.28, 1.21, 1.08, 0.95,
].map((value, index) => ({
  period: `2025-${String(index + 1).padStart(2, "0")}-01`,
  blended_cost_per_mtok: value,
}));

describe("Efficiency reference chart parity", () => {
  it("renders an honest labelled axis system with regular app typography", () => {
    const html = renderToStaticMarkup(
      <BlendedCostChart
        pts={points}
        migration={{ period: points[5].period, pct: 0.12 }}
      />,
    );

    expect(monthLabel(points[0].period)).toBe("Jan ’25");
    expect(html).toContain("USD per million tokens");
    expect(html).toContain("$0.00");
    expect(html).toContain("Jan ’25");
    expect(html).toContain("font-family=\"inherit\"");
    expect(html).toContain("font-size=\"12\"");
    expect(html).not.toContain("font-size=\"13\"");
    expect(html).toContain("font-weight=\"400\"");
    expect(html).toMatch(/<svg[^>]+viewBox="0 0 (\d+) (\d+)"[^>]+width="\1" height="\2"/);
    expect(html).toContain("AI run cost efficiency");
  });

  it("uses a smooth teal line without point markers", () => {
    const html = renderToStaticMarkup(
      <BlendedCostChart
        pts={points}
        migration={{ period: points[5].period, pct: 0.12 }}
      />,
    );

    expect(html).toContain('stroke="var(--c-efficiency-line)"');
    expect(html).toMatch(/<path[^>]+d="M[^"]+C[^"]+"/);
    expect(html).not.toContain("<circle");

    const css = readFileSync(join(ROOT, "index.css"), "utf8");
    expect(css).toContain("--c-efficiency-line: #0E8C7A;");
    expect(css).toContain("--c-efficiency-line: #1C9784;");
  });

  it("places the migration annotation inside the plot", () => {
    const html = renderToStaticMarkup(
      <BlendedCostChart
        pts={points}
        migration={{ period: points[5].period, pct: 0.12 }}
      />,
    );

    expect(html).toContain("model migration −12%");
    expect(html).toContain('stroke-dasharray="4 3"');
    expect(html).not.toContain("peak ");
  });
});
