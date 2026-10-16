// What the manuscript view's exports take from their dependencies, bundled into
// extensions/manuscript/vendor/export.js by bundle.mjs and loaded only when exporting.
export { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Footer, Header, PageNumber, SectionType } from 'docx';
export { default as JSZip } from 'jszip';
