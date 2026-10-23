import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import '../../../fixtures/browser/demo-header.css';

interface ShellProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
  readonly wide?: boolean;
  readonly section?: 'pretext' | 'performance';
  readonly children: ReactNode;
}

export function Shell({ eyebrow, title, lede, wide = false, section = 'pretext', children }: ShellProps) {
  return (
    <div className={wide ? 'shell shell--wide' : 'shell'}>
      <header className="topbar typfolio-header">
        <Link className="typfolio-brand" to="/" aria-label="Typfolio home">
          <span className="typfolio-mark" aria-hidden="true">T</span>
          <span><strong>Typfolio</strong><small>Browser PDF demos</small></span>
        </Link>
        <div className="topbar-actions">
          <nav aria-label="Demos">
            <Link className={section === 'pretext' ? 'active' : undefined} aria-current={section === 'pretext' ? 'true' : undefined} to="/">
              Pretext
            </Link>
            <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} to="/performance">
              Worker batch
            </NavLink>
          </nav>
          <a className="typfolio-source" href="https://github.com/HelioCampus/typfolio" target="_blank" rel="noreferrer" aria-label="Typfolio on GitHub">GitHub ↗</a>
        </div>
      </header>
      <main>
        <section className="intro">
          {section === 'pretext' ? (
            <nav className="pretext-nav" aria-label="Pretext examples">
              <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} end to="/">Variable ASCII</NavLink>
              <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} to="/editorial">Editorial engine</NavLink>
            </nav>
          ) : null}
          <p className="kicker">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </section>
        {children}
      </main>
      <footer>
        {section === 'pretext'
          ? 'pretext (MIT) lays out · Typst renders · Libertinus Serif (OFL) on both sides'
          : 'Typst renders · Web Workers compile · Synthetic data stays in your browser'}
      </footer>
    </div>
  );
}
