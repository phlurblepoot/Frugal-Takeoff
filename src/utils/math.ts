import { Point, ScaleConfig, MeasurementTakeoff } from '../types';

export const parseFeetAndInches = (input: string, defaultUnit: string = 'ft'): number | null => {
  const cleanInput = input.trim();
  if (!cleanInput) return null;

  // Try to parse as a simple decimal first
  const asFloat = parseFloat(cleanInput);
  if (!isNaN(asFloat) && asFloat.toString() === cleanInput) {
    return defaultUnit === 'in' ? asFloat / 12 : asFloat;
  }

  // Regex to extract feet, inches, and fractions
  const regex = /^(?:([\d.]+)\s*(?:'|ft|feet))?\s*(?:-)?\s*(?:([\d.]+)\s*(?:"|in|inches)?)?\s*(?:(\d+)\/(\d+)\s*(?:"|in|inches)?)?$/i;
  const match = cleanInput.match(regex);

  if (!match || (!match[1] && !match[2] && !match[3])) {
    // Fallback: try to parse just a fraction like "1/2"
    const fractionMatch = cleanInput.match(/^\s*(\d+)\/(\d+)\s*$/);
    if (fractionMatch) {
      const num = parseInt(fractionMatch[1], 10);
      const den = parseInt(fractionMatch[2], 10);
      if (den !== 0) {
        const val = num / den;
        return defaultUnit === 'in' ? val / 12 : val;
      }
    }
    
    // If it still has numbers, maybe it's just a raw number with some text
    const rawNum = parseFloat(cleanInput.replace(/[^\d.-]/g, ''));
    if (!isNaN(rawNum)) {
      return defaultUnit === 'in' ? rawNum / 12 : rawNum;
    }
    
    return null;
  }

  // If there are explicit units in the string, we use them
  const hasExplicitFeet = cleanInput.match(/'|ft|feet/i);
  const hasExplicitInches = cleanInput.match(/"|in|inches/i);

  let feet = parseFloat(match[1] || '0');
  let inches = parseFloat(match[2] || '0');
  const fracNum = parseInt(match[3] || '0', 10);
  const fracDen = parseInt(match[4] || '1', 10);

  let totalInches = inches;
  if (fracDen !== 0) {
    totalInches += fracNum / fracDen;
  }

  // If no explicit units were provided, treat the first number based on defaultUnit
  if (!hasExplicitFeet && !hasExplicitInches) {
    if (defaultUnit === 'ft') {
      // "3 1/2" -> 3.5 feet
      const whole = parseFloat(match[2] || '0');
      const fraction = fracDen !== 0 ? fracNum / fracDen : 0;
      return whole + fraction;
    } else {
      // "3 1/2" -> 3.5 inches
      const whole = parseFloat(match[2] || '0');
      const fraction = fracDen !== 0 ? fracNum / fracDen : 0;
      return (whole + fraction) / 12;
    }
  }

  return feet + (totalInches / 12);
};

export const generateArcPoints = (A: Point, B: Point, C: Point, segments: number = 32): Point[] => {
  const D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
  if (Math.abs(D) < 1e-5) {
    // Collinear, just return straight line
    return [A, B, C];
  }

  const Ux = ((A.x * A.x + A.y * A.y) * (B.y - C.y) + (B.x * B.x + B.y * B.y) * (C.y - A.y) + (C.x * C.x + C.y * C.y) * (A.y - B.y)) / D;
  const Uy = ((A.x * A.x + A.y * A.y) * (C.x - B.x) + (B.x * B.x + B.y * B.y) * (A.x - C.x) + (C.x * C.x + C.y * C.y) * (B.x - A.x)) / D;

  const center = { x: Ux, y: Uy };
  const radius = Math.sqrt(Math.pow(A.x - Ux, 2) + Math.pow(A.y - Uy, 2));

  let startAngle = Math.atan2(A.y - Uy, A.x - Ux);
  let midAngle = Math.atan2(B.y - Uy, B.x - Ux);
  let endAngle = Math.atan2(C.y - Uy, C.x - Ux);

  // Ensure angles are positive
  if (startAngle < 0) startAngle += 2 * Math.PI;
  if (midAngle < 0) midAngle += 2 * Math.PI;
  if (endAngle < 0) endAngle += 2 * Math.PI;

  let clockwise = false;
  
  let ccwDist = endAngle - startAngle;
  if (ccwDist < 0) ccwDist += 2 * Math.PI;
  
  let midCcwDist = midAngle - startAngle;
  if (midCcwDist < 0) midCcwDist += 2 * Math.PI;
  
  if (midCcwDist > ccwDist) {
    clockwise = true;
  }

  let totalAngle = ccwDist;
  if (clockwise) {
    totalAngle = 2 * Math.PI - ccwDist;
  }

  const points: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let angle = startAngle;
    if (clockwise) {
      angle -= t * totalAngle;
    } else {
      angle += t * totalAngle;
    }
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle)
    });
  }

  return points;
};

