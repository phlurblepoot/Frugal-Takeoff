import React, { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Line, Circle, Text, Group } from 'react-konva';
import useImage from 'use-image';
import { v4 as uuidv4 } from 'uuid';
import { Point, Measurement, Tool, ScaleConfig, MeasurementTakeoff, ScaleRegion } from '../types';
import { calculateDistance, calculatePolylineLength, calculatePolygonArea, formatMeasurement, generateArcPoints, calculateSurfaceAreaPx, isPointInPolygon } from '../utils/math';

interface PdfCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  currentTool: Tool;
  scaleConfig: ScaleConfig | null;
  measurements: Measurement[];
  takeoffs: MeasurementTakeoff[];
  onAddMeasurement: (measurement: Measurement) => void;
  onUpdateMeasurement: (id: string, measurement: Partial<Measurement>) => void;
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
}

export const PdfCanvas: React.FC<PdfCanvasProps> = ({
  imageUrl,
  imageWidth,
  imageHeight,
  currentTool,
  scaleConfig,
  measurements,
  takeoffs,
  onAddMeasurement,
  onUpdateMeasurement,
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
}) => {
  const [image] = useImage(imageUrl);
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  
  const [activePoints, setActivePoints] = useState<Point[]>([]);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [isMiddleMouseDown, setIsMiddleMouseDown] = useState(false);
  const lastMousePosRef = useRef<{x: number, y: number} | null>(null);

  const [arcMode, setArcMode] = useState<'inactive' | 'waiting_mid' | 'waiting_end'>('inactive');
  const [arcMidPoint, setArcMidPoint] = useState<Point | null>(null);
  
  const [draggingPoint, setDraggingPoint] = useState<{ mId: string, idx: number, x: number, y: number } | null>(null);

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
        lastMousePosRef.current = null;
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

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

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    const scaleBy = 1.1;
    const stage = stageRef.current;
    const oldScale = stage.scaleX();
    const mousePointTo = {
      x: stage.getPointerPosition().x / oldScale - stage.x() / oldScale,
      y: stage.getPointerPosition().y / oldScale - stage.y() / oldScale,
    };

    const newScale = e.evt.deltaY < 0 ? oldScale * scaleBy : oldScale / scaleBy;
    setStageScale(newScale);
    setStagePos({
      x: -(mousePointTo.x - stage.getPointerPosition().x / newScale) * newScale,
      y: -(mousePointTo.y - stage.getPointerPosition().y / newScale) * newScale,
    });
  };

  const getRelativePointerPosition = (node: any) => {
    const transform = node.getAbsoluteTransform().copy();
    transform.invert();
    const pos = node.getStage().getPointerPosition();
    return transform.point(pos);
  };

  const handleMouseMove = (e: any) => {
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
    const stage = stageRef.current;
    const pos = getRelativePointerPosition(stage.getLayers()[0]);
    setMousePos(pos);
  };

  const handleMouseDown = (e: any) => {
    if (e.evt.button === 1) {
      e.evt.preventDefault();
      setIsMiddleMouseDown(true);
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
        onSelectMeasurement(null);
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
        const startPoint = activePoints[activePoints.length - 1];
        const midPoint = arcMidPoint!;
        const endPoint = pos;
        
        const arcPoints = generateArcPoints(startPoint, midPoint, endPoint);
        
        setActivePoints([...activePoints, ...arcPoints.slice(1)]);
        setArcMode('inactive');
        setArcMidPoint(null);
        return;
      }

      // If clicking very close to the last point, finish the drawing
      if (activePoints.length > 0) {
        const lastPoint = activePoints[activePoints.length - 1];
        const dist = calculateDistance(lastPoint, pos);
        // 5 pixels threshold (adjusted for scale)
        if (dist < 10 / stageScale) {
          if (activePoints.length > 1) {
            let regionId: string | undefined = undefined;
            if (isMultiRegion) {
              const region = scaleRegions.find(r => isPointInPolygon(activePoints[0], r.points));
              regionId = region?.id;
            }

            const newMeasurement: Measurement = {
              id: uuidv4(),
              type: currentTool,
              points: [...activePoints],
              color: currentTool === 'length' ? '#3b82f6' : '#10b981',
              name: `${currentTool === 'length' ? 'Length' : 'Area'} ${measurements.length + 1}`,
              regionId,
            };
            onAddMeasurement(newMeasurement);
          }
          setActivePoints([]);
          setMousePos(null);
          setArcMode('inactive');
          setArcMidPoint(null);
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
        if (activePoints.length > 0) {
          setActivePoints([]);
          setMousePos(null);
          setArcMode('inactive');
          setArcMidPoint(null);
        } else {
          onCancel?.();
        }
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
            let regionId: string | undefined = undefined;
            if (isMultiRegion) {
              const region = scaleRegions.find(r => isPointInPolygon(activePoints[0], r.points));
              regionId = region?.id;
            }

            const newMeasurement: Measurement = {
              id: uuidv4(),
              type: currentTool,
              points: [...activePoints],
              color: currentTool === 'length' ? '#3b82f6' : '#10b981',
              name: `${currentTool === 'length' ? 'Length' : 'Area'} ${measurements.length + 1}`,
              regionId,
            };
            onAddMeasurement(newMeasurement);
          }
          setActivePoints([]);
          setMousePos(null);
          setArcMode('inactive');
          setArcMidPoint(null);
        }
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (activePoints.length > 0) {
          setActivePoints(prev => prev.slice(0, -1));
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
  }, [activePoints, currentTool, measurements, onAddMeasurement, arcMode, onCancel]);

  const renderActiveDrawing = () => {
    if (activePoints.length === 0) return null;

    let points = [...activePoints];
    
    if (mousePos) {
      if (arcMode === 'waiting_end' && arcMidPoint) {
        const startPoint = activePoints[activePoints.length - 1];
        const arcPoints = generateArcPoints(startPoint, arcMidPoint, mousePos);
        points = [...activePoints, ...arcPoints.slice(1)];
      } else {
        points.push(mousePos);
      }
    }

    const flatPoints = points.flatMap(p => [p.x, p.y]);
    
    const color = currentTool === 'scale' ? '#ef4444' : currentTool === 'length' ? '#3b82f6' : currentTool === 'region' ? '#8b5cf6' : '#10b981';

    return (
      <Group>
        <Line
          points={flatPoints}
          stroke={color}
          strokeWidth={2 / stageScale}
          lineJoin="round"
          lineCap="round"
          dash={currentTool === 'scale' ? [5 / stageScale, 5 / stageScale] : undefined}
          closed={(currentTool === 'area' || currentTool === 'region') && points.length > 2 && arcMode === 'inactive'}
          fill={(currentTool === 'area' || currentTool === 'region') ? `${color}40` : undefined}
        />
        {points.map((p, i) => (
          <Circle
            key={i}
            x={p.x}
            y={p.y}
            radius={4 / stageScale}
            fill={color}
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

  const renderMeasurements = () => {
    return measurements.map((m) => {
      // Find region scale if applicable
      let currentScale = scaleConfig;
      if (isMultiRegion && m.regionId) {
        const region = scaleRegions.find(r => r.id === m.regionId);
        if (region?.scaleConfig) {
          currentScale = region.scaleConfig;
        }
      }

      const points = m.points.map((p, i) => {
        if (draggingPoint && draggingPoint.mId === m.id && draggingPoint.idx === i) {
          return { x: draggingPoint.x, y: draggingPoint.y };
        }
        return { x: p.x, y: p.y };
      });

      const flatPoints = points.flatMap(p => [p.x, p.y]);
      
      // Calculate center for text
      let centerX = 0, centerY = 0;
      if (m.type === 'count') {
        centerX = points[0].x;
        centerY = points[0].y;
      } else if (m.type === 'length') {
        // Middle of the line
        const midIdx = Math.floor((points.length - 1) / 2);
        centerX = (points[midIdx].x + points[midIdx + 1].x) / 2;
        centerY = (points[midIdx].y + points[midIdx + 1].y) / 2;
      } else {
        // Centroid of polygon
        points.forEach(p => { centerX += p.x; centerY += p.y; });
        centerX /= points.length;
        centerY /= points.length;
      }

      let text = '';
      const takeoff = takeoffs.find(t => t.id === m.takeoffId);
      const isSurfaceArea = takeoff?.type === 'area' && m.type === 'length';

      if (m.type === 'count') {
        text = '1'; // Or we could show the index, but usually count is just 1 per mark
      } else if (isSurfaceArea) {
        const pxArea = calculateSurfaceAreaPx(points, m.heights || [], m.isTwoSided || false, currentScale);
        const pxLen = calculatePolylineLength(points);
        const areaText = formatMeasurement(pxArea, 'area', currentScale);
        const lenText = formatMeasurement(pxLen, 'length', currentScale);
        text = `${areaText}\nLength: ${lenText}`;
      } else if (m.type === 'length') {
        const pxLen = calculatePolylineLength(points);
        text = formatMeasurement(pxLen, 'length', currentScale);
      } else {
        const pxArea = calculatePolygonArea(points);
        text = formatMeasurement(pxArea, 'area', currentScale);
      }

      const isSelected = selectedMeasurementId === m.id;

      return (
        <Group 
          key={m.id}
          draggable={currentTool === 'pan'}
          onClick={(e) => {
            e.cancelBubble = true;
            if (activePoints.length === 0) {
              onSelectMeasurement(m.id);
            }
          }}
          onTap={(e) => {
            e.cancelBubble = true;
            if (activePoints.length === 0) {
              onSelectMeasurement(m.id);
            }
          }}
          onDragStart={(e) => {
            if (e.evt && e.evt.button !== 0) {
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
                strokeWidth={2 / stageScale}
              />
              <Line
                points={[0, -6 / stageScale, 0, 6 / stageScale]}
                stroke="#fff"
                strokeWidth={2 / stageScale}
              />
            </Group>
          ) : (
            <>
              <Line
                points={flatPoints}
                stroke={m.color}
                strokeWidth={isSelected ? 6 / stageScale : 3 / stageScale}
                hitStrokeWidth={20 / stageScale}
                lineJoin="round"
                lineCap="round"
                closed={m.type === 'area'}
                fill={m.type === 'area' ? `${m.color}${isSelected ? '60' : '40'}` : undefined}
                shadowColor={isSelected ? m.color : undefined}
                shadowBlur={isSelected ? 10 / stageScale : 0}
                shadowOpacity={isSelected ? 0.5 : 0}
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
                  draggable={currentTool === 'pan'}
                  onDragStart={(e) => {
                    if (e.evt && e.evt.button !== 0) {
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

  return (
    <div ref={containerRef} className="w-full h-full bg-slate-100 overflow-hidden cursor-crosshair">
      {dimensions.width > 0 && dimensions.height > 0 && (
        <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          onWheel={handleWheel}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onDragEnd={(e) => {
            if (e.target === e.currentTarget) {
              setStagePos({ x: e.target.x(), y: e.target.y() });
            }
          }}
          draggable={currentTool === 'pan'}
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
            {renderRegions()}
            {renderMeasurements()}
            {renderActiveDrawing()}
          </Layer>
        </Stage>
      )}
    </div>
  );
};
