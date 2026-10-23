import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import '../../../fixtures/browser/demo-header.css';

interface ShellProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}

export function Shell({ eyebrow, title, lede, wide = false, children }: ShellProps) {
  return (
    <div className={wide ? 'shell shell--wide' : 'shell'}>
      <header className="topbar typfolio-header">
        <Link className="typfolio-brand" to="/" aria-label="Typfolio home">
          <span className="typfolio-mark" aria-hidden="true">T</span>
          <span><strong>Typfolio</strong><small>Live PDFs × pretext</small></span>
        </Link>
        <div className="topbar-actions">
          <nav aria-label="Demos">
            <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} end to="/">
              Variable ASCII
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} to="/editorial">
              Editorial engine
            </NavLink>
          </nav>
          <a className="typfolio-source" href="https://github.com/HelioCampus/typfolio" target="_blank" rel="noreferrer" aria-label="Typfolio on GitHub">GitHub ↗</a>
        </div>
      </header>
      <main>
        <section className="intro">
          <p className="kicker">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        {children}
      </main>
      <footer>
        pretext (MIT) lays out · Typst renders · Libertinus Serif (OFL) on both sides
      </footer>
    </div>
  );
}
