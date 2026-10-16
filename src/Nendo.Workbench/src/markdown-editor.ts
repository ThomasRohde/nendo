import { Editor } from '@tiptap/core';
import { Markdown, type MarkdownManager } from '@tiptap/markdown';
import { fileScopedClearable } from './app-state';
import { icon } from './icons';
import { editorExtensions, keepTextAsTyped, markdownReader, toolbarCommands, writtenMarkdown, type EditorPictures, type ToolbarCommandId } from './markdown-editor-kit';

/**
 * The Markdown field's editor on a record page (Tiptap; ADR-0017's amendment of 2026-10-16). The
 * field's control is still its textarea, which holds the Markdown the form saves: the editor reads
 * it, and writes it back, with an input event, only when the person changes the text. The
 * textarea stays reachable under Markdown for anyone who would rather type the source, and an
 * edit there is shown in the editor. Loaded only on a page that has a Markdown field.
 */

const editors = new WeakMap<HTMLTextAreaElement, Editor>();
const mounted = new Set<Editor>();
// Another file's page is gone with its editors, which are given up rather than kept listening.
fileScopedClearable({ clear(): void { for (const editor of mounted) editor.destroy(); mounted.clear(); } });

/** Shows the textarea's Markdown in its editor without counting it as the person's edit. */
export function showSourceInEditor(source: HTMLTextAreaElement): void {
  editors.get(source)?.commands.setContent(source.value, { contentType: 'markdown', emitUpdate: false });
}

/** Gives up the editors of pages no longer on screen, whose views still listen to the document. */
function releaseDetached(): void {
  for (const editor of mounted) {
    if (editor.view.dom.isConnected) continue;
    editor.destroy();
    mounted.delete(editor);
  }
}

const toolbarMarkup = (fieldName: string): string => `<div class="markdown-toolbar" role="toolbar" aria-label="Format ${fieldName}">${
  toolbarCommands.map(command => `<button type="button" class="markdown-tool" data-markdown-command="${command.id}" aria-pressed="false" title="${command.label}${command.keys ? ` (${command.keys})` : ''}" aria-label="${command.label}">${
    command.id === 'link' ? icon('link') : command.id === 'code' ? icon('code') : `<span aria-hidden="true">${command.glyph}</span>`}</button>`).join('')}</div>
  <div class="markdown-link-form" data-markdown-link-form hidden>
    <label>Link address<input type="url" inputmode="url" placeholder="https://…" data-markdown-link-input /></label>
    <button type="button" class="primary-button" data-markdown-link="apply">Link</button>
    <button type="button" class="secondary-button" data-markdown-link="remove">Remove link</button>
    <button type="button" class="text-button" data-markdown-link="cancel">Cancel</button>
    <p class="markdown-link-error" data-markdown-link-error hidden>A link is an address that starts with https://, http:// or mailto:.</p>
  </div>`;

const isActive = (editor: Editor, id: ToolbarCommandId): boolean => {
  switch (id) {
    case 'heading1': return editor.isActive('heading', { level: 1 });
    case 'heading2': return editor.isActive('heading', { level: 2 });
    default: return editor.isActive(id);
  }
};

function run(editor: Editor, id: Exclude<ToolbarCommandId, 'link'>): void {
  const chain = editor.chain().focus();
  switch (id) {
    case 'bold': chain.toggleBold(); break;
    case 'italic': chain.toggleItalic(); break;
    case 'strike': chain.toggleStrike(); break;
    case 'code': chain.toggleCode(); break;
    case 'heading1': chain.toggleHeading({ level: 1 }); break;
    case 'heading2': chain.toggleHeading({ level: 2 }); break;
    case 'bulletList': chain.toggleBulletList(); break;
    case 'orderedList': chain.toggleOrderedList(); break;
    case 'blockquote': chain.toggleBlockquote(); break;
    case 'codeBlock': chain.toggleCodeBlock(); break;
  }
  chain.run();
}

/**
 * Puts an editor in place of the drawn text of every Markdown field in the form, once each. A
 * field whose control is disabled, as on a file that cannot be changed, gets one that only reads.
 */
