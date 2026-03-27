export type Point = { x: number; y: number };

export type MeasurementType = 'scale' | 'length' | 'area' | 'count';

export interface Measurement {
  id: string;
  type: MeasurementType;
  points: Point[];
  color: string; // Used if not in a takeoff
  name: string;
  takeoffId?: string;
  heights?: number[];
  isTwoSided?: boolean;
  regionId?: string;
  planSetId?: string; // The plan set version this measurement was made/updated on
}

export type CostType = 'flat' | 'yield' | 'unit' | 'amount_per_units';

export interface CustomCost {
  id: string;
  name: string;
  type: CostType;
  cost?: number;
  yield?: number;
  costPerUnit?: number;
  amount?: number;
  perUnits?: number;
  unit?: string;
}

export interface MeasurementTakeoff {
  id: string;
  name: string;
  color: string;
  type: MeasurementType;
  unit?: string;
  costPerUnit?: number;
  isAdvancedCost?: boolean;
  customCosts?: CustomCost[];
}

export interface TakeoffTemplate {
  id: string;
  name: string;
  color: string;
  type: MeasurementType;
  unit?: string;
  costPerUnit?: number;
  isAdvancedCost?: boolean;
  customCosts?: CustomCost[];
  createdAt: number;
}

export interface ScaleConfig {
  pixelDistance: number;
  realWorldDistance: number;
  unit: string;
  label?: string;
}

export interface PlanSet {
  id: string;
  name: string;
  date?: string;
  createdAt: number;
}

export interface Printout {
  id: string;
  name: string;
  fileId: string;
  createdAt: number;
  type?: 'pdf' | 'excel';
}

export interface ScaleRegion {
  id: string;
  name: string;
  points: Point[];
  scaleConfig: ScaleConfig | null;
  color: string;
}

export interface ProjectPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  imageId: string; // Reference to the image stored separately
  thumbnailId?: string; // Reference to the smaller thumbnail image
  imageWidth: number;
  imageHeight: number;
  measurements: Measurement[];
  scaleConfig: ScaleConfig | null;
  planSetId?: string; // Optional for backwards compatibility
  isMultiRegion?: boolean;
  scaleRegions?: ScaleRegion[];
  extractedText?: string;
  showLegend?: boolean;
  showLegendTotals?: boolean;
  legendPosition?: { x: number, y: number };
  legendScale?: number;
}

export interface Bid {
  id: string;
  name: string;
  contractor: string;
  address: string;
  decision: 'yes' | 'no' | 'pending';
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  contractor?: string;
  address?: string;
  bidDueDate?: number | null;
  planSets?: PlanSet[];
  pages: ProjectPage[];
  takeoffs: MeasurementTakeoff[];
  printouts?: Printout[];
  submitted?: boolean;
  responded?: boolean;
  accepted?: boolean;
}

export type Tool = 'pan' | 'scale' | 'length' | 'area' | 'count' | 'region';