export const calculateDistance = (p1: Point, p2: Point): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

export const calculatePolylineLength = (points: Point[]): number => {
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    length += calculateDistance(points[i], points[i + 1]);
  }
  return length;
};

// Shoelace formula for polygon area
export const calculatePolygonArea = (points: Point[]): number => {
  if (points.length < 3) return 0;
  
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
};

export const isPointInPolygon = (point: Point, polygon: Point[]): boolean => {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

export const calculateSurfaceAreaPx = (
  points: Point[],
  heightsReal: number[],
  isTwoSided: boolean,
  scale: ScaleConfig | null
): number => {
  if (!scale || scale.pixelDistance === 0) return 0;
  const ratio = scale.realWorldDistance / scale.pixelDistance;
  let areaPx = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const lenPx = calculateDistance(points[i], points[i + 1]);
    const h1Px = (heightsReal[i] || 0) / ratio;
    const h2Px = (heightsReal[i + 1] || 0) / ratio;
    areaPx += lenPx * (h1Px + h2Px) / 2;
  }
  return areaPx * (isTwoSided ? 2 : 1);
};

export const formatFeetAndInches = (decimalFeet: number): string => {
  const totalSixteenths = Math.round(decimalFeet * 12 * 16);
  const f = Math.floor(totalSixteenths / (12 * 16));
  const remainingSixteenths = totalSixteenths % (12 * 16);
  const i = Math.floor(remainingSixteenths / 16);
  const frac = remainingSixteenths % 16;

  let fractionStr = '';
  if (frac > 0) {
    let num = frac;
    let den = 16;
    while (num % 2 === 0 && den % 2 === 0) {
      num /= 2;
      den /= 2;
    }
    fractionStr = ` ${num}/${den}`;
  }

  if (f === 0 && i === 0 && frac === 0) return `0"`;
  
  if (f === 0) {
    const inchPart = i === 0 && frac > 0 ? fractionStr.trim() : `${i}${fractionStr}`;
    return `${inchPart}"`;
  }
  
  const inchPart = i === 0 && frac > 0 ? fractionStr.trim() : `${i}${fractionStr}`;
  return `${f}' - ${inchPart}"`;
};

export const convertUnit = (
  value: number,
  fromUnit: string,
  toUnit: string,
  type: 'length' | 'area' | 'count'
): number => {
  if (type === 'count' || fromUnit === toUnit) return value;

  if (type === 'length') {
    if (fromUnit === 'in' && toUnit === 'ft') return value / 12;
    if (fromUnit === 'in' && toUnit === 'yd') return value / 36;
    if (fromUnit === 'ft' && toUnit === 'in') return value * 12;
    if (fromUnit === 'ft' && toUnit === 'yd') return value / 3;
    if (fromUnit === 'yd' && toUnit === 'in') return value * 36;
    if (fromUnit === 'yd' && toUnit === 'ft') return value * 3;
    if (fromUnit === 'm' && toUnit === 'cm') return value * 100;
    if (fromUnit === 'cm' && toUnit === 'm') return value / 100;
  } else if (type === 'area') {
    // Normalize units to area units for comparison
    const normFrom = fromUnit === 'in' ? 'sqin' : fromUnit === 'ft' ? 'sqft' : fromUnit === 'yd' ? 'sqyd' : fromUnit === 'm' ? 'sqm' : fromUnit === 'cm' ? 'sqcm' : fromUnit;
    const normTo = toUnit === 'in' ? 'sqin' : toUnit === 'ft' ? 'sqft' : toUnit === 'yd' ? 'sqyd' : toUnit === 'm' ? 'sqm' : toUnit === 'cm' ? 'sqcm' : toUnit;

    if (normFrom === normTo) return value;

    if (normFrom === 'sqin' && normTo === 'sqft') return value / 144;
    if (normFrom === 'sqin' && normTo === 'sqyd') return value / 1296;
    if (normFrom === 'sqft' && normTo === 'sqin') return value * 144;
    if (normFrom === 'sqft' && normTo === 'sqyd') return value / 9;
    if (normFrom === 'sqyd' && normTo === 'sqin') return value * 1296;
    if (normFrom === 'sqyd' && normTo === 'sqft') return value * 9;
    if (normFrom === 'sqm' && normTo === 'sqcm') return value * 10000;
    if (normFrom === 'sqcm' && normTo === 'sqm') return value / 10000;
  }

  return value; // Fallback if conversion not supported
};

