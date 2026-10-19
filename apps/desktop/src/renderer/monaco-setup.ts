// Bundles Monaco locally (no CDN) so the editor works offline under the strict CSP.
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}

// Project files are opened individually; without the whole program, semantic errors are noise.
const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false }
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics)
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics)
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
})

// Editor themes in the app palette (Monaco needs hex; values are the sRGB form of the CSS tokens).
monaco.editor.defineTheme('mac-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'b58dff' },
    { token: 'string', foreground: '66da85' },
    { token: 'number', foreground: 'eebc4a' },
    { token: 'comment', foreground: '78746e', fontStyle: 'italic' },
    { token: 'type', foreground: '43d5dc' },
  ],
  colors: {
    'editor.background': '#0e0c0a',
    'editor.foreground': '#f1eee9',
    'editorLineNumber.foreground': '#78746e',
    'editorLineNumber.activeForeground': '#afaaa4',
    'editor.lineHighlightBackground': '#1c1916',
    'editor.selectionBackground': '#b58dff40',
    'editorCursor.foreground': '#b58dff',
    'editorIndentGuide.background1': '#2c2824',
    'editorWidget.background': '#1c1916',
    'editorWidget.border': '#3f3935',
    'diffEditor.insertedTextBackground': '#66da8524',
    'diffEditor.removedTextBackground': '#fa686324',
    'diffEditor.insertedLineBackground': '#66da8514',
    'diffEditor.removedLineBackground': '#fa686314',
  },
})
monaco.editor.defineTheme('mac-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7a40da' },
    { token: 'string', foreground: '0a7e3a' },
    { token: 'number', foreground: 'aa6a00' },
    { token: 'comment', foreground: '867f79', fontStyle: 'italic' },
    { token: 'type', foreground: '00798c' },
  ],
  colors: {
    'editor.background': '#f9f6f2',
    'editor.foreground': '#1a1512',
    'editorLineNumber.foreground': '#867f79',
    'editor.lineHighlightBackground': '#f3f0eb',
    'editor.selectionBackground': '#7a40da2e',
    'editorCursor.foreground': '#7a40da',
    'editorWidget.background': '#fefdfb',
    'editorWidget.border': '#cecac3',
  },
})

loader.config({ monaco })

export { monaco }
