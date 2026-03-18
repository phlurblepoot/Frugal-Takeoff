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
}

export interface MeasurementTakeoff {
  id: string;
  name: string;
  color: string;
  type: MeasurementType;
  unit?: string;
  costPerUnit?: number;
  laborPercent?: number;
  materialsPercent?: number;
  equipmentPercent?: number;
  profitPercent?: number;
}

export interface TakeoffTemplate {
  id: string;
  name: string;
  color: string;
  type: MeasurementType;
  unit?: string;
  costPerUnit?: number;
  laborPercent?: number;
  materialsPercent?: number;
  equipmentPercent?: number;
  profitPercent?: number;
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
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  contractor?: string;
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
