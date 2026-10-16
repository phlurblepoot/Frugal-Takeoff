// src/components/ui/NumberInput.tsx
import React from 'react';
import { Input } from './Form';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> & {
  value: string | number;
  /** Pass true for optional numbers where an empty box is a real value. */
  allowEmpty?: boolean;
  /** Render a plain <input> with only `className` (for boxes with their own styling). */
  unstyled?: boolean;
};

/**
 * Number box that never writes a 0 on the user's behalf.
 * - Empty shows a faded "0" placeholder (override with `placeholder`).
 * - While the box is empty, onChange is not called, so the parent keeps the
 *   previous value; on blur the previous value is shown again.
 * - `allowEmpty` opts out: clearing is reported like a normal input.
 */
export const NumberInput = React.forwardRef<HTMLInputElement, Props>(
  ({ value, onChange, onFocus, onBlur, placeholder = '0', allowEmpty = false, unstyled = false, ...rest }, ref) => {
    const [draft, setDraft] = React.useState<string | null>(null);
    const shown = draft !== null ? draft : String(value);
    // Follow outside changes (e.g. Cancel resetting the form) while focused;
    // an empty draft is left alone so the box is not refilled mid-edit.
    React.useEffect(() => {
      setDraft(d => (d === null || d === '' || Number(d) === Number(value) ? d : String(value)));
    }, [value]);

    const Comp = unstyled ? 'input' : Input;
    return (
      <Comp
        ref={ref}
        type="number"
        {...rest}
        placeholder={placeholder}
        value={shown}
        onFocus={e => {
          setDraft(String(value));
          onFocus?.(e);
        }}
        onChange={e => {
          setDraft(e.target.value);
          if (e.target.value === '' && !allowEmpty) return;
          onChange?.(e);
        }}
        onBlur={e => {
          setDraft(null);
          onBlur?.(e);
        }}
      />
    );
  }
);
NumberInput.displayName = 'NumberInput';
