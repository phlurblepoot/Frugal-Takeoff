// src/utils/math.test.ts
// CHARACTERIZATION tests: these lock in what src/utils/math.ts does TODAY.
// Do not "fix" surprising behavior — assert the current output and comment.
import { describe, it, expect } from 'vitest';
import {
  calculateDistance,
  calculatePolylineLength,
  calculatePolygonArea,
  isPointInPolygon,
  calculateRealValue,
  calculateSurfaceAreaPx,
} from './math';
import { Point, ScaleConfig } from '../types';

describe('geometry & scale', () => {
  describe('calculateDistance', () => {
    it('3-4-5 right triangle', () => {
      expect(calculateDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    });
    it('identical points -> 0', () => {
      expect(calculateDistance({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
    });
  });

  describe('calculatePolylineLength', () => {
    it('two points', () => {
      expect(calculatePolylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe(5);
    });
    it('L-shaped three points', () => {
      expect(
        calculatePolylineLength([
          { x: 0, y: 0 },
          { x: 0, y: 10 },
          { x: 10, y: 10 },
        ])
      ).toBe(20);
    });
    it('single point -> 0', () => {
      expect(calculatePolylineLength([{ x: 5, y: 5 }])).toBe(0);
    });
  });

  describe('calculatePolygonArea', () => {
    it('4x4 square = 16', () => {
      expect(
        calculatePolygonArea([
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
        ])
      ).toBe(16);
    });
    it('triangle = 6', () => {
      expect(
        calculatePolygonArea([
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 3 },
        ])
      ).toBe(6);
    });
    it('fewer than 3 points -> 0', () => {
      expect(calculatePolygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }])).toBe(0);
    });
    it('reversed winding still 16 (abs)', () => {
      expect(
        calculatePolygonArea([
          { x: 0, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 0 },
          { x: 0, y: 0 },
        ])
      ).toBe(16);
    });
  });

  describe('isPointInPolygon', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    it('inside point -> true', () => {
      expect(isPointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    });
    it('outside point -> false', () => {
      expect(isPointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    });
    it('degenerate 2-point polygon -> false', () => {
      expect(
        isPointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }])
      ).toBe(false);
    });
  });

  describe('calculateRealValue', () => {
    const scale: ScaleConfig = {
      pixelDistance: 50,
      realWorldDistance: 10,
      unit: 'ft',
    };
    it('length scales linearly', () => {
      expect(calculateRealValue(100, 'length', scale)).toBeCloseTo(20);
    });
    it('area scales by ratio squared', () => {
      expect(calculateRealValue(100, 'area', scale)).toBeCloseTo(4);
    });
    it('count returns pixel value unchanged', () => {
      expect(calculateRealValue(100, 'count', scale)).toBe(100);
    });
    it('null scale returns pixel value', () => {
      expect(calculateRealValue(100, 'length', null)).toBe(100);
    });
    it('zero pixelDistance returns pixel value', () => {
      expect(
        calculateRealValue(100, 'length', {
          pixelDistance: 0,
          realWorldDistance: 10,
          unit: 'ft',
        })
      ).toBe(100);
    });
  });

  describe('calculateSurfaceAreaPx', () => {
    const points: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const heights = [5, 5];
    const scale: ScaleConfig = {
      pixelDistance: 1,
      realWorldDistance: 1,
      unit: 'ft',
    };
    it('one-sided = 50', () => {
      expect(calculateSurfaceAreaPx(points, heights, false, scale)).toBe(50);
    });
    it('two-sided = 100', () => {
      expect(calculateSurfaceAreaPx(points, heights, true, scale)).toBe(100);
    });
    it('null scale -> 0', () => {
      expect(calculateSurfaceAreaPx(points, heights, false, null)).toBe(0);
    });
  });
});
