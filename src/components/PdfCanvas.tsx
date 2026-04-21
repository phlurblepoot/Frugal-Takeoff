import React, { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Line, Circle, Text, Group, Rect } from 'react-konva';
import { Html } from 'react-konva-utils';
import { Trash2, Edit2, X, Check, ZoomIn, ZoomOut, RotateCcw, Maximize2 } from 'lucide-react';
import useImage from 'use-image';
import { v4 as uuidv4 } from 'uuid';
import { Point, Measurement, MeasurementSegment, Tool, ScaleConfig, MeasurementTakeoff, ScaleRegion } from '../types';
import { calculateDistance, calculatePolylineLength, calculatePolygonArea, formatMeasurement, generateArcPoints, expandArcPoints, calculateSurfaceAreaPx, isPointInPolygon, calculateRealValue, convertUnit, formatRealValue, UNIT_LABELS } from '../utils/math';
import { createWorker } from 'tesseract.js';

interface PdfCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  currentTool: Tool;
  scaleConfig: ScaleConfig | null;
  measurements: Measurement[];
  pageMeasurements?: Measurement[];
  takeoffs: MeasurementTakeoff[];
  onAddMeasurement: (measurement: Measurement) => void;
  onUpdateMeasurement: (id: string, measurement: Partial<Measurement>) => void;
  onDeleteMeasurement: (id: string) => void;
  onSetScale: (pixelDistance: number) => void;
  selectedMeasurementId: string | null;
  onSelectMeasurement: (id: string | null) => void;
  onCancel?: () => void;
  isMultiRegion?: boolean;
  scaleRegions?: ScaleRegion[];
  selectedRegionId?: string | null;
  onSelectRegion?: (id: string | null) => void;
  onAddRegion?: (region: ScaleRegion) => void;
  onUpdateRegion?: (id: string, region: Partial<ScaleRegion>) => void;
  onDeleteRegion?: (id: string) => void;
  calibratingRegionId?: string | null;
  remoteUsers?: any[];
  onCursorMove?: (x: number, y: number) => void;
  currentUserId?: string;
  resumeMeasurement?: Measurement | null;
  onMeasurementResumed?: () => void;
  showLegend?: boolean;
  showLegendTotals?: boolean;
  legendPosition?: { x: number, y: number };
  legendScale?: number;
  legendScaleX?: number;
  legendScaleY?: number;
  legendFontSize?: number;
  legendWidth?: number;
  onUpdateLegend?: (updates: { position?: { x: number, y: number }, scale?: number, scaleX?: number, scaleY?: number, fontSize?: number, width?: number }) => void;
  searchTerm?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  hasCopied?: boolean;
  newMeasurementToken?: number;
  multiSelectedIds?: Set<string>;
  onMultiSelectToggle?: (id: string, type: string) => void;
  onClearMultiSelect?: () => void;
  isMultiSelectMode?: boolean;
}

