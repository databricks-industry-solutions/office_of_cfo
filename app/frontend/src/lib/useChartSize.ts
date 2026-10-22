import { useEffect, useRef, useState } from "react";

export interface ChartSize {
  width: number;
  height: number;
}

/**
 * Measure a chart container so the SVG can use a 1-unit-per-pixel viewBox
 * (crisp strokes, no aspect-ratio lock). Returns a sensible default until the
 * first measurement lands.
 */
export function useChartSize(fallback: ChartSize = { width: 900, height: 260 }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ChartSize>(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (width < 1 || height < 1) return;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}
