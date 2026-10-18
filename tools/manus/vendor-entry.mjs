// What the manuscript view takes from its dependencies, bundled into one module
// (extensions/manuscript/vendor/editor.js) by bundle.mjs.
export { Editor, Extension, InputRule, Mark, Node } from '@tiptap/core';
export { StarterKit } from '@tiptap/starter-kit';
export { Placeholder } from '@tiptap/extensions';
export { Plugin, PluginKey, TextSelection, EditorState } from '@tiptap/pm/state';
export { Decoration, DecorationSet } from '@tiptap/pm/view';
export { Slice, Fragment } from '@tiptap/pm/model';
export { Lexer } from 'marked';
export { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
