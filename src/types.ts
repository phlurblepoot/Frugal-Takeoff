export type Point = { x: number; y: number };

export type MeasurementType = 'scale' | 'length' | 'area' | 'count';

export interface MeasurementSegment {
  points: Point[];
  arcMidIndices?: number[];
}

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
  arcMidIndices?: number[]; // indices of arc mid-control points; triples (i-1, i, i+1) are arcs
  segments?: MeasurementSegment[]; // additional segments (first segment lives in points/arcMidIndices)
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
  pricePackage?: string;
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
  // Legacy raster-page reference. Pages uploaded under the old pipeline have an
  // imageId pointing at a full-size JPEG; new uploads leave these empty and use
  // sourcePdfFileId + sourcePdfPageNum instead so the original vectors survive.
  imageId: string;
  thumbnailId?: string;
  imageWidth: number;
  imageHeight: number;
  // Vector source for the page. When sourcePdfFileId is set, the canvas renders
  // this PDF page on demand via pdf.js and printouts copy its vectors via pdf-lib.
  // Multiple ProjectPages from one upload share the same sourcePdfFileId.
  sourcePdfFileId?: string;
  sourcePdfPageNum?: number; // 1-based index within sourcePdfFileId
  // True once extractedText has been populated from the source PDF's
  // embedded text layer (vs. OCR or upload-time guess). ProjectView's mount
  // effect reindexes any vector page where this flag isn't set, so future
  // search hits use the real text the PDF was written with.
  searchTextIndexed?: boolean;
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
  legendScaleX?: number;
  legendScaleY?: number;
  legendFontSize?: number;
  legendWidth?: number;
}

export interface BidEmail {
  messageId?: string;       // Original Message-ID header for reply threading
  from: string;             // Sender email address
  fromName?: string;        // Sender display name
  subject: string;
  body: string;             // Plain text body
  htmlBody?: string;        // HTML body
  receivedAt: number;       // Timestamp
  attachmentIds?: string[]; // File IDs stored in images table
  accountId?: string;       // Which IMAP account this came from
}

export type BidStatus = 'new' | 'reviewing' | 'proposal_sent' | 'won' | 'lost' | 'yes' | 'no' | 'pending';

export interface Bid {
  id: string;
  name: string;
  contractor: string;
  address?: string;
  decision: BidStatus;
  createdAt: number;
  email?: BidEmail;           // Latest email in thread (primary display)
  emails?: BidEmail[];        // Full thread, oldest first; email mirrors the last entry
  proposalFileId?: string;    // Printout file ID that was sent
  proposalSentAt?: number;    // When the proposal was emailed
  projectId?: string;         // Linked project ID (if converted)
}

export interface EmailAccount {
  id: string;
  label: string;            // User-friendly name e.g. "Work Gmail"
  host: string;
  port: number;
  secure: boolean;          // true = SSL/TLS, false = STARTTLS
  username: string;
  password: string;
  folder: string;           // IMAP folder/label to watch e.g. "Bid Invitations"
  createdAt: number;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
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
  legendOnAllPages?: boolean;
  // Email thread the project was created from (moved from the bid pipeline on conversion)
  email?: BidEmail;
  emails?: BidEmail[];
  proposalFileId?: string;
  proposalSentAt?: number;
}

export type Tool = 'pan' | 'scale' | 'length' | 'area' | 'count' | 'region';

export interface NoteElement {
  id: string;
  type: 'text' | 'image' | 'link' | 'table' | 'drawing' | 'scale_area' | 'polyline';
  x: number;
  y: number;
  width?: number;
  height?: number;
  content?: string; // For text, link
  data?: any; // For table, drawing, scale_area
  imageUrl?: string; // For image
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  color?: string;
  fontSize?: number;
  strokeWidth?: number;
  isNew?: boolean;
}

export interface ProjectNote {
  id: string;
  projectId: string;
  elements: NoteElement[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  createdAt: number;
  updatedAt: number;
}
