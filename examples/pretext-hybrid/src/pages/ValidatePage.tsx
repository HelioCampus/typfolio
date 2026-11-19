import { Shell } from '../Shell.tsx';
import { ValidateWorkbench } from '../validate/App.tsx';

export default function ValidatePage() {
  return (
    <Shell
      section="validate"
      eyebrow="Validation · veraPDF in WebAssembly"
      title="Check a PDF against PDF/UA and PDF/A, in your browser"
      lede="veraPDF, the reference validator for PDF/A and PDF/UA, compiled to WebAssembly. Drop PDF files below: they are read and validated on this page and are not uploaded anywhere. A pass means a file meets the rules of a standard that a machine can check; it does not show that a document is accessible."
    >
      <ValidateWorkbench />
    </Shell>
  );
}
