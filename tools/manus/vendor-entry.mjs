// What the manuscript view takes from its dependencies, bundled into one module
// (extensions/manuscript/vendor/editor.js) by bundle.mjs.
export { Editor, Extension, Mark, Node } from '@tiptap/core';
export { StarterKit } from '@tiptap/starter-kit';
export { Placeholder } from '@tiptap/extensions';
export { Plugin, PluginKey } from '@tiptap/pm/state';
export { Lexer } from 'marked';
