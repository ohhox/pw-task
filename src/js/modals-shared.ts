// ─── MODALS / SHARED ─────────────────────────────────────────────────────────
// Base modal builder + typed query helpers used by all modal submodules.

export type ModalConfirmFn = (ov: HTMLElement) => boolean | void;

export const qInput = (root: ParentNode, sel: string): HTMLInputElement =>
  root.querySelector(sel) as HTMLInputElement;
export const qSelect = (root: ParentNode, sel: string): HTMLSelectElement =>
  root.querySelector(sel) as HTMLSelectElement;
export const qTextarea = (root: ParentNode, sel: string): HTMLTextAreaElement =>
  root.querySelector(sel) as HTMLTextAreaElement;
export const qBtn = (root: ParentNode, sel: string): HTMLButtonElement =>
  root.querySelector(sel) as HTMLButtonElement;

export function showModal(
  html: string,
  onConfirm: ModalConfirmFn,
  confirmText: string = 'Confirm',
  isDanger: boolean = false
): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal">${html}<div class="modal-actions">
    <button class="modal-btn" id="m-cancel">Cancel</button>
    <button class="modal-btn ${isDanger ? 'danger' : 'primary'}" id="m-confirm">${confirmText}</button>
  </div></div>`;
  document.body.appendChild(ov);
  const close = (): void => { document.body.removeChild(ov); };
  qBtn(ov, '#m-cancel').addEventListener('click', close);
  qBtn(ov, '#m-confirm').addEventListener('click', () => {
    const prevent = onConfirm(ov);
    if (prevent !== false) close();
  });
  setTimeout(() => {
    const focusable = ov.querySelector<HTMLElement>('.modal-input, textarea, select');
    focusable?.focus();
  }, 50);
  return ov;
}