export function mountMarkdownEditors(form: HTMLElement, pictures: () => EditorPictures): void {
  releaseDetached();
  keepTextAsTyped();
  for (const field of form.querySelectorAll<HTMLElement>('[data-markdown-field]')) {
    const source = field.querySelector<HTMLTextAreaElement>('textarea');
    const host = field.querySelector<HTMLElement>('[data-markdown-editor]');
    if (source === null || host === null || editors.has(source)) continue;
    const editable = !source.matches(':disabled') && !source.readOnly;
    const name = source.getAttribute('aria-label') ?? 'text';
    host.innerHTML = editable ? toolbarMarkup(name) : '';
    const surface = document.createElement('div');
    surface.className = 'markdown-editor-frame';
    host.append(surface);
    let writing = false;
    const toolbar = host.querySelector<HTMLElement>('.markdown-toolbar');
    const refresh = (editor: Editor): void => {
      for (const button of toolbar?.querySelectorAll<HTMLButtonElement>('[data-markdown-command]') ?? [])
        button.setAttribute('aria-pressed', String(isActive(editor, button.dataset.markdownCommand as ToolbarCommandId)));
    };
    const editor = new Editor({
      element: surface,
      injectCSS: false,
      editable,
      extensions: [...editorExtensions(pictures), Markdown.configure({ marked: markdownReader() })],
      content: source.value,
      contentType: 'markdown',
      editorProps: {
        attributes: { class: 'markdown-body markdown-editor-surface', role: 'textbox', 'aria-multiline': 'true', 'aria-label': name,
          ...(source.required ? { 'aria-required': 'true' } : {}) },
      },
      onUpdate: ({ editor: changed }) => {
        writing = true;
        try {
          source.value = writtenMarkdown((changed as Editor & { markdown: MarkdownManager }).markdown, changed.getJSON());
          source.dispatchEvent(new Event('input', { bubbles: true }));
        } finally { writing = false; }
      },
      onSelectionUpdate: ({ editor: moved }) => refresh(moved),
      onTransaction: ({ editor: changed }) => refresh(changed),
    });
    editors.set(source, editor);
    mounted.add(editor);
    // The source typed under Markdown is shown in the editor as it is typed.
    source.addEventListener('input', () => { if (!writing) showSourceInEditor(source); });
    // A required field left empty is refused by the browser, which then has to focus the textarea:
    // opened first, so the refusal has somewhere to point.
    source.addEventListener('invalid', () => { const details = source.closest('details'); if (details) details.open = true; });

    if (toolbar === null) continue;
    // A press on the toolbar keeps the selection it acts on.
    toolbar.addEventListener('mousedown', event => { if ((event.target as Element).closest('button')) event.preventDefault(); });
    const linkForm = host.querySelector<HTMLElement>('[data-markdown-link-form]')!;
    const linkInput = host.querySelector<HTMLInputElement>('[data-markdown-link-input]')!;
    const linkError = host.querySelector<HTMLElement>('[data-markdown-link-error]')!;
    const closeLink = (): void => { linkForm.hidden = true; linkError.hidden = true; editor.commands.focus(); };
    toolbar.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-markdown-command]');
      if (button === null) return;
      const id = button.dataset.markdownCommand as ToolbarCommandId;
      if (id !== 'link') { run(editor, id); return; }
      linkInput.value = String(editor.getAttributes('link').href ?? '');
      linkForm.hidden = false;
      linkInput.focus();
    });
    linkForm.addEventListener('click', event => {
      const action = (event.target as Element).closest<HTMLButtonElement>('[data-markdown-link]')?.dataset.markdownLink;
      if (action === 'cancel') closeLink();
      else if (action === 'remove') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); closeLink(); }
      else if (action === 'apply') applyLink();
    });
    const applyLink = (): void => {
      const href = linkInput.value.trim();
      if (href === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); closeLink(); return; }
      if (!/^(https?:\/\/|mailto:)/i.test(href)) { linkError.hidden = false; return; }
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      closeLink();
    };
    // Enter in the address links rather than submitting the record's form; Escape closes it
    // rather than closing the record.
    linkInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLink(); }
    });
  }
}
