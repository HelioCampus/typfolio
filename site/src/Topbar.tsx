import { Link } from '@tanstack/react-router';
import '../../fixtures/browser/demo-header.css';

export function Topbar({ section }: { readonly section: 'home' | 'pretext' | 'performance' | 'inspect' | 'validate' }) {
  return (
    <header className="topbar typfolio-header">
      <Link className="typfolio-brand" to="/">
        <span className="typfolio-mark" aria-hidden="true">T</span>
        <span><strong>Typfolio</strong><small>PDFs made and checked in the browser</small></span>
      </Link>
      <div className="topbar-actions">
        <nav aria-label="Demos">
          <Link activeProps={{ className: 'active' }} activeOptions={{ exact: true }} to="/">Overview</Link>
          <Link className={section === 'pretext' ? 'active' : undefined} aria-current={section === 'pretext' ? 'true' : undefined} to="/ascii">Pretext</Link>
          <Link activeProps={{ className: 'active' }} to="/performance">Worker batch</Link>
          <Link activeProps={{ className: 'active' }} to="/inspect">Inspect</Link>
          <Link activeProps={{ className: 'active' }} to="/validate">Validate</Link>
        </nav>
        <a className="typfolio-source" href="https://github.com/HelioCampus/typfolio" target="_blank" rel="noreferrer" aria-label="Typfolio on GitHub">GitHub ↗</a>
      </div>
    </header>
  );
}
