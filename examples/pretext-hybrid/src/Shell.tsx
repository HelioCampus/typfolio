import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

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
      <header className="topbar">
        <span className="brand"><i>T</i> Typfolio <small>× pretext</small></span>
        <nav aria-label="Demos">
          <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} end to="/">
            Variable ASCII
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'active' : undefined)} to="/editorial">
            Editorial engine
          </NavLink>
        </nav>
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