export const UNIT_LABELS: Record<string, string> = {
  'in': 'in',
  'ft': 'ft',
  'yd': 'yd',
  'cm': 'cm',
  'm': 'm',
  'sqin': 'sq in',
  'sqft': 'sq ft',
  'sqyd': 'sq yd',
  'sqcm': 'sq cm',
  'sqm': 'sq m',
  'each': 'each'
};

export const formatRealValue = (
  realValue: number,
  type: 'length' | 'area' | 'count',
  unit: string,
  takeoff?: MeasurementTakeoff,
  includeCost: boolean = true
): string => {
  if (type === 'count') {
    const count = Math.round(realValue);
    if (includeCost && takeoff?.costPerUnit) {
      const baseCost = count * takeoff.costPerUnit;
      const laborCost = baseCost * ((takeoff.laborPercent || 0) / 100);
      const materialsCost = baseCost * ((takeoff.materialsPercent || 0) / 100);
      const equipmentCost = baseCost * ((takeoff.equipmentPercent || 0) / 100);
      const subtotal = baseCost + laborCost + materialsCost + equipmentCost;
      const profit = subtotal * ((takeoff.profitPercent || 0) / 100);
      const totalCost = subtotal + profit;
      return `${count} each\n$${totalCost.toFixed(2)}`;
    }
    return `${count} each`;
  }

  let displayValue = realValue;
  let displayUnit = unit;

  if (takeoff?.unit) {
    displayUnit = takeoff.unit;
    displayValue = convertUnit(realValue, unit, takeoff.unit, type);
  }

  let text = '';
  const readableUnit = UNIT_LABELS[displayUnit] || displayUnit;

  if (!takeoff?.unit && type === 'length' && (unit === 'ft' || unit === 'in')) {
    const decimalFeet = unit === 'in' ? realValue / 12 : realValue;
    text = formatFeetAndInches(decimalFeet);
  } else if (!takeoff?.unit && type === 'area') {
    if (unit === 'ft') {
      text = `${realValue.toFixed(2)} sq ft`;
    } else if (unit === 'in') {
      text = `${realValue.toFixed(2)} sq in`;
    } else {
      const areaUnit = unit.startsWith('sq') ? readableUnit : `sq ${readableUnit}`;
      text = `${realValue.toFixed(2)} ${areaUnit}`;
    }
  } else {
    text = `${displayValue.toFixed(2)} ${readableUnit}`;
  }

  if (includeCost && takeoff?.costPerUnit) {
    const baseCost = displayValue * takeoff.costPerUnit;
    const laborCost = baseCost * ((takeoff.laborPercent || 0) / 100);
    const materialsCost = baseCost * ((takeoff.materialsPercent || 0) / 100);
    const equipmentCost = baseCost * ((takeoff.equipmentPercent || 0) / 100);
    const subtotal = baseCost + laborCost + materialsCost + equipmentCost;
    const profit = subtotal * ((takeoff.profitPercent || 0) / 100);
    const totalCost = subtotal + profit;
    
    text += `\n$${totalCost.toFixed(2)}`;
  }

  return text;
};

export const formatMeasurement = (
  pixelValue: number,
  type: 'length' | 'area' | 'count',
  scale: ScaleConfig | null,
  takeoff?: MeasurementTakeoff,
  includeCost: boolean = false
): string => {
  if (type === 'count') {
    return formatRealValue(pixelValue, type, 'each', takeoff, includeCost);
  }

  if (!scale || scale.pixelDistance === 0) {
    return `${pixelValue.toFixed(2)} px${type === 'area' ? '²' : ''}`;
  }

  const realValue = calculateRealValue(pixelValue, type, scale);
  return formatRealValue(realValue, type, scale.unit, takeoff, includeCost);
};

export const calculateRealValue = (
  pixelValue: number,
  type: 'length' | 'area' | 'count',
  scale: ScaleConfig | null
): number => {
  if (type === 'count') return pixelValue;
  if (!scale || scale.pixelDistance === 0) return pixelValue;
  
  const ratio = scale.realWorldDistance / scale.pixelDistance;
  return type === 'length' ? pixelValue * ratio : pixelValue * Math.pow(ratio, 2);
};
