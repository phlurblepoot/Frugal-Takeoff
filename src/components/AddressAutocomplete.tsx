import React from 'react';

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const AddressAutocomplete: React.FC<AddressAutocompleteProps> = ({
  value,
  onChange,
  placeholder = 'Enter address',
  disabled = false,
  className = '',
}) => {
  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="street-address"
        className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
      />
    </div>
  );
};
