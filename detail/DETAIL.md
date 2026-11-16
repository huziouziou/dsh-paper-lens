![Paper Lens in action: a paper in the right sidebar with a selected passage, a floating toolbar and a translation bubble, plus an annotation highlight on the page](overview.svg)

**Read papers inside DSH: open the PDF in the sidebar, select text to translate, quote or annotate — no window switching, no copy-paste.**

1. **PDF in the sidebar** — rendered with pdf.js, with zoom, fit-to-width and page jump. Scroll to the exact line where you left; switching conversations and coming back restores the position, not the top of the page.
2. **Translate a selection** — streaming Chinese (or one of ten target languages) with paragraph-level parallelism and a local cache keyed by model and source text. Long passages keep streaming into a draggable bubble you can copy from.
3. **Quote into the chat** — the selected passage is inserted as a markdown quote with its page reference (`p.2–3` for cross-page selections). Running headers, license banners and page-number labels are stripped before the text leaves the page.
4. **Annotate** — four highlight colors, an optional note per annotation, drag the card anywhere, and jump back to any annotation from the sidebar list. Marks are stored next to the PDF, so they travel with the file.
5. **Clickable citations** — a citation such as `[main.pdf p.7 "exact words"]` written by the model becomes a link that opens the PDF at that page and highlights the sentence.

Three translation engines are mutually exclusive and picked in settings: follow the session model (default), pin a provider/model, or call any OpenAI-compatible endpoint — including a local llama.cpp server running a small translation model, started on demand and shut down after ten minutes idle. The settings panel shows which route is actually in effect, so credentials and model names never have to be guessed.
