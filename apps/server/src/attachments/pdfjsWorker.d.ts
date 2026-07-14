/**
 * pdfjs ships **no type declaration for its worker bundle**, and that is correct: it is a bundle,
 * not an API. Nothing calls into it.
 *
 * We import it for one reason — to hand it to `globalThis.pdfjsWorker`, which pdfjs checks
 * (`PDFWorker.#mainThreadWorkerMessageHandler`) *before* it falls back to loading the worker from
 * disk with `await import('../pdf.worker.mjs')`. That path is relative to pdfjs's own module, and
 * inside `bun build --compile` it resolves to `/$bunfs/root/...`, which does not exist. See
 * `attachmentIngest.ts:loadPdfJs`.
 *
 * `unknown`, not `any`: we never touch it, so we should not be able to.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  const worker: unknown;
  export default worker;
}