export const PdfCanvas: React.FC<PdfCanvasProps> = ({
  imageUrl,
  imageWidth,
  imageHeight,
  currentTool,
  scaleConfig,
  measurements,
  pageMeasurements,
  takeoffs,
  onAddMeasurement,
  onUpdateMeasurement,
  onDeleteMeasurement,
  onSetScale,
  selectedMeasurementId,
  onSelectMeasurement,
  onCancel,
  isMultiRegion = false,
  scaleRegions = [],
  selectedRegionId,
  onSelectRegion,
  onAddRegion,
  onUpdateRegion,
  onDeleteRegion,
  calibratingRegionId,
  remoteUsers = [],
  onCursorMove,
  currentUserId,
  resumeMeasurement,
  onMeasurementResumed,
  showLegend = false,
  showLegendTotals = true,
  legendPosition = { x: 20, y: 20 },
  legendScale = 2,
  legendScaleX,
  legendScaleY,
  legendFontSize = 14,
  legendWidth,
  onUpdateLegend,
  searchTerm,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  hasCopied,
  newMeasurementToken,
  multiSelectedIds,
  onMultiSelectToggle,
  onClearMultiSelect,
  isMultiSelectMode = false,
}) => {
  const [image] = useImage(imageUrl);
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const stageScaleRef = useRef(1);
  const stagePosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    stageScaleRef.current = stageScale;
  }, [stageScale]);

  useEffect(() => {
    stagePosRef.current = stagePos;
  }, [stagePos]);

  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  
  const [activePoints, setActivePoints] = useState<Point[]>([]);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [isMiddleMouseDown, setIsMiddleMouseDown] = useState(false);
  const isMiddleMouseDownRef = useRef(false);
  const lastMousePosRef = useRef<{x: number, y: number} | null>(null);

  const [arcMode, setArcMode] = useState<'inactive' | 'waiting_mid' | 'waiting_end'>('inactive');
  const [arcMidPoint, setArcMidPoint] = useState<Point | null>(null);
  const [activeArcMidIndices, setActiveArcMidIndices] = useState<number[]>([]);
  
  const [draggingPoint, setDraggingPoint] = useState<{ mId: string, idx: number, x: number, y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; measurementId: string | null } | null>(null);

  const [resumeMeasurementId, setResumeMeasurementId] = useState<string | null>(null);
  const [activeMultiSegmentId, setActiveMultiSegmentId] = useState<string | null>(null);
  const [searchHighlights, setSearchHighlights] = useState<{x0: number, y0: number, x1: number, y1: number}[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  const newMeasurementTokenRef = useRef(newMeasurementToken ?? 0);
  useEffect(() => {
    if (newMeasurementToken !== undefined && newMeasurementToken !== newMeasurementTokenRef.current) {
      newMeasurementTokenRef.current = newMeasurementToken;
      setActiveMultiSegmentId(null);
    }
  }, [newMeasurementToken]);

  useEffect(() => {
    if (resumeMeasurement) {
      setActivePoints(resumeMeasurement.points);
      setActiveArcMidIndices(resumeMeasurement.arcMidIndices || []);
      setResumeMeasurementId(resumeMeasurement.id);
      setArcMode('inactive');
      setArcMidPoint(null);
      onMeasurementResumed?.();
    }
  }, [resumeMeasurement, onMeasurementResumed]);

  const lastDistRef = useRef<number>(0);
  const lastCenterRef = useRef<Point | null>(null);
  const zoomRafRef = useRef<number | null>(null);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    
    updateDimensions();
    
    const observer = new ResizeObserver(() => {
      updateDimensions();
    });
    
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (e.button === 1) {
        setIsMiddleMouseDown(false);
        isMiddleMouseDownRef.current = false;
        lastMousePosRef.current = null;
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [contextMenu]);

  // Fit image to screen initially
  useEffect(() => {
    if (image && dimensions.width > 0 && dimensions.height > 0) {
      const scaleX = dimensions.width / imageWidth;
      const scaleY = dimensions.height / imageHeight;
      const initialScale = Math.min(scaleX, scaleY) * 0.9; // 90% of screen
      
      setStageScale(initialScale);
      setStagePos({
        x: (dimensions.width - imageWidth * initialScale) / 2,
        y: (dimensions.height - imageHeight * initialScale) / 2,
      });
    }
  }, [image, dimensions, imageWidth, imageHeight]);

  useEffect(() => {
    let isActive = true;
    const runSearch = async () => {
      if (!searchTerm || !imageUrl) {
        setSearchHighlights([]);
        return;
      }
      setIsSearching(true);
      let worker: any = null;
      try {
        worker = await createWorker('eng');
        if (!isActive) return;
        const ret = await worker.recognize(imageUrl, {}, { blocks: true });
        if (!isActive) return;

        const data = ret?.data;
        const words = data?.words || [];

        const lowerSearchTerm = searchTerm.toLowerCase();
        const searchWords = lowerSearchTerm.split(/\s+/).filter(Boolean);

        const highlights = words
          .filter(w => {
            const wordText = w?.text?.toLowerCase() || '';
            // Match if the word contains any of the search words
            // This handles cases where the OCR word has punctuation attached
            return searchWords.some(sw => wordText.includes(sw));
          })
          .map(w => w.bbox);
        setSearchHighlights(highlights);
      } catch (error) {
        console.error('OCR search failed:', error);
      } finally {
        if (worker) await worker.terminate();
        if (isActive) {
          setIsSearching(false);
        }
      }
    };
    runSearch();
    return () => {
      isActive = false;
    };
  }, [searchTerm, imageUrl]);

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = stageScaleRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - stagePosRef.current.x) / oldScale,
      y: (pointer.y - stagePosRef.current.y) / oldScale,
    };

    // Smoother zoom for trackpads by taking deltaY into account
    // deltaY is usually around 100 for a mouse wheel notch, but much smaller for trackpad
    const zoomSpeed = 0.0015;
    const delta = -e.evt.deltaY;
    const newScale = oldScale * Math.exp(delta * zoomSpeed);
    
    // Limit scale
    const limitedScale = Math.max(0.01, Math.min(newScale, 50));
    
    setStageScale(limitedScale);
    setStagePos({
      x: pointer.x - mousePointTo.x * limitedScale,
      y: pointer.y - mousePointTo.y * limitedScale,
    });
  };

  const handleZoomIn = () => {
    const oldScale = stageScaleRef.current;
    const oldPos = stagePosRef.current;
    const newScale = oldScale * 1.2;
    const center = { x: dimensions.width / 2, y: dimensions.height / 2 };
    const mousePointTo = {
      x: (center.x - oldPos.x) / oldScale,
      y: (center.y - oldPos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: center.x - mousePointTo.x * newScale,
      y: center.y - mousePointTo.y * newScale,
    });
  };

  const handleZoomOut = () => {
    const oldScale = stageScaleRef.current;
    const oldPos = stagePosRef.current;
    const newScale = oldScale / 1.2;
    const center = { x: dimensions.width / 2, y: dimensions.height / 2 };
    const mousePointTo = {
      x: (center.x - oldPos.x) / oldScale,
      y: (center.y - oldPos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: center.x - mousePointTo.x * newScale,
      y: center.y - mousePointTo.y * newScale,
    });
  };

  const handleResetView = () => {
    if (image && dimensions.width > 0 && dimensions.height > 0) {
      const scaleX = dimensions.width / imageWidth;
      const scaleY = dimensions.height / imageHeight;
      const initialScale = Math.min(scaleX, scaleY) * 0.9;
      
      setStageScale(initialScale);
      setStagePos({
        x: (dimensions.width - imageWidth * initialScale) / 2,
        y: (dimensions.height - imageHeight * initialScale) / 2,
      });
    }
  };

  const getRelativePointerPosition = (node: any) => {
    const transform = node.getAbsoluteTransform().copy();
    transform.invert();
    const pos = node.getStage().getPointerPosition();
    return transform.point(pos);
  };

  const handleMouseMove = (e: any) => {
    const stage = stageRef.current;
    if (!stage) return;
    
    const pos = getRelativePointerPosition(stage.getLayers()[0]);
    if (pos) {
      setMousePos(pos);
      onCursorMove?.(pos.x, pos.y);
    }

    if (isMiddleMouseDown && lastMousePosRef.current) {
      // Prevent default to stop any built-in browser behavior like auto-scrolling
      if (e.evt && e.evt.preventDefault) {
        e.evt.preventDefault();
      }
      const dx = e.evt.clientX - lastMousePosRef.current.x;
      const dy = e.evt.clientY - lastMousePosRef.current.y;
      setStagePos(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePosRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      return;
    }

    if (currentTool === 'pan' || activePoints.length === 0) return;
  };

  const handleMouseDown = (e: any) => {
    if (e.evt.button === 1) {
      e.evt.preventDefault();
      setIsMiddleMouseDown(true);
      isMiddleMouseDownRef.current = true;
      lastMousePosRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      return;
    }
    if (currentTool === 'pan') return;
    
    if (e.target !== stageRef.current && e.target.name() !== 'backgroundImage') {
      // If we are not currently drawing, don't start a new drawing when clicking a shape
      if (activePoints.length === 0) {
        return;
      }
    } else {
      // Clicked on background, deselect if not drawing
      if (activePoints.length === 0) {
        if (!e.evt.ctrlKey && !e.evt.metaKey && !isMultiSelectMode) {
          onSelectMeasurement(null);
          onClearMultiSelect?.();
        }
      }
    }

    const stage = stageRef.current;
    const pos = getRelativePointerPosition(stage.getLayers()[0]);
    
    if (currentTool === 'region') {
      if (activePoints.length > 0) {
        const lastPoint = activePoints[activePoints.length - 1];
        const dist = calculateDistance(lastPoint, pos);
        if (dist < 10 / stageScale) {
          if (activePoints.length > 2) {
            const newRegion: ScaleRegion = {
              id: uuidv4(),
              name: `Region ${scaleRegions.length + 1}`,
              points: [...activePoints],
              scaleConfig: null,
              color: '#8b5cf6', // Purple for regions
            };
            onAddRegion?.(newRegion);
          }
          setActivePoints([]);
          setMousePos(null);
          return;
        }
      }
      setActivePoints([...activePoints, pos]);
      return;
    }

    if (currentTool === 'scale') {
      if (activePoints.length === 0) {
        setActivePoints([pos]);
      } else if (activePoints.length === 1) {
        const newPoints = [...activePoints, pos];
        const dist = calculateDistance(newPoints[0], newPoints[1]);
        onSetScale(dist);
        setActivePoints([]);
        setMousePos(null);
      }
    } else if (currentTool === 'count') {
      // Check if multi-region and if point is in a region
      let regionId: string | undefined = undefined;
      if (isMultiRegion) {
        const region = scaleRegions.find(r => isPointInPolygon(pos, r.points));
        if (!region) {
          alert('In multi-region mode, measurements must be started inside a defined region.');
          return;
        }
        regionId = region.id;
      }

      const newMeasurement: Measurement = {
        id: uuidv4(),
        type: 'count',
        points: [pos],
        color: '#f59e0b', // Amber color for count
        name: `Count ${measurements.length + 1}`,
        regionId,
      };
      onAddMeasurement(newMeasurement);
    } else if (currentTool === 'length' || currentTool === 'area') {
      if (activePoints.length === 0 && isMultiRegion) {
        const region = scaleRegions.find(r => isPointInPolygon(pos, r.points));
        if (!region) {
          alert('In multi-region mode, measurements must be started inside a defined region.');
          return;
        }
      }

      if (arcMode === 'waiting_mid') {
        setArcMidPoint(pos);
        setArcMode('waiting_end');
        return;
      } else if (arcMode === 'waiting_end') {
        const midPoint = arcMidPoint!;
        const endPoint = pos;
        // Store only 3 points (start is already last in activePoints), record mid index
        const arcMidIdx = activePoints.length; // index of mid in the new array
        const newPoints = [...activePoints, midPoint, endPoint];
        setActivePoints(newPoints);
        setActiveArcMidIndices(prev => [...prev, arcMidIdx]);
        setArcMode('inactive');
        setArcMidPoint(null);
        return;
      }

      // If clicking very close to the last point, finish the current segment
      if (activePoints.length > 0) {
        const lastPoint = activePoints[activePoints.length - 1];
        const dist = calculateDistance(lastPoint, pos);
        const threshold = (window.innerWidth < 768 ? 20 : 10) / stageScale;
        if (dist < threshold) {
          finalizeSegment();
          return;
        }
      }
      setActivePoints([...activePoints, pos]);
    }
  };

  const handleMouseUp = (e: any) => {
    if (e.evt.button === 1) {
      setIsMiddleMouseDown(false);
      lastMousePosRef.current = null;
    }
  };

  const handleTouchStart = (e: any) => {
    const stage = stageRef.current;
    if (!stage) return;

    // Always prevent default to stop browser-level panning/scrolling
    // when interacting with the canvas
    if (e.evt.cancelable) {
      e.evt.preventDefault();
    }

    if (e.evt.touches.length === 2) {
      // Pinch to zoom
      const touch1 = e.evt.touches[0];
      const touch2 = e.evt.touches[1];
      lastDistRef.current = calculateDistance(
        { x: touch1.clientX, y: touch1.clientY },
        { x: touch2.clientX, y: touch2.clientY }
      );
      lastCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    } else if (e.evt.touches.length === 1) {
      handleMouseDown(e);
    }
  };

  const handleTouchMove = (e: any) => {
    const stage = stageRef.current;
    if (!stage) return;

    if (e.evt.cancelable) {
      e.evt.preventDefault();
    }

    if (e.evt.touches.length === 2) {
      const touch1 = e.evt.touches[0];
      const touch2 = e.evt.touches[1];
      const dist = calculateDistance(
        { x: touch1.clientX, y: touch1.clientY },
        { x: touch2.clientX, y: touch2.clientY }
      );
      const center = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };

      if (lastDistRef.current > 0 && lastCenterRef.current) {
        const oldScale = stageScaleRef.current;
        const oldPos = stagePosRef.current;
        const scaleFactor = dist / lastDistRef.current;
        const newScale = Math.max(0.01, Math.min(oldScale * scaleFactor, 50));

        // Pan + zoom: canvas point under lastCenter should appear at center
        const lastCenter = lastCenterRef.current;
        const mousePointTo = {
          x: (lastCenter.x - oldPos.x) / oldScale,
          y: (lastCenter.y - oldPos.y) / oldScale,
        };
        const newPos = {
          x: center.x - mousePointTo.x * newScale,
          y: center.y - mousePointTo.y * newScale,
        };

        // Update refs synchronously so the next touchmove (which may fire
        // before React commits) reads the correct baseline — otherwise the
        // stale ref causes every other frame to snap backward, producing stutter.
        stageScaleRef.current = newScale;
        stagePosRef.current = newPos;

        // Apply directly to the Konva stage for immediate visual feedback,
        // bypassing React's render cycle on every touchmove event.
        const stageNode = stage;
        stageNode.scale({ x: newScale, y: newScale });
        stageNode.position(newPos);
        stageNode.batchDraw();

        // Queue a state commit so non-Konva UI (zoom %) reflects the change.
        if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
        zoomRafRef.current = requestAnimationFrame(() => {
          setStageScale(newScale);
          setStagePos(newPos);
          zoomRafRef.current = null;
        });
      }

      lastDistRef.current = dist;
      lastCenterRef.current = center;
    } else if (e.evt.touches.length === 1) {
      handleMouseMove(e);
    }
  };

  const handleTouchEnd = (e: any) => {
    if (e.evt.cancelable) {
      e.evt.preventDefault();
    }
    lastDistRef.current = 0;
    lastCenterRef.current = null;
    lastMousePosRef.current = null;
    handleMouseUp(e);
  };

  // Handle Escape to cancel drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input or textarea
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        document.activeElement?.tagName === 'SELECT'
      ) {
        return;
      }

      if (e.key === 'Escape') {
        cancelDrawing();
      } else if (e.key === 'Enter') {
        if (activePoints.length > 1 && (currentTool === 'length' || currentTool === 'area' || currentTool === 'region')) {
          if (currentTool === 'region') {
            if (activePoints.length > 2) {
              const newRegion: ScaleRegion = {
                id: uuidv4(),
                name: `Region ${scaleRegions.length + 1}`,
                points: [...activePoints],
                scaleConfig: null,
                color: '#8b5cf6',
              };
              onAddRegion?.(newRegion);
            }
          } else {
            finalizeSegment();
          }
        }
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (activePoints.length > 0) {
          const lastIdx = activePoints.length - 1;
          const lastMidIdx = activeArcMidIndices[activeArcMidIndices.length - 1];
          if (lastMidIdx === lastIdx - 1) {
            // Last two points form an arc end + mid — remove both
            setActivePoints(prev => prev.slice(0, -2));
            setActiveArcMidIndices(prev => prev.slice(0, -1));
          } else {
            setActivePoints(prev => prev.slice(0, -1));
            setActiveArcMidIndices(prev => prev.filter(i => i < lastIdx));
          }
          if (arcMode !== 'inactive') {
            setArcMode('inactive');
            setArcMidPoint(null);
          }
        }
      } else if (e.key.toLowerCase() === 'a') {
        if (activePoints.length > 0 && arcMode === 'inactive' && (currentTool === 'length' || currentTool === 'area')) {
          setArcMode('waiting_mid');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePoints, currentTool, measurements, onAddMeasurement, arcMode, onCancel, resumeMeasurementId, activeMultiSegmentId, activeArcMidIndices]);

  const cancelDrawing = () => {
    setActivePoints([]);
    setMousePos(null);
    setArcMode('inactive');
    setArcMidPoint(null);
    setActiveArcMidIndices([]);
    setResumeMeasurementId(null);
    setActiveMultiSegmentId(null);
    onCancel?.();
  };

  // Finalize the current in-progress segment, save it to the measurement, and
  // leave drawing active so the user can immediately start the next segment.
  const finalizeSegment = () => {
    if (activePoints.length <= 1) return;

    let regionId: string | undefined = undefined;
    if (isMultiRegion) {
      const region = scaleRegions.find(r => isPointInPolygon(activePoints[0], r.points));
      regionId = region?.id;
    }

    const segPoints = [...activePoints];
    const segArcMids: MeasurementSegment['arcMidIndices'] = activeArcMidIndices.length > 0
      ? [...activeArcMidIndices]
      : undefined;

    if (resumeMeasurementId) {
      const existing = measurements.find(m => m.id === resumeMeasurementId);
      const updated: Measurement = {
        id: resumeMeasurementId,
        type: currentTool as 'length' | 'area',
        points: segPoints,
        color: existing?.color ?? (currentTool === 'length' ? '#3b82f6' : '#10b981'),
        name: existing?.name ?? `${currentTool === 'length' ? 'Length' : 'Area'} ${measurements.length + 1}`,
        regionId,
        arcMidIndices: segArcMids,
      };
      onUpdateMeasurement(resumeMeasurementId, updated);
      setResumeMeasurementId(null);
      // Resume mode replaces the measurement — don't continue multi-segment
      setActiveMultiSegmentId(null);
    } else if (activeMultiSegmentId) {
      const existing = measurements.find(m => m.id === activeMultiSegmentId);
      if (existing) {
        const newSeg: MeasurementSegment = { points: segPoints, arcMidIndices: segArcMids };
        onUpdateMeasurement(activeMultiSegmentId, {
          segments: [...(existing.segments ?? []), newSeg],
        });
      }
      // Keep activeMultiSegmentId — user continues adding segments
    } else {
      const newId = uuidv4();
      const newMeasurement: Measurement = {
        id: newId,
        type: currentTool as 'length' | 'area',
        points: segPoints,
        color: currentTool === 'length' ? '#3b82f6' : '#10b981',
        name: `${currentTool === 'length' ? 'Length' : 'Area'} ${measurements.length + 1}`,
        regionId,
        arcMidIndices: segArcMids,
      };
      onAddMeasurement(newMeasurement);
      setActiveMultiSegmentId(newId);
    }

    setActivePoints([]);
    setMousePos(null);
    setArcMode('inactive');
    setArcMidPoint(null);
    setActiveArcMidIndices([]);
  };

  const renderActiveDrawing = () => {
    if (activePoints.length === 0) return null;

    // Stored points (compact: arcs are 3 points)
    let storedPoints = [...activePoints];
    let previewArcMidIndices = [...activeArcMidIndices];

    if (mousePos) {
      if (arcMode === 'waiting_end' && arcMidPoint) {
        // Preview arc from last active point through arcMidPoint to mousePos
        const arcMidIdx = storedPoints.length; // where mid goes
        storedPoints = [...storedPoints, arcMidPoint, mousePos];
        previewArcMidIndices = [...previewArcMidIndices, arcMidIdx];
      } else {
        storedPoints.push(mousePos);
      }
    }

    // Expand arcs for display
    const displayPoints = expandArcPoints(storedPoints, previewArcMidIndices);
    const flatPoints = displayPoints.flatMap(p => [p.x, p.y]);
    const arcMidSet = new Set(activeArcMidIndices);

    const color = currentTool === 'scale' ? '#ef4444' : currentTool === 'length' ? '#3b82f6' : currentTool === 'region' ? '#8b5cf6' : '#10b981';

    return (
      <Group>
        <Line
          points={flatPoints}
          stroke={color}
          strokeWidth={4 / stageScale}
          lineJoin="round"
          lineCap="round"
          dash={currentTool === 'scale' ? [5 / stageScale, 5 / stageScale] : undefined}
          closed={(currentTool === 'area' || currentTool === 'region') && activePoints.length > 2 && arcMode === 'inactive'}
          fill={(currentTool === 'area' || currentTool === 'region') ? `${color}40` : undefined}
        />
        {activePoints.map((p, i) => (
          <Circle
            key={i}
            x={p.x}
            y={p.y}
            radius={arcMidSet.has(i) ? 3 / stageScale : 4 / stageScale}
            fill={arcMidSet.has(i) ? '#f97316' : color}
          />
        ))}
        {arcMidPoint && (
          <Circle
            x={arcMidPoint.x}
            y={arcMidPoint.y}
            radius={4 / stageScale}
            fill="#ef4444"
          />
        )}
      </Group>
    );
  };

  const getSelectedMeasurementCenter = () => {
    if (!selectedMeasurementId) return null;
    const m = measurements.find(m => m.id === selectedMeasurementId);
    if (!m) return null;

    let centerX = 0, centerY = 0;
    if (m.type === 'count') {
      centerX = m.points[0].x;
      centerY = m.points[0].y;
    } else if (m.type === 'length') {
      if (m.points.length < 2) return m.points[0];
      const midIdx = Math.floor((m.points.length - 1) / 2);
      centerX = (m.points[midIdx].x + m.points[midIdx + 1].x) / 2;
      centerY = (m.points[midIdx].y + m.points[midIdx + 1].y) / 2;
    } else {
      m.points.forEach(p => { centerX += p.x; centerY += p.y; });
      centerX /= m.points.length;
      centerY /= m.points.length;
    }
    return { x: centerX, y: centerY };
  };

  const renderMeasurements = () => {
    return measurements.filter(m => m.id !== resumeMeasurementId).map((m) => {
      // Find region scale if applicable
      let currentScale = scaleConfig;
      if (isMultiRegion && m.regionId) {
        const region = scaleRegions.find(r => r.id === m.regionId);
        if (region?.scaleConfig) {
          currentScale = region.scaleConfig;
        }
      }

      // Compact points (including arc control mid-points)
      const points = m.points.map((p, i) => {
        if (draggingPoint && draggingPoint.mId === m.id && draggingPoint.idx === i) {
          return { x: draggingPoint.x, y: draggingPoint.y };
        }
        return { x: p.x, y: p.y };
      });

      // Expanded display points (arcs interpolated to smooth curves)
      const displayPoints = expandArcPoints(points, m.arcMidIndices);
      const flatPoints = displayPoints.flatMap(p => [p.x, p.y]);

      // Calculate center for text (use display points for position)
      let centerX = 0, centerY = 0;
      if (m.type === 'count') {
        centerX = points[0].x;
        centerY = points[0].y;
      } else if (m.type === 'length') {
        const midIdx = Math.floor((displayPoints.length - 1) / 2);
        centerX = (displayPoints[midIdx].x + displayPoints[Math.min(midIdx + 1, displayPoints.length - 1)].x) / 2;
        centerY = (displayPoints[midIdx].y + displayPoints[Math.min(midIdx + 1, displayPoints.length - 1)].y) / 2;
      } else {
        displayPoints.forEach(p => { centerX += p.x; centerY += p.y; });
        centerX /= displayPoints.length;
        centerY /= displayPoints.length;
      }

      // All expanded segment display points (primary + additional)
      const allSegDisplayPoints = [
        displayPoints,
        ...(m.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
      ];

      let text = '';
      const takeoff = takeoffs.find(t => t.id === m.takeoffId);
      const isSurfaceArea = takeoff?.type === 'area' && m.type === 'length';

      if (m.type === 'count') {
        text = '1';
      } else if (isSurfaceArea) {
        const pxArea = allSegDisplayPoints.reduce((sum, pts) =>
          sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
        const pxLen = allSegDisplayPoints.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        const areaText = formatMeasurement(pxArea, 'area', currentScale, takeoff);
        const lenText = formatMeasurement(pxLen, 'length', currentScale, takeoff);
        text = `${areaText}\nLength: ${lenText}`;
      } else if (m.type === 'length') {
        const pxLen = allSegDisplayPoints.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        text = formatMeasurement(pxLen, 'length', currentScale, takeoff);
      } else {
        const pxArea = allSegDisplayPoints.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0);
        text = formatMeasurement(pxArea, 'area', currentScale, takeoff);
      }

      const isSelected = selectedMeasurementId === m.id;
      const isMultiSelected = multiSelectedIds?.has(m.id) ?? false;
      const isDrawingTool = currentTool === 'length' || currentTool === 'area' || currentTool === 'count';

      return (
        <Group
          key={m.id}
          listening={!isDrawingTool}
          draggable={currentTool === 'pan' && !isMiddleMouseDown}
          onClick={(e) => {
            e.cancelBubble = true;
            if (activePoints.length === 0) {
              if (e.evt.ctrlKey || e.evt.metaKey || isMultiSelectMode) {
                onMultiSelectToggle?.(m.id, m.type);
              } else {
                onClearMultiSelect?.();
                onSelectMeasurement(m.id);
              }
            }
          }}
          onTap={(e) => {
            e.cancelBubble = true;
            if (activePoints.length === 0) {
              if (isMultiSelectMode) {
                onMultiSelectToggle?.(m.id, m.type);
              } else {
                onSelectMeasurement(m.id);
              }
            }
          }}
          onContextMenu={(e) => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            setContextMenu({ x: e.evt.clientX, y: e.evt.clientY, measurementId: m.id });
          }}
          onDragStart={(e) => {
            if ((e.evt && e.evt.button !== 0) || isMiddleMouseDownRef.current) {
              e.target.stopDrag();
              return;
            }
            e.cancelBubble = true;
          }}
          onDragMove={(e) => {
            e.cancelBubble = true;
          }}
          onDragEnd={(e) => {
            e.cancelBubble = true;
            if (e.target.name() === 'measurement-group') {
              const dx = e.target.x();
              const dy = e.target.y();
              e.target.x(0);
              e.target.y(0);
              const newPoints = m.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
              onUpdateMeasurement(m.id, { points: newPoints });
            }
          }}
          name="measurement-group"
        >
          {m.type === 'count' ? (
            <Group x={points[0].x} y={points[0].y}>
              <Circle
                radius={isSelected ? 14 / stageScale : 12 / stageScale}
                fill={m.color}
                opacity={0.8}
                shadowColor={isSelected ? m.color : undefined}
                shadowBlur={isSelected ? 10 / stageScale : 0}
                shadowOpacity={isSelected ? 0.5 : 0}
              />
              <Line
                points={[-6 / stageScale, 0, 6 / stageScale, 0]}
                stroke="#fff"
                strokeWidth={3 / stageScale}
              />
              <Line
                points={[0, -6 / stageScale, 0, 6 / stageScale]}
                stroke="#fff"
                strokeWidth={3 / stageScale}
              />
            </Group>
          ) : (
            <>
              <Line
                points={flatPoints}
                stroke={isMultiSelected ? '#f59e0b' : m.color}
                strokeWidth={isSelected ? 8 / stageScale : isMultiSelected ? 7 / stageScale : 5 / stageScale}
                hitStrokeWidth={20 / stageScale}
                lineJoin="round"
                lineCap="round"
                closed={m.type === 'area'}
                fill={m.type === 'area' ? `${isMultiSelected ? '#f59e0b' : m.color}${isSelected ? '60' : isMultiSelected ? '50' : '40'}` : undefined}
                shadowColor={isMultiSelected ? '#f59e0b' : isSelected ? m.color : undefined}
                shadowBlur={isMultiSelected ? 14 / stageScale : isSelected ? 10 / stageScale : 0}
                shadowOpacity={isMultiSelected ? 0.7 : isSelected ? 0.5 : 0}
                onDblClick={(e) => {
                  e.cancelBubble = true;
                  const stage = stageRef.current;
                  const pos = getRelativePointerPosition(stage.getLayers()[0]);
                  if (!pos) return;
                  // Find which segment is closest to the click
                  const segs = m.type === 'area'
                    ? [...m.points.map((_, i) => i), 0].map((_, i, arr) => i < arr.length - 1 ? [m.points[arr[i]], m.points[arr[i+1]]] : null).filter(Boolean) as [Point, Point][]
                    : m.points.slice(0, -1).map((p, i) => [p, m.points[i + 1]] as [Point, Point]);
                  let bestIdx = 0;
                  let bestDist = Infinity;
                  segs.forEach(([a, b], i) => {
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const lenSq = dx * dx + dy * dy;
                    let t = lenSq > 0 ? ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / lenSq : 0;
                    t = Math.max(0, Math.min(1, t));
                    const cx = a.x + t * dx, cy = a.y + t * dy;
                    const d = Math.hypot(pos.x - cx, pos.y - cy);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                  });
                  const insertAfter = m.type === 'area' && bestIdx === segs.length - 1 ? m.points.length - 1 : bestIdx;
                  const newPoints = [...m.points];
                  newPoints.splice(insertAfter + 1, 0, pos);
                  onUpdateMeasurement(m.id, { points: newPoints });
                }}
              />
              {points.map((p, i) => (
                <Circle
                  key={i}
                  x={p.x}
                  y={p.y}
                  radius={isSelected ? 8 / stageScale : 6 / stageScale}
                  fill={m.color}
                  stroke={isSelected ? '#fff' : undefined}
                  strokeWidth={isSelected ? 2 / stageScale : 0}
                  draggable={currentTool === 'pan' && !isMiddleMouseDown}
                  onDragStart={(e) => {
                    if ((e.evt && e.evt.button !== 0) || isMiddleMouseDownRef.current) {
                      e.target.stopDrag();
                      return;
                    }
                    e.cancelBubble = true;
                    setDraggingPoint({ mId: m.id, idx: i, x: p.x, y: p.y });
                  }}
                  onDragMove={(e) => {
                    e.cancelBubble = true;
                    setDraggingPoint({ mId: m.id, idx: i, x: e.target.x(), y: e.target.y() });
                  }}
                  onDragEnd={(e) => {
                    e.cancelBubble = true;
                    const newPoints = [...m.points];
                    newPoints[i] = { x: e.target.x(), y: e.target.y() };
                    
                    // Reset the circle's position so it doesn't double-apply the offset
                    e.target.x(p.x);
                    e.target.y(p.y);
                    
                    setDraggingPoint(null);
                    onUpdateMeasurement(m.id, { points: newPoints });
                  }}
                  hitStrokeWidth={10 / stageScale}
                />
              ))}
            </>
          )}
          {(m.segments ?? []).map((seg, segIdx) => {
            const segDisplayPts = expandArcPoints(seg.points, seg.arcMidIndices);
            const segFlat = segDisplayPts.flatMap(p => [p.x, p.y]);
            return (
              <React.Fragment key={`extra-seg-${segIdx}`}>
                <Line
                  points={segFlat}
                  stroke={m.color}
                  strokeWidth={isSelected ? 8 / stageScale : 5 / stageScale}
                  lineJoin="round"
                  lineCap="round"
                  closed={m.type === 'area'}
                  fill={m.type === 'area' ? `${m.color}${isSelected ? '60' : '40'}` : undefined}
                  shadowColor={isSelected ? m.color : undefined}
                  shadowBlur={isSelected ? 10 / stageScale : 0}
                  shadowOpacity={isSelected ? 0.5 : 0}
                />
                {seg.points.map((p, pi) => (
                  <Circle
                    key={pi}
                    x={p.x}
                    y={p.y}
                    radius={isSelected ? 8 / stageScale : 6 / stageScale}
                    fill={m.color}
                    stroke={isSelected ? '#fff' : undefined}
                    strokeWidth={isSelected ? 2 / stageScale : 0}
                  />
                ))}
              </React.Fragment>
            );
          })}
          {text && m.type !== 'count' && (
            <Group x={centerX} y={centerY}>
              <Text
                text={text}
                fontSize={14 / stageScale}
                fill="#fff"
                padding={4 / stageScale}
                align="center"
                offsetY={10 / stageScale}
              />
              <Text
                text={text}
                fontSize={14 / stageScale}
                fill="#000"
                padding={4 / stageScale}
                align="center"
                offsetY={10 / stageScale}
                stroke="#fff"
                strokeWidth={2 / stageScale}
                fillAfterStrokeEnabled
              />
            </Group>
          )}
        </Group>
      );
    });
  };

  const renderRegions = () => {
    if (!isMultiRegion) return null;
    return scaleRegions.map((r) => {
      const isSelected = r.id === selectedRegionId;
      const isCalibrating = r.id === calibratingRegionId;
      const isVisible = isSelected || isCalibrating || currentTool === 'region';
      const isInteractable = currentTool === 'pan' && isVisible;
      
      const flatPoints = r.points.flatMap(p => [p.x, p.y]);
      
      // Calculate center for text
      let centerX = 0, centerY = 0;
      r.points.forEach(p => { centerX += p.x; centerY += p.y; });
      centerX /= r.points.length;
      centerY /= r.points.length;

      return (
        <Group 
          key={r.id}
          visible={isVisible}
          listening={isInteractable}
          onClick={(e) => {
            if (currentTool === 'pan') {
              e.cancelBubble = true;
              onSelectRegion?.(isSelected ? null : r.id);
            } else if (currentTool === 'scale') {
              e.cancelBubble = true;
            }
          }}
        >
          <Line
            points={flatPoints}
            stroke={r.color}
            strokeWidth={2 / stageScale}
            dash={[10 / stageScale, 5 / stageScale]}
            closed={true}
            fill={`${r.color}15`}
            hitStrokeWidth={20 / stageScale}
          />
          <Group x={centerX} y={centerY}>
            <Text
              text={r.name + (r.scaleConfig ? ` (${r.scaleConfig.label || 'Calibrated'})` : ' (No Scale)')}
              fontSize={16 / stageScale}
              fill={r.color}
              align="center"
              fontStyle="bold"
            />
          </Group>
          {isSelected && r.points.map((p, i) => (
            <Circle
              key={i}
              x={p.x}
              y={p.y}
              radius={4 / stageScale}
              fill={r.color}
              draggable={currentTool === 'pan'}
              onDragMove={(e) => {
                const newPoints = [...r.points];
                newPoints[i] = { x: e.target.x(), y: e.target.y() };
                onUpdateRegion?.(r.id, { points: newPoints });
              }}
              onDragEnd={(e) => {
                e.target.x(p.x);
                e.target.y(p.y);
              }}
            />
          ))}
        </Group>
      );
    });
  };

  const renderLegend = () => {
    if (!showLegend || takeoffs.length === 0) return null;

    const legendItems: { color: string; name: string; total: string }[] = [];

    takeoffs.forEach(takeoff => {
      let totalRealValue = 0;
      let hasMeasurements = false;

      const measurementsToUse = pageMeasurements || measurements;

      measurementsToUse.filter(m => m.takeoffId === takeoff.id).forEach(m => {
        hasMeasurements = true;
        let currentScale = scaleConfig;
        if (isMultiRegion && m.regionId) {
          const region = scaleRegions.find(r => r.id === m.regionId);
          if (region?.scaleConfig) {
            currentScale = region.scaleConfig;
          }
        }

        const allMSegPts = [
          expandArcPoints(m.points, m.arcMidIndices),
          ...(m.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
        ];
        let pixelValue = 0;
        if (takeoff.type === 'length' && m.type === 'length') {
          pixelValue = allMSegPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        } else if (takeoff.type === 'area' && m.type === 'area') {
          pixelValue = allMSegPts.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0);
        } else if (takeoff.type === 'area' && m.type === 'length') {
          pixelValue = allMSegPts.reduce((sum, pts) =>
            sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
        } else if (takeoff.type === 'count' && m.type === 'count') {
          pixelValue = 1;
        }

        if (pixelValue > 0) {
          const realValue = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
          const targetUnit = takeoff.unit || scaleConfig?.unit || 'ft';
          const sourceUnit = currentScale?.unit || 'ft';

          if (takeoff.type === 'count') {
            totalRealValue += realValue;
          } else {
            const cleanTargetUnit = targetUnit.replace('sq ', '');
            totalRealValue += convertUnit(realValue, sourceUnit, cleanTargetUnit, takeoff.type as 'length' | 'area' | 'count');
          }
        }
      });

      if (hasMeasurements) {
        const targetUnit = takeoff.unit || scaleConfig?.unit || 'ft';
        const unitLabel = ` ${UNIT_LABELS[takeoff.type as keyof typeof UNIT_LABELS]?.[targetUnit] || targetUnit}`;
        const formattedTotal = takeoff.type === 'count' 
          ? Math.round(totalRealValue).toString() 
          : totalRealValue.toFixed(2);
        
        legendItems.push({
          color: takeoff.color,
          name: takeoff.name,
          total: showLegendTotals ? `${formattedTotal}${unitLabel}` : ''
        });
      }
    });

    if (legendItems.length === 0) return null;

    const padding = legendFontSize * 0.8;
    const itemHeight = legendFontSize * 1.6;
    const colorBoxSize = legendFontSize;
    const textOffsetX = colorBoxSize + 10;
    const width = legendWidth || 350;
    const height = padding * 2 + legendItems.length * itemHeight + legendFontSize * 2;

    return (
      <Group
        x={legendPosition.x}
        y={legendPosition.y}
        draggable={currentTool === 'pan'}
        onDragEnd={(e) => {
          if (e.target === e.currentTarget && onUpdateLegend) {
            onUpdateLegend({ position: { x: e.target.x(), y: e.target.y() } });
          }
        }}
        onWheel={(e) => {
          if (currentTool === 'pan') {
            e.cancelBubble = true;
            e.evt.preventDefault();
            const scaleBy = 1.05;
            const oldFontSize = legendFontSize;
            const newFontSize = e.evt.deltaY < 0 ? oldFontSize * scaleBy : oldFontSize / scaleBy;
            if (onUpdateLegend) {
              onUpdateLegend({ 
                fontSize: Math.max(8, Math.min(newFontSize, 100))
              });
            }
          }
        }}
      >
        <Rect
          width={width}
          height={height}
          fill="white"
          stroke="#e2e8f0"
          strokeWidth={1}
          cornerRadius={6}
          shadowColor="black"
          shadowBlur={10}
          shadowOpacity={0.1}
          shadowOffset={{ x: 0, y: 4 }}
        />
        <Text
          x={padding}
          y={padding}
          text="Legend"
          fontSize={legendFontSize + 2}
          fontStyle="bold"
          fill="#334155"
        />
        {legendItems.map((item, index) => (
          <Group key={index} y={padding + legendFontSize * 2 + index * itemHeight}>
            <Rect
              x={padding}
              y={2}
              width={colorBoxSize}
              height={colorBoxSize}
              fill={item.color}
              cornerRadius={3}
            />
            <Text
              x={padding + textOffsetX}
              y={2}
              text={item.name}
              fontSize={legendFontSize}
              fill="#475569"
              width={width - padding * 2 - textOffsetX - (showLegendTotals ? legendFontSize * 10 : 0)}
              ellipsis={true}
              wrap="none"
            />
            {showLegendTotals && (
              <Text
                x={width - padding - legendFontSize * 10}
                y={2}
                text={item.total}
                fontSize={legendFontSize}
                fill="#0f172a"
                width={legendFontSize * 10}
                align="right"
                fontStyle="bold"
                wrap="none"
              />
            )}
          </Group>
        ))}
        {/* Resize handle */}
        {currentTool === 'pan' && (
          <Rect
            x={width - 10}
            y={height - 10}
            width={10}
            height={10}
            fill="#3b82f6"
            cornerRadius={2}
            draggable
            onDragMove={(e) => {
              e.cancelBubble = true;
              const stage = e.target.getStage();
              if (!stage) return;
              const pointerPos = stage.getPointerPosition();
              if (!pointerPos) return;
              
              // Calculate new width and font size based on pointer position relative to legend origin
              const newWidth = (pointerPos.x - stagePos.x) / stageScale - legendPosition.x;
              const newHeight = (pointerPos.y - stagePos.y) / stageScale - legendPosition.y;
              
              // height = fontSize * (1.6 + items * 1.6 + 2) = fontSize * (3.6 + items * 1.6)
              const newFontSize = newHeight / (3.6 + legendItems.length * 1.6);
              
              if (onUpdateLegend) {
                onUpdateLegend({ 
                  width: Math.max(100, newWidth),
                  fontSize: Math.max(8, newFontSize)
                });
              }
              
              // Reset handle position relative to group so it stays at the corner
              e.target.x(width - 10);
              e.target.y(height - 10);
            }}
            onDragEnd={(e) => {
              e.cancelBubble = true;
              // Ensure handle stays at the corner
              e.target.x(width - 10);
              e.target.y(height - 10);
            }}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'nwse-resize';
            }}
            onMouseLeave={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'crosshair';
            }}
          />
        )}
      </Group>
    );
  };

  return (
    <div ref={containerRef} className="w-full h-full bg-slate-100 overflow-hidden cursor-crosshair touch-none relative" onContextMenu={e => e.preventDefault()}>
      {contextMenu && (
        <div
          className="fixed z-[200] bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          {contextMenu.measurementId && (
            <>
              <button
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
                onClick={() => { onDeleteMeasurement(contextMenu.measurementId!); setContextMenu(null); }}
              >
                <Trash2 size={14} /> Delete
              </button>
              {onCopy && (
                <button
                  className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                  onClick={() => { onCopy(); setContextMenu(null); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  Copy
                </button>
              )}
              <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
            </>
          )}
          {onUndo && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
              onClick={() => { onUndo(); setContextMenu(null); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
              Undo
            </button>
          )}
          {onRedo && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
              onClick={() => { onRedo(); setContextMenu(null); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
              Redo
            </button>
          )}
          {onPaste && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2 disabled:opacity-40"
              onClick={() => { onPaste(); setContextMenu(null); }}
              disabled={!hasCopied}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
              Paste
            </button>
          )}
          {activePoints.length > 0 && (
            <>
              <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
              <button
                className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                onClick={() => { cancelDrawing(); setContextMenu(null); }}
              >
                Cancel Drawing
              </button>
            </>
          )}
        </div>
      )}
      {isSearching && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur border border-slate-200 rounded-full px-4 py-2 shadow-lg z-50 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium text-slate-700">Searching...</span>
        </div>
      )}
      {dimensions.width > 0 && dimensions.height > 0 && (
        <>
          {/* Zoom Toolbar */}
          <div className="absolute bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 flex items-center bg-white/90 backdrop-blur-sm border border-slate-200 rounded-full shadow-lg px-2 py-1.5 z-30 gap-1">
            <button
              onClick={handleZoomOut}
              className="p-2 text-slate-600 hover:text-accent-600 hover:bg-slate-100 rounded-full transition-colors"
              title="Zoom Out"
            >
              <ZoomOut size={18} />
            </button>
            
            <div className="px-2 min-w-[60px] text-center text-sm font-semibold text-slate-700 select-none">
              {Math.round(stageScale * 100)}%
            </div>
            
            <button
              onClick={handleZoomIn}
              className="p-2 text-slate-600 hover:text-accent-600 hover:bg-slate-100 rounded-full transition-colors"
              title="Zoom In"
            >
              <ZoomIn size={18} />
            </button>
            
            <div className="w-px h-4 bg-slate-200 mx-1" />
            
            <button
              onClick={handleResetView}
              className="p-2 text-slate-600 hover:text-accent-600 hover:bg-slate-100 rounded-full transition-colors"
              title="Reset View"
            >
              <RotateCcw size={18} />
            </button>
          </div>

          <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          onWheel={handleWheel}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onContextMenu={(e) => {
            e.evt.preventDefault();
            setContextMenu({ x: e.evt.clientX, y: e.evt.clientY, measurementId: null });
          }}
          onDragEnd={(e) => {
            if (e.target === e.currentTarget) {
              setStagePos({ x: e.target.x(), y: e.target.y() });
            }
          }}
          draggable={currentTool === 'pan' && !isTouchDevice}
          scaleX={stageScale}
          scaleY={stageScale}
          x={stagePos.x}
          y={stagePos.y}
          className={currentTool === 'pan' || isMiddleMouseDown ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}
        >
          <Layer>
            {image && (
              <KonvaImage
                image={image}
                name="backgroundImage"
                width={imageWidth}
                height={imageHeight}
              />
            )}
            {searchHighlights.map((bbox, i) => (
              <Rect
                key={`highlight-${i}`}
                x={bbox.x0}
                y={bbox.y0}
                width={bbox.x1 - bbox.x0}
                height={bbox.y1 - bbox.y0}
                fill="rgba(255, 255, 0, 0.4)"
                stroke="rgba(255, 200, 0, 0.8)"
                strokeWidth={2 / stageScale}
                cornerRadius={2 / stageScale}
              />
            ))}
            {renderRegions()}
            {renderMeasurements()}
            {renderActiveDrawing()}
            {renderLegend()}
          </Layer>
          <Layer>
            {/* Remote Cursors */}
            {remoteUsers
              .filter(u => u.id !== currentUserId && u.cursor)
              .map(u => (
                <Group key={u.id} x={u.cursor!.x} y={u.cursor!.y}>
                  <Line
                    points={[0, 0, 10, 10, 4, 10, 0, 14]}
                    closed
                    fill={u.color}
                    stroke="white"
                    strokeWidth={1 / stageScale}
                    scaleX={1 / stageScale}
                    scaleY={1 / stageScale}
                  />
                  <Group y={16 / stageScale} scaleX={1 / stageScale} scaleY={1 / stageScale}>
                    <Line
                      points={[
                        0, 0,
                        u.name.length * 7 + 8, 0,
                        u.name.length * 7 + 8, 16,
                        0, 16
                      ]}
                      closed
                      fill={u.color}
                      opacity={0.8}
                    />
                    <Text
                      text={u.name}
                      fontSize={10}
                      fill="white"
                      padding={4}
                      fontStyle="bold"
                    />
                  </Group>
                </Group>
              ))}
          </Layer>
          {selectedMeasurementId && window.innerWidth < 768 && (
            <Layer>
              {(() => {
                const center = getSelectedMeasurementCenter();
                if (!center) return null;
                
                return (
                  <Html
                    divProps={{
                      style: {
                        position: 'absolute',
                        left: `${center.x * stageScale + stagePos.x}px`,
                        top: `${center.y * stageScale + stagePos.y - 60}px`,
                        transform: 'translateX(-50%)',
                        pointerEvents: 'auto',
                      }
                    }}
                  >
                    <div className="flex items-center gap-1 bg-white/95 backdrop-blur border border-slate-200 rounded-full p-1 shadow-xl z-50 ring-1 ring-black/5">
                      <button
                        onClick={() => onDeleteMeasurement(selectedMeasurementId)}
                        className="p-2.5 text-red-500 hover:bg-red-50 rounded-full active:scale-90 transition-all"
                        title="Delete"
                      >
                        <Trash2 size={20} />
                      </button>
                      <div className="w-px h-5 bg-slate-200 mx-0.5" />
                      <button
                        onClick={() => onSelectMeasurement(null)}
                        className="p-2.5 text-slate-500 hover:bg-slate-100 rounded-full active:scale-90 transition-all"
                        title="Deselect"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  </Html>
                );
              })()}
            </Layer>
          )}
      </Stage>
        </>
      )}
    </div>
  );
};
