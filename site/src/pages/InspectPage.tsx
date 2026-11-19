import { CompilerBoundary } from '../CompilerBoundary.tsx';
import { Shell } from '../Shell.tsx';
import { InspectWorkbench } from '../inspect/App.tsx';

export default function InspectPage() {
  return (
    <Shell
      section="inspect"
      wide
      eyebrow="Accessibility · tags and validation"
      title="See what a screen reader gets, and who notices when it is missing"
      lede="One document, compiled on this page. Beside it are its tags as a screen reader reads them, what a screen reader user would trip over, and veraPDF's verdict against the standard. Take a piece of structure away and watch who notices: the compiler refuses some, the warnings catch some that the standard accepts, and some only a person reading the tags would catch."
    >
      <CompilerBoundary label="Loading the compiler…">
        {(_fonts, client) => <InspectWorkbench client={client} />}
      </CompilerBoundary>
    </Shell>
  );
}
