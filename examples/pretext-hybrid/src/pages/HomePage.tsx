import { Link } from '@tanstack/react-router';
import { Topbar } from '../Topbar.tsx';
import './home.css';

export default function HomePage() {
  return (
    <div className="shell home">
      <Topbar section="home" />
      <main>
        <section className="home-hero" aria-labelledby="home-title">
          <div>
            <p className="kicker">Typst × TypeScript</p>
            <h1 id="home-title">Compile PDFs in&nbsp;your&nbsp;browser.<br /><em>Accessible, typed&nbsp;and&nbsp;<span className="home-fast">fast</span>.</em></h1>
            <p className="home-lede">A Typst template and typed data in, a tagged PDF out. Typst runs as WASM in the page, so there is no PDF server and nothing is uploaded.</p>
            <div className="home-actions">
              <a className="home-cta" href="#demos">Explore the demos <span aria-hidden="true">↓</span></a>
              <a className="home-docs" href="https://github.com/HelioCampus/typfolio#readme" target="_blank" rel="noreferrer">Read the docs <span aria-hidden="true">↗</span></a>
            </div>
            <p className="home-detail">Typst compiled to WASM · Also runs in Node</p>
          </div>
          <figure className="home-document">
            <div className="home-paper" aria-hidden="true">
              <div className="home-paper-masthead"><span>Typfolio</span><span>01 / 01</span></div>
              <p className="home-paper-overline">From source to page</p>
              <p className="home-paper-title">Good documents<br />have structure.</p>
              <p className="home-paper-copy">Headings that mean something.<br />Tables that keep their meaning.<br />Typography that does the rest.</p>
              <div className="home-paper-table">
                <span>Template</span><span>main.typ</span>
                <span>Input</span><span>Typed data</span>
                <span>Output</span><span>Tagged PDF</span>
              </div>
              <div className="home-paper-footer"><span>Made in your browser</span><span>T</span></div>
            </div>
            <figcaption><code>.typ</code><span>+</span><code>data</code><span>→</span><code>PDF</code></figcaption>
          </figure>
        </section>

        <section className="home-story" aria-labelledby="why-title">
          <div>
            <p className="kicker">Why it exists</p>
            <h2 id="why-title">Meaning belongs<br />in the source.</h2>
          </div>
          <div>
            <p>We needed PDFs that meet accessibility standards and that screen readers can actually use. A screen reader needs a file that says which text is a heading, which is a table, and in what order to read it. The JavaScript PDF libraries we used only draw, so we kept patching the finished files, and every new requirement became another patch. That was not a path we could maintain. Typst keeps the meaning while it lays out the page, so the PDF has it from the start, and the template is the only thing left to maintain.</p>
            <p>It ran on a server first, and was fast enough that the server was the only overhead left. Now it runs as WASM in the page, and Typfolio adds what we had to build around it: <strong>typed data, editor completion and template checks</strong>, so a changed field fails the build, not the user.</p>
          </div>
        </section>

        <section className="home-demos" id="demos" aria-labelledby="demos-title">
          <div className="home-section-heading">
            <div><p className="kicker">Try it yourself</p><h2 id="demos-title">Three demos. Compiled here.</h2></div>
            <p>Everything runs in your browser.</p>
          </div>
          <div className="home-demo-grid">
            <Link className="home-demo home-demo--featured" to="/performance" aria-labelledby="batch-title">
              <div className="home-demo-label"><span>Performance</span><span aria-hidden="true">01</span></div>
              <h3 id="batch-title">1000 PDFs, one browser.</h3>
              <p>Generate a batch on Web Workers. Compare pool sizes, watch throughput, and open every result.</p>
              <span className="home-demo-open">Run the benchmark <span aria-hidden="true">↗</span></span>
            </Link>
            <Link className="home-demo" to="/ascii" aria-labelledby="ascii-title">
              <div className="home-demo-label"><span>Pretext · Live rendering</span><span aria-hidden="true">02</span></div>
              <h3 id="ascii-title">Type in motion.</h3>
              <p>Move your pointer through proportional ASCII art, compiled into a fresh PDF as it animates.</p>
              <span className="home-demo-open">Explore variable ASCII <span aria-hidden="true">↗</span></span>
            </Link>
            <Link className="home-demo" to="/editorial" aria-labelledby="editorial-title">
              <div className="home-demo-label"><span>Pretext · Live layout</span><span aria-hidden="true">03</span></div>
              <h3 id="editorial-title">A page that flows.</h3>
              <p>Drag the orbs and watch columns of text find their way around them, right inside the PDF preview.</p>
              <span className="home-demo-open">Open the editorial engine <span aria-hidden="true">↗</span></span>
            </Link>
          </div>
        </section>
      </main>
      <footer className="home-footer"><span>Typfolio · Typed data. Typeset documents.</span><span>Open source · Apache-2.0</span></footer>
    </div>
  );
}
