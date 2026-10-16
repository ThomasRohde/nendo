import { mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { Marked, type marked } from 'marked';
import { mediaUrl, parseMediaAddress } from './media-model';

/**
 * What the Markdown field's editor is made of (Tiptap, ADR-0017 amendment of 2026-10-16), apart
 * from the page: the extensions, the Markdown reader and writer, and the rule for a picture. Kept
 * free of the DOM so the round trip a stored value takes is tested in Node.
 *
 * The field still stores Markdown, and `markdown.ts` still draws it wherever it is read. The
 * editor is only how it is written: it reads the stored text into its document, and writes
 * Markdown back only when the person changes something, so a value nobody edits is never rewritten.
 */

/** Where the editor's pictures come from: the open file's media origin, and whether web pictures load. */
export interface EditorPictures {
  origin: string | null | undefined;
  loadWeb: boolean;
}

/**
 * Text is written as typed. Tiptap encodes &, < and > as entities, which `markdown.ts` (which
 * escapes HTML itself) would then show literally: "a & b" came back as "a &amp; b". Markdown's
 * own delimiters are still escaped, so a typed * stays a character.
 */
let textEncodingKept = false;
export function keepTextAsTyped(): void {
  if (textEncodingKept) return;
  textEncodingKept = true;
  const prototype = MarkdownManager.prototype as unknown as {
    encodeTextForMarkdown(this: { codeTypes: Set<string>; escapeMarkdownSyntax(text: string): string }, text: string,
      node: { marks?: Array<string | { type: string }> }, parentNode?: { type?: string }): string;
  };
  prototype.encodeTextForMarkdown = function (text, node, parentNode) {
    const inCode = (parentNode?.type != null && this.codeTypes.has(parentNode.type)) ||
      (node.marks ?? []).some((mark) => this.codeTypes.has(typeof mark === 'string' ? mark : mark.type));
    return inCode ? text : this.escapeMarkdownSyntax(text);
  };
}

/**
 * The Markdown reader: raw HTML is text, as `markdown.ts` shows it. Without this, `<b>x</b>` in a
 * stored value became bold in the editor and was written back as `**x**`.
 */
export function markdownReader(): typeof marked {
  const reader = new Marked();
  reader.use({ tokenizer: { html: () => undefined, tag: () => undefined } });
  // Tiptap types the instance as the global marked; it calls only what an instance has.
  return reader as unknown as typeof marked;
}

/**
 * A picture in the text: `![alt](address)`. Shown from the media origin when the address is a
 * picture's, as `markdown.ts` shows it; any other address stays its alt text, with the address as
 * its tooltip. The node keeps the address itself, so the Markdown written back names the picture
 * as it was named, never by the page's URL for it.
 */
export function pictureExtension(pictures: () => EditorPictures) {
  return Image.extend({
    parseHTML() {
      return [{ tag: 'img[data-media-address]', getAttrs: (element) => ({ src: (element as HTMLElement).dataset.mediaAddress, alt: element.getAttribute('alt') }) },
        { tag: 'img[src]' }];
    },
    renderHTML({ HTMLAttributes }) {
      const address = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
      const parsed = parseMediaAddress(address);
      const { origin, loadWeb } = pictures();
      const url = parsed === null ? null : mediaUrl(parsed, origin, loadWeb);
      if (url === null) return ['span', { class: 'markdown-image', title: address }, String(HTMLAttributes.alt ?? '')];
      return ['img', mergeAttributes(HTMLAttributes, { src: url, 'data-media-address': address, class: 'markdown-editor-picture', loading: 'lazy' })];
    },
  }).configure({ inline: true, allowBase64: false });
}

/** Every extension of the field's editor but the Markdown one, which the page adds. */
export function editorExtensions(pictures: () => EditorPictures): AnyExtension[] {
  return [
    StarterKit.configure({
      // Underline has no Markdown that markdown.ts reads, so it is not offered.
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, protocols: ['https', 'http', 'mailto'],
        isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url) },
    }),
    pictureExtension(pictures),
    TableKit.configure({ table: { resizable: false } }),
  ];
}

/** A reader and writer of the field's Markdown, outside any editor. */
export function markdownManager(pictures: () => EditorPictures = () => ({ origin: null, loadWeb: false })): MarkdownManager {
  keepTextAsTyped();
  return new MarkdownManager({ marked: markdownReader(), extensions: editorExtensions(pictures) });
}

/** The Markdown an editor's document writes: without the blank lines Tiptap puts around a table. */
export function writtenMarkdown(manager: MarkdownManager, document: JSONContent): string {
  return manager.serialize(document).replace(/^\n+|\n+$/g, '');
}

/** The commands the toolbar offers, in its order, with the shortcut Tiptap gives each. */
export const toolbarCommands = [
  { id: 'bold', label: 'Bold', keys: 'Ctrl B', glyph: 'B' },
  { id: 'italic', label: 'Italic', keys: 'Ctrl I', glyph: 'I' },
  { id: 'strike', label: 'Strikethrough', keys: 'Ctrl Shift S', glyph: 'S' },
  { id: 'code', label: 'Code', keys: 'Ctrl E', glyph: '</>' },
  { id: 'heading1', label: 'Heading', keys: 'Ctrl Alt 1', glyph: 'H1' },
  { id: 'heading2', label: 'Subheading', keys: 'Ctrl Alt 2', glyph: 'H2' },
  { id: 'bulletList', label: 'Bulleted list', keys: 'Ctrl Shift 8', glyph: '•' },
  { id: 'orderedList', label: 'Numbered list', keys: 'Ctrl Shift 7', glyph: '1.' },
  { id: 'blockquote', label: 'Quote', keys: 'Ctrl Shift B', glyph: '❝' },
  { id: 'codeBlock', label: 'Code block', keys: 'Ctrl Alt C', glyph: '{ }' },
  { id: 'link', label: 'Link', keys: '', glyph: '' },
] as const;

export type ToolbarCommandId = typeof toolbarCommands[number]['id'];
