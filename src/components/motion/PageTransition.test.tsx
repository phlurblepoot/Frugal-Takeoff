import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { PageTransition, pageKey } from './PageTransition';

describe('pageKey', () => {
  it('keys on the first two path segments so section/tab changes do not re-enter', () => {
    expect(pageKey('/dashboard')).toBe('dashboard');
    expect(pageKey('/project/abc/billing')).toBe('project/abc');
    expect(pageKey('/project/abc/issues')).toBe('project/abc');
    expect(pageKey('/')).toBe('root');
  });

  it('canvas routes share the project key (no page transition into canvas)', () => {
    expect(pageKey('/project/abc/page/p1')).toBe('project/abc');
  });
});

describe('PageTransition', () => {
  it('renders children', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <PageTransition><p>content</p></PageTransition>
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('renders children without a motion wrapper when reduced motion is on', () => {
    localStorage.setItem('theme-motion', 'reduced');
    const { container } = render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <PageTransition><p data-testid="c">content</p></PageTransition>
        </MemoryRouter>
      </ThemeProvider>
    );
    // With reduced motion the child is a direct child of the fragment (no wrapper div).
    expect(container.querySelector('[data-page-transition]')).toBeNull();
    localStorage.removeItem('theme-motion');
  });
});
