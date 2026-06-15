// src/components/ui/Modal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, body, and footer when open', () => {
    render(
      <Modal open onClose={() => {}} title="Send proposal" footer={<button>Send</button>}>
        body text
      </Modal>
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Send proposal' })).toBeInTheDocument();
    expect(screen.getByText('body text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">body</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on overlay click but not on panel click', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">body</Modal>);
    fireEvent.click(screen.getByText('body')); // inside the panel
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
