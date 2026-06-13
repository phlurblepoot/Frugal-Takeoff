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
  convertUnit,
  calculateTakeoffTotalCost,
  calculateTakeoffCostDetails,
  roundUpTo100,
} from './math';
import { Point, ScaleConfig, MeasurementTakeoff } from '../types';

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

describe('units & cost', () => {
  describe('convertUnit', () => {
    it('length ft -> in = 12', () => {
      expect(convertUnit(1, 'ft', 'in', 'length')).toBe(12);
    });
    it('length in -> ft = 1 (from 12)', () => {
      expect(convertUnit(12, 'in', 'ft', 'length')).toBe(1);
    });
    it('area ft -> in = 144', () => {
      expect(convertUnit(1, 'ft', 'in', 'area')).toBe(144);
    });
    it('same unit returns value', () => {
      expect(convertUnit(7, 'ft', 'ft', 'length')).toBe(7);
    });
    it('count type returns value unchanged', () => {
      expect(convertUnit(7, 'ft', 'in', 'count')).toBe(7);
    });
    it('unknown unit returns value unchanged', () => {
      expect(convertUnit(7, 'furlong', 'in', 'length')).toBe(7);
    });
    it('"sq ft" -> "sq in" area = 144 (sq prefix normalized)', () => {
      expect(convertUnit(1, 'sq ft', 'sq in', 'area')).toBe(144);
    });
  });

  const baseTakeoff: MeasurementTakeoff = {
    id: 't1',
    name: 'Test',
    color: '#000',
    type: 'area',
  };

  describe('calculateTakeoffTotalCost', () => {
    it('flat cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'Flat', type: 'flat', cost: 100 }],
      };
      expect(calculateTakeoffTotalCost(t, 0)).toBe(100);
    });
    it('yield cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'Y', type: 'yield', yield: 10, cost: 5 }],
      };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(50);
    });
    it('yield of 0 -> 0', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'Y', type: 'yield', yield: 0, cost: 5 }],
      };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(0);
    });
    it('unit cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'U', type: 'unit', costPerUnit: 2 }],
      };
      expect(calculateTakeoffTotalCost(t, 30)).toBe(60);
    });
    it('amount_per_units cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [
          { id: 'c1', name: 'A', type: 'amount_per_units', perUnits: 5, amount: 10 },
        ],
      };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(200);
    });
    it('two costs sum (flat + unit)', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [
          { id: 'c1', name: 'Flat', type: 'flat', cost: 100 },
          { id: 'c2', name: 'U', type: 'unit', costPerUnit: 1 },
        ],
      };
      expect(calculateTakeoffTotalCost(t, 50)).toBe(150);
    });
    it('non-advanced uses costPerUnit', () => {
      const t: MeasurementTakeoff = { ...baseTakeoff, costPerUnit: 3 };
      expect(calculateTakeoffTotalCost(t, 10)).toBe(30);
    });
    it('empty takeoff -> 0', () => {
      const t: MeasurementTakeoff = { ...baseTakeoff };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(0);
    });
  });

  describe('calculateTakeoffCostDetails', () => {
    it('advanced yield produces detail row', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [
          { id: 'c1', name: 'Mud', type: 'yield', yield: 10, cost: 5, unit: 'bags' },
        ],
      };
      const details = calculateTakeoffCostDetails(t, 100);
      expect(details).toHaveLength(1);
      expect(details[0].costValue).toBe(50);
      expect(details[0].quantity).toBe(10);
      expect(details[0].quantityUnit).toBe('bags');
    });
    it('non-advanced returns []', () => {
      const t: MeasurementTakeoff = { ...baseTakeoff };
      expect(calculateTakeoffCostDetails(t, 100)).toEqual([]);
    });
  });

  describe('roundUpTo100', () => {
    it('0 -> 0', () => {
      expect(roundUpTo100(0)).toBe(0);
    });
    it('negative -> 0', () => {
      expect(roundUpTo100(-5)).toBe(0);
    });
    it('exact 100 -> 100', () => {
      expect(roundUpTo100(100)).toBe(100);
    });
    it('101 -> 200', () => {
      expect(roundUpTo100(101)).toBe(200);
    });
    it('250 -> 300', () => {
      expect(roundUpTo100(250)).toBe(300);
    });
  });
});
