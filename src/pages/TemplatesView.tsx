import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, Layout, Hash, Ruler, Square } from 'lucide-react';
import { TakeoffTemplate, MeasurementType } from '../types';
import { getTemplates, saveTemplate, deleteTemplate } from '../utils/store';
import { v4 as uuidv4 } from 'uuid';

export const TemplatesView: React.FC = () => {
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TakeoffTemplate | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [type, setType] = useState<MeasurementType>('length');
  const [color, setColor] = useState('#3b82f6');
  const [unit, setUnit] = useState('');
  const [costPerUnit, setCostPerUnit] = useState<number | ''>('');
  const [laborPercent, setLaborPercent] = useState<number | ''>('');
  const [materialsPercent, setMaterialsPercent] = useState<number | ''>('');
  const [equipmentPercent, setEquipmentPercent] = useState<number | ''>('');
  const [profitPercent, setProfitPercent] = useState<number | ''>('');

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
    setLaborPercent('');
    setMaterialsPercent('');
    setEquipmentPercent('');
    setProfitPercent('');
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
    setCostPerUnit(template.costPerUnit ?? '');
    setLaborPercent(template.laborPercent ?? '');
    setMaterialsPercent(template.materialsPercent ?? '');
    setEquipmentPercent(template.equipmentPercent ?? '');
    setProfitPercent(template.profitPercent ?? '');
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
      costPerUnit: costPerUnit !== '' ? Number(costPerUnit) : undefined,
      laborPercent: laborPercent !== '' ? Number(laborPercent) : undefined,
      materialsPercent: materialsPercent !== '' ? Number(materialsPercent) : undefined,
      equipmentPercent: equipmentPercent !== '' ? Number(equipmentPercent) : undefined,
      profitPercent: profitPercent !== '' ? Number(profitPercent) : undefined,
      createdAt: editingTemplate?.createdAt || Date.now(),
    };

    await saveTemplate(template);
    setShowModal(false);
    loadTemplates();
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this template?')) {
      await deleteTemplate(id);
      loadTemplates();
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
          <h2 className="text-xl font-semibold text-slate-900">Takeoff Templates</h2>
          <p className="text-sm text-slate-500">Pre-defined takeoff types for quick project setup</p>
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
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center shadow-sm">
          <Layout size={48} className="mx-auto text-slate-300 mb-4" />
          <h3 className="text-lg font-medium text-slate-900 mb-2">No templates yet</h3>
          <p className="text-slate-500 mb-6">Create templates to reuse takeoff settings across projects.</p>
          <button
            onClick={handleCreateClick}
            className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Plus size={18} />
            Create Template
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(template => (
            <div key={template.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm hover:border-blue-300 transition-colors group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div 
                    className="w-4 h-4 rounded-full shadow-inner" 
                    style={{ backgroundColor: template.color }}
                  />
                  <h3 className="font-semibold text-slate-900">{template.name}</h3>
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
                <div className="text-slate-500 flex items-center gap-1">
                  {getTypeIcon(template.type)}
                  <span className="capitalize">{template.type}</span>
                </div>
                <div className="text-slate-900 font-medium text-right">
                  {template.unit || 'Default'}
                </div>
                <div className="text-slate-500">Cost/Unit</div>
                <div className="text-slate-900 font-medium text-right">
                  {template.costPerUnit ? `$${template.costPerUnit.toFixed(2)}` : '-'}
                </div>
              </div>

              {(template.laborPercent || template.materialsPercent || template.equipmentPercent || template.profitPercent) && (
                <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap gap-2">
                  {template.laborPercent && (
                    <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                      L: {template.laborPercent}%
                    </span>
                  )}
                  {template.materialsPercent && (
                    <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                      M: {template.materialsPercent}%
                    </span>
                  )}
                  {template.equipmentPercent && (
                    <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                      E: {template.equipmentPercent}%
                    </span>
                  )}
                  {template.profitPercent && (
                    <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-[10px] font-medium">
                      P: {template.profitPercent}%
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">
                {editingTemplate ? 'Edit Template' : 'Create Template'}
              </h3>
            </div>
            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Template Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Measurement Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as MeasurementType)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="length">Length</option>
                    <option value="area">Area</option>
                    <option value="count">Count</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-slate-300 p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unit</label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Cost Per Unit ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={costPerUnit}
                    onChange={(e) => setCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Labor %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={laborPercent}
                    onChange={(e) => setLaborPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Materials %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={materialsPercent}
                    onChange={(e) => setMaterialsPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Equip %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={equipmentPercent}
                    onChange={(e) => setEquipmentPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Profit %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={profitPercent}
                    onChange={(e) => setProfitPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
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
