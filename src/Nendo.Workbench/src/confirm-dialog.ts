/**
 * A question asked in Nendo's own modal dialog: Cancel, which has the focus, or the one
 * action named. Resolves true only when that action is pressed; Cancel, Escape and closing
 * the dialog any other way resolve false. The dialog removes itself once it closes.
 *
 * The body is markup, so the caller escapes whatever text it puts there.
 */
export function confirmDialog(question: { headingId: string; title: string; bodyHtml: string; confirmLabel: string }): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-delete-dialog';
    dialog.setAttribute('aria-labelledby', question.headingId);
    dialog.innerHTML = `<h2 id="${question.headingId}">${question.title}</h2>${question.bodyHtml}
      <div class="form-actions"><button class="secondary-button" data-cancel type="button" autofocus>Cancel</button><button class="primary-button" data-confirm type="button">${question.confirmLabel}</button></div>`;
    document.body.append(dialog);
    let confirmed = false;
    dialog.addEventListener('close', () => { dialog.remove(); resolve(confirmed); }, { once: true });
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-confirm]')?.addEventListener('click', () => { confirmed = true; dialog.close(); });
    dialog.showModal();
  });
}
