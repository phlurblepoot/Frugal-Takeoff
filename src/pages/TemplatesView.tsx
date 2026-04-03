import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, Layout, Hash, Ruler, Square } from 'lucide-react';
import { TakeoffTemplate, MeasurementType, CustomCost, CostType } from '../types';
import { getTemplates, saveTemplate, deleteTemplate } from '../utils/store';
import { v4 as uuidv4 } from 'uuid';
import { evaluateMathExpression, UNIT_LABELS } from '../utils/math';

const CustomCostRow: React.FC<{
  item: any;
  index: number;
  unitLabel: string;
  onChange: (index: number, updated: any) => void;
  onRemove: (index: number) => void;
}> = ({ item, index, unitLabel, onChange, onRemove }) => {
  return (
    <div className="flex flex-col gap-2 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-sm">
      <div className="flex gap-2 items-center">
        <select
          value={item.type || 'unit'}
          onChange={(e) => {
            const type = e.target.value as CostType;
            onChange(index, { ...item, type });
          }}
          className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50 font-medium dark:bg-slate-800/50 dark:border-slate-600 dark:text-white"
        >
          <option value="flat">Flat Cost</option>
          <option value="yield">Cost by Yield</option>
          <option value="unit">Cost per {unitLabel}</option>
          <option value="amount_per_units">Amount per {unitLabel}s</option>
        </select>
        <div className="flex-1">
          <input
            type="text"
            value={item.name}
            onChange={(e) => onChange(index, { ...item, name: e.target.value })}
            placeholder="Item Name (e.g. Labor, Waste)"
            className="w-full text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
          />
        </div>
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex gap-3 items-center pl-1">
        {(!item.type || item.type === 'unit') && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Cost per {unitLabel}</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
              <input
                type="text"
                value={item.costPerUnit || ''}
                onChange={(e) => onChange(index, { ...item, costPerUnit: e.target.value })}
                onBlur={() => {
                  if (item.costPerUnit?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.costPerUnit.toString());
                    if (result !== null) onChange(index, { ...item, costPerUnit: result.toString() });
                  }
                }}
                className="w-24 pl-5 pr-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                placeholder="0.00"
              />
            </div>
          </div>
        )}

        {item.type === 'flat' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Flat Cost</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
              <input
                type="text"
                value={item.cost || ''}
                onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                onBlur={() => {
                  if (item.cost?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.cost.toString());
                    if (result !== null) onChange(index, { ...item, cost: result.toString() });
                  }
                }}
                className="w-24 pl-5 pr-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                placeholder="0.00"
              />
            </div>
          </div>
        )}

        {item.type === 'yield' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Cost</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                <input
                  type="text"
                  value={item.cost || ''}
                  onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                  onBlur={() => {
                    if (item.cost?.toString().startsWith('=')) {
                      const result = evaluateMathExpression(item.cost.toString());
                      if (result !== null) onChange(index, { ...item, cost: result.toString() });
                    }
                  }}
                  className="w-20 pl-5 pr-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Yield (per {unitLabel})</span>
              <input
                type="text"
                value={item.yield || ''}
                onChange={(e) => onChange(index, { ...item, yield: e.target.value })}
                onBlur={() => {
                  if (item.yield?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.yield.toString());
                    if (result !== null) onChange(index, { ...item, yield: result.toString() });
                  }
                }}
                className="w-20 px-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="1.0"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 px-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </>
        )}

        {item.type === 'amount_per_units' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Amount</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                <input
                  type="text"
                  value={item.amount || ''}
                  onChange={(e) => onChange(index, { ...item, amount: e.target.value })}
                  onBlur={() => {
                    if (item.amount?.toString().startsWith('=')) {
                      const result = evaluateMathExpression(item.amount.toString());
                      if (result !== null) onChange(index, { ...item, amount: result.toString() });
                    }
                  }}
                  className="w-20 pl-5 pr-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Per</span>
              <input
                type="text"
                value={item.perUnits || ''}
                onChange={(e) => onChange(index, { ...item, perUnits: e.target.value })}
                onBlur={() => {
                  if (item.perUnits?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.perUnits.toString());
                    if (result !== null) onChange(index, { ...item, perUnits: result.toString() });
                  }
                }}
                className="w-16 px-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="1"
              />
              <span className="text-[10px] font-bold text-slate-400 uppercase">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 px-2 py-1 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const TemplatesView: React.FC = () => {
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TakeoffTemplate | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [type, setType] = useState<MeasurementType>('length');
  const [color, setColor] = useState('#3b82f6');
  const [unit, setUnit] = useState('');
  const [costPerUnit, setCostPerUnit] = useState<string>('');
  const [isAdvancedCost, setIsAdvancedCost] = useState(false);
  const [customCosts, setCustomCosts] = useState<any[]>([]);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setIsLoading(true);
    const data = await getTemplates();
    setTemplates(data);
    setIsLoading(false);
  };

  const resetForm = () => {
    setName('');
    setType('length');
    setColor('#3b82f6');
    setUnit('');
    setCostPerUnit('');
    setIsAdvancedCost(false);
    setCustomCosts([]);
    setEditingTemplate(null);
  };

  const handleCreateClick = () => {
    resetForm();
    setShowModal(true);
  };

  const handleEditClick = (template: TakeoffTemplate) => {
    setEditingTemplate(template);
    setName(template.name);
    setType(template.type);
    setColor(template.color);
    setUnit(template.unit || '');
    setCostPerUnit(template.costPerUnit?.toString() || '');
    setIsAdvancedCost(template.isAdvancedCost || false);
    setCustomCosts(template.customCosts?.map(c => ({
      ...c,
      costPerUnit: c.costPerUnit?.toString() || '0',
      cost: c.cost?.toString() || '0',
      yield: c.yield?.toString() || '1',
      amount: c.amount?.toString() || '0',
      perUnits: c.perUnits?.toString() || '1'
    })) || []);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!name) return;

    const template: TakeoffTemplate = {
      id: editingTemplate?.id || uuidv4(),
      name,
      type,
      color,
      unit: unit || undefined,
      costPerUnit: !isAdvancedCost && costPerUnit !== '' ? (evaluateMathExpression(costPerUnit) ?? 0) : undefined,
      isAdvancedCost,
      customCosts: isAdvancedCost ? customCosts.map(c => ({
        ...c,
        costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '0') ?? 0,
        cost: evaluateMathExpression(c.cost?.toString() || '0') ?? 0,
        yield: evaluateMathExpression(c.yield?.toString() || '1') ?? 1,
        amount: evaluateMathExpression(c.amount?.toString() || '0') ?? 0,
        perUnits: evaluateMathExpression(c.perUnits?.toString() || '1') ?? 1
      })) : undefined,
      createdAt: editingTemplate?.createdAt || Date.now(),
    };

    await saveTemplate(template);
    setShowModal(false);
    loadTemplates();
  };

  const handleDelete = (id: string) => {
    setTemplateToDelete(id);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (templateToDelete) {
      await deleteTemplate(templateToDelete);
      loadTemplates();
      setShowDeleteConfirm(false);
      setTemplateToDelete(null);
    }
  };

  const getTypeIcon = (type: MeasurementType) => {
    switch (type) {
      case 'length': return <Ruler size={16} />;
      case 'area': return <Square size={16} />;
      case 'count': return <Hash size={16} />;
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Takeoff Templates</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Pre-defined takeoff types for quick project setup</p>
        </div>
        <button
          onClick={handleCreateClick}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors shadow-sm"
        >
          <Plus size={18} />
          New Template
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-12 text-center shadow-sm">
          <Layout size={48} className="mx-auto text-slate-300 mb-4" />
          <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2">No templates yet</h3>
          <p className="text-slate-500 dark:text-slate-400 mb-6">Create templates to reuse takeoff settings across projects.</p>
          <button
            onClick={handleCreateClick}
            className="inline-flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/20 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Plus size={18} />
            Create Template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(template => (
            <div key={template.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm hover:border-blue-300 transition-colors group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div 
                    className="w-4 h-4 rounded-full shadow-inner" 
                    style={{ backgroundColor: template.color }}
                  />
                  <h3 className="font-semibold text-slate-900 dark:text-white">{template.name}</h3>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => handleEditClick(template)}
                    className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button 
                    onClick={() => handleDelete(template.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-y-2 text-xs">
                <div className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                  {getTypeIcon(template.type)}
                  <span className="capitalize">{template.type}</span>
                </div>
                <div className="text-slate-900 dark:text-white font-medium text-right">
                  {template.unit || 'Default'}
                </div>
                <div className="text-slate-500 dark:text-slate-400">Cost/Unit</div>
                <div className="text-slate-900 dark:text-white font-medium text-right">
                  {template.isAdvancedCost && template.customCosts 
                    ? `$${template.customCosts.reduce((sum, c) => sum + (c.costPerUnit || 0), 0).toFixed(2)}`
                    : template.costPerUnit ? `$${template.costPerUnit.toFixed(2)}` : '-'}
                </div>
              </div>

              {template.isAdvancedCost && template.customCosts && template.customCosts.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700">
                  <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">Custom Costs</div>
                  <div className="space-y-1">
                    {template.customCosts.map(c => (
                      <div key={c.id} className="flex justify-between text-[10px]">
                        <span className="text-slate-600 dark:text-slate-400 truncate mr-2">{c.name}</span>
                        <span className="text-slate-900 dark:text-white font-medium">${c.costPerUnit.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Delete Template</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600 dark:text-slate-400">
                Are you sure you want to delete this template? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setTemplateToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Template
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                {editingTemplate ? 'Edit Template' : 'Create Template'}
              </h3>
            </div>
            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Template Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Measurement Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as MeasurementType)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-800/50 dark:border-slate-600 dark:text-white"
                  >
                    <option value="length">Length</option>
                    <option value="area">Area</option>
                    <option value="count">Count</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-slate-300 dark:border-slate-600 p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Unit</label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-800/50 dark:border-slate-600 dark:text-white"
                  >
                    <option value="">Default (Scale Unit)</option>
                    {type === 'length' && (
                      <>
                        <option value="in">Inches (in)</option>
                        <option value="ft">Feet (ft)</option>
                        <option value="yd">Yards (yd)</option>
                        <option value="cm">Centimeters (cm)</option>
                        <option value="m">Meters (m)</option>
                      </>
                    )}
                    {type === 'area' && (
                      <>
                        <option value="sqin">Square Inches (sq in)</option>
                        <option value="sqft">Square Feet (sq ft)</option>
                        <option value="sqyd">Square Yards (sq yd)</option>
                        <option value="sqcm">Square Centimeters (sq cm)</option>
                        <option value="sqm">Square Meters (sq m)</option>
                      </>
                    )}
                    {type === 'count' && (
                      <option value="each">Each</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Cost Per Unit ($)</label>
                  <input
                    type="text"
                    disabled={isAdvancedCost}
                    value={isAdvancedCost ? '' : costPerUnit}
                    onChange={(e) => setCostPerUnit(e.target.value)}
                    onBlur={() => {
                      if (costPerUnit.startsWith('=')) {
                        const result = evaluateMathExpression(costPerUnit);
                        if (result !== null) setCostPerUnit(result.toString());
                      }
                    }}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400 dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                    placeholder={isAdvancedCost ? "Disabled in Advanced" : "0.00 or =95*40%"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  type="checkbox"
                  id="isAdvancedCost"
                  checked={isAdvancedCost}
                  onChange={(e) => setIsAdvancedCost(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                />
                <label htmlFor="isAdvancedCost" className="text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isAdvancedCost && (
                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Advanced Costing</h4>
                    <button
                      onClick={() => setCustomCosts([...customCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: '0' }])}
                      className="text-[10px] flex items-center gap-1 text-blue-600 hover:text-blue-700 font-bold uppercase tracking-tight"
                    >
                      <Plus size={12} />
                      Add Cost Item
                    </button>
                  </div>
                  <div className="space-y-3">
                    {customCosts.map((cost, idx) => (
                      <CustomCostRow
                        key={cost.id}
                        item={cost}
                        index={idx}
                        unitLabel={UNIT_LABELS[unit as keyof typeof UNIT_LABELS] || unit || 'unit'}
                        onChange={(index, updated) => {
                          const newCosts = [...customCosts];
                          newCosts[index] = updated;
                          setCustomCosts(newCosts);
                        }}
                        onRemove={(index) => {
                          setCustomCosts(customCosts.filter((_, i) => i !== index));
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!name}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                {editingTemplate ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
