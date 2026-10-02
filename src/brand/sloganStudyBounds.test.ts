import { describe, expect, it } from "vitest";
import { pathInkBounds, unionInkBounds } from "./sloganStudyBounds.js";

describe("slogan study ink bounds", () => {
  it("bounds lines and implicit line coordinate pairs", () => {
    expect(pathInkBounds("M0,0L10,20L-4,3")).toEqual({ minX: -4, minY: 0, maxX: 10, maxY: 20 });
    expect(pathInkBounds("M0,0 10,10 0,20Z")).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 20 });
  });

  it("uses exact interior cubic extrema rather than control-point bounds", () => {
    const bounds = pathInkBounds("M0,0C100,100 -100,100 0,0");
    expect(bounds.minX).toBeCloseTo(-100 / (2 * Math.sqrt(3)), 10);
    expect(bounds.maxX).toBeCloseTo(100 / (2 * Math.sqrt(3)), 10);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxY).toBeCloseTo(75, 10);
  });

  it("handles linear derivatives and double tangent roots", () => {
    expect(pathInkBounds("M0,0C10,30 20,30 30,0")).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 22.5 });
    expect(pathInkBounds("M0,0C1,0 0,0 1,0")).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 0 });
    expect(pathInkBounds("M-3,-2C-3,-2 -3,-2 -3,-2")).toEqual({ minX: -3, minY: -2, maxX: -3, maxY: -2 });
  });

  it("accepts negative coordinates, exponents, and sign-separated numbers", () => {
    expect(pathInkBounds("M-1e1,-2.5L-.5,+3.5L2-4")).toEqual({ minX: -10, minY: -4, maxX: 2, maxY: 3.5 });
  });

  it("combines multiple subpaths without bounding unconnected moveto points", () => {
    expect(pathInkBounds("M999,999M0,0L1,1ZM-20,-30L-10,-20Z")).toEqual({ minX: -20, minY: -30, maxX: 1, maxY: 1 });
  });

  it("includes closing edges and restores their current point", () => {
    expect(pathInkBounds("M7,-9L2,-3ZL-5,8")).toEqual({ minX: -5, minY: -9, maxX: 7, maxY: 8 });
  });

  it.each(["", "L0,0", "m0,0l1,1", "M0,0Q1,2 3,4", "M0", "M0,0L1", "M0,0C1,2 3,4", "M,0,0", "M0,,0", "M0,0,", "M0,0,Z", "M0,0Z1,2", "M0,0L1e999,2", "M0,0 garbage"])("rejects invalid or unsupported path syntax: %s", d => {
    expect(() => pathInkBounds(d)).toThrow();
  });

  it("unions bounds without changing the inputs", () => {
    const first = Object.freeze({ minX: -4, minY: 2, maxX: 5, maxY: 9 });
    const second = Object.freeze({ minX: 1, minY: -3, maxX: 12, maxY: 7 });
    expect(unionInkBounds([first, second])).toEqual({ minX: -4, minY: -3, maxX: 12, maxY: 9 });
    expect(unionInkBounds([first])).toEqual(first);
    expect(unionInkBounds([first])).not.toBe(first);
  });

  it("rejects empty, reversed, or non-finite bounds", () => {
    expect(() => unionInkBounds([])).toThrow();
    expect(() => unionInkBounds([{ minX: 2, minY: 0, maxX: 1, maxY: 0 }])).toThrow();
    expect(() => unionInkBounds([{ minX: 0, minY: 0, maxX: Infinity, maxY: 0 }])).toThrow();
  });
});
