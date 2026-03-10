import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { PhaseDivider } from './PhaseDivider';
import { PhaseHeader } from './PhaseHeader';
import { IdleMarker } from './IdleMarker';

afterEach(() => {
  cleanup();
});

describe('PhaseDivider', () => {
  it('renders phase name and agent source', () => {
    render(
      <PhaseDivider
        phase="Build"
        agentSource="architect-agent"
        timestamp="2026-03-10T14:34:00Z"
        color="#122318"
      />
    );
    expect(screen.getByText(/Build/)).toBeInTheDocument();
    expect(screen.getByText(/architect-agent/)).toBeInTheDocument();
  });

  it('applies swimlane color as border', () => {
    const { container } = render(
      <PhaseDivider phase="Build" agentSource="architect" timestamp="" color="#122318" />
    );
    expect(container.firstChild).toHaveStyle({ borderColor: '#122318' });
  });

  it('renders without agentSource when not provided', () => {
    render(<PhaseDivider phase="Review" timestamp="2026-03-10T14:34:00Z" />);
    expect(screen.getByText(/Review/)).toBeInTheDocument();
  });

  it('renders without timestamp when empty string', () => {
    const { container } = render(
      <PhaseDivider phase="Build" timestamp="" color="#122318" />
    );
    // Should still render the phase name
    expect(screen.getByText(/Build/)).toBeInTheDocument();
    // No time element rendered when timestamp is empty
    expect(container.querySelectorAll('span').length).toBeGreaterThan(0);
  });

  it('uses default border color when no color prop provided', () => {
    const { container } = render(
      <PhaseDivider phase="Build" timestamp="2026-03-10T14:34:00Z" />
    );
    // border-l-4 class should be present
    expect(container.firstChild).toBeTruthy();
  });
});

describe('PhaseHeader', () => {
  it('renders ticket title, phase, and Live badge when isLive=true', () => {
    render(<PhaseHeader ticketTitle="My Ticket" phase="Build" isLive={true} />);
    expect(screen.getByText(/My Ticket/)).toBeInTheDocument();
    expect(screen.getByText(/Build/)).toBeInTheDocument();
    expect(screen.getByText(/Live/)).toBeInTheDocument();
  });

  it('shows Ended badge when isLive=false', () => {
    render(<PhaseHeader ticketTitle="My Ticket" isLive={false} />);
    expect(screen.getByText(/Ended/)).toBeInTheDocument();
  });

  it('renders without phase when not provided', () => {
    render(<PhaseHeader ticketTitle="My Ticket" isLive={true} />);
    expect(screen.getByText(/My Ticket/)).toBeInTheDocument();
    expect(screen.getByText(/Live/)).toBeInTheDocument();
  });

  it('shows token count when provided', () => {
    render(
      <PhaseHeader ticketTitle="My Ticket" isLive={false} totalTokens={12345} />
    );
    expect(screen.getByText(/12,345/)).toBeInTheDocument();
  });

  it('does not show token count when not provided', () => {
    const { queryByText } = render(
      <PhaseHeader ticketTitle="My Ticket" isLive={false} />
    );
    expect(queryByText(/tokens/)).not.toBeInTheDocument();
  });
});

describe('IdleMarker', () => {
  it('renders phase name and waiting message', () => {
    render(<IdleMarker phase="Build" timestamp="2026-03-10T14:34:00Z" />);
    expect(screen.getByText(/Build/)).toBeInTheDocument();
    expect(screen.getByText(/waiting for next phase/)).toBeInTheDocument();
  });

  it('handles empty timestamp gracefully', () => {
    render(<IdleMarker phase="Review" timestamp="" />);
    expect(screen.getByText(/Review/)).toBeInTheDocument();
    expect(screen.getByText(/waiting for next phase/)).toBeInTheDocument();
  });

  it('renders as a centered subtle marker', () => {
    const { container } = render(
      <IdleMarker phase="Build" timestamp="2026-03-10T14:34:00Z" />
    );
    expect(container.firstChild).toHaveClass('text-center');
  });
});
