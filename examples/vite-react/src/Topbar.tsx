import { Link, NavLink } from 'react-router-dom';

interface TopbarProps {
  readonly clientBadge: string;
  readonly executionBadge: string;
}

export function Topbar({ clientBadge, executionBadge }: TopbarProps) {
  return (
    <header className="topbar">
      <Link className="brand" to="/" aria-label="Typfolio home">
        <span className="brand-mark">T</span>
        <span>
          <strong>Typfolio</strong>
          <small>Document workspace</small>
        </span>
      </Link>
      <div className="topbar-actions">
        <nav className="runtime-nav" aria-label="Compiler examples">
          <NavLink className={({ isActive }) => isActive ? 'active' : undefined} end to="/">
            Direct
          </NavLink>
          <NavLink className={({ isActive }) => isActive ? 'active' : undefined} to="/workers">
            Workers
          </NavLink>
          <NavLink className={({ isActive }) => isActive ? 'active' : undefined} to="/charts">
            Charts
          </NavLink>
        </nav>
        <div className="runtime-badges" aria-label="Runtime details">
          <span className="badge badge--live"><i /> Client ready</span>
          <span className="badge">{clientBadge}</span>
          <span className="badge">{executionBadge}</span>
        </div>
      </div>
    </header>
  );
}
