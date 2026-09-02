// src/components/ui/Modal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
  // Focus management (Plan 3 Task 10 a11y pass). Before this, opening a modal
  // left focus behind it, so Tab walked the page underneath the overlay.
  describe('focus management', () => {
    it('moves focus into the dialog when it opens', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi">
          <input aria-label="Name" />
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.body.contains(document.activeElement)).toBe(true);
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });

    it('leaves an already-focused field inside the dialog alone', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi">
          <input aria-label="Name" autoFocus />
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    });

    it('wraps Tab from the last focusable back to the first', async () => {
      render(
        <Modal open onClose={() => {}} title="Hi" footer={<button>Send</button>}>
          <input aria-label="Name" />
        </Modal>
      );
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      const close = screen.getByRole('button', { name: 'Close dialog' });
      const send = screen.getByRole('button', { name: 'Send' });
      send.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(send);
    });

    it('restores focus to the opener when it closes', async () => {
      const opener = document.createElement('button');
      document.body.appendChild(opener);
      opener.focus();
      const { rerender } = render(<Modal open onClose={() => {}} title="Hi">body</Modal>);
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.activeElement).not.toBe(opener);
      rerender(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>);
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });
  });
});
