// src/components/ui/NumberInput.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NumberInput } from './NumberInput';

describe('NumberInput', () => {
  it('shows a faded 0 placeholder by default', () => {
    render(<NumberInput value="" onChange={() => {}} aria-label="n" />);
    expect(screen.getByLabelText('n')).toHaveAttribute('placeholder', '0');
  });

  it('does not report an empty value and restores the previous value on blur', () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} aria-label="n" />);
    const el = screen.getByLabelText('n') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '' } });
    expect(el.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(el);
    expect(el.value).toBe('5');
  });

  it('reports typed values', () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} aria-label="n" />);
    const el = screen.getByLabelText('n');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('allowEmpty reports clearing', () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} allowEmpty aria-label="n" />);
    const el = screen.getByLabelText('n');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
