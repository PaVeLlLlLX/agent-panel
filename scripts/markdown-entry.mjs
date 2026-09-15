// Точка входа сборки для webview: markdown-it и KaTeX вместе с правилом
// формул в один файл, PanelMarkdown — в глобальной области для panel.js.
import markdownit from "markdown-it";
import katex from "katex";
import api from "../media/markdown.js";

globalThis.PanelMarkdown = { render: api.createRenderer(markdownit, katex) };
