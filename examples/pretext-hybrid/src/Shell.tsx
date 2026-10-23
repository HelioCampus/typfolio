import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Topbar } from './Topbar.tsx';

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
      <Topbar section={section} />
      <main>
        <section className="intro">
          {section === 'pretext' ? (
            <nav className="pretext-nav" aria-label="Pretext examples">
              <Link activeProps={{ className: 'active' }} to="/ascii">Variable ASCII</Link>
              <Link activeProps={{ className: 'active' }} to="/editorial">Editorial engine</Link>
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
