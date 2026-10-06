import { client } from './client';
import { messageFor } from './format';
import { proposedFileMarkup, readProposedFile } from './package-file-reader';

/**
 * The review's Read the whole file buttons (review R-017): each reads its file through the
 * host, bound to the digest on screen, and shows it in Nendo's own dialog with Copy.
 */
/** Wire the read buttons in a review that was just drawn. */
export function wirePackageFileReading(root: ParentNode, proposal: () => { proposalId: string; reviewedDigest: string } | null): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-package-read]')) {
    button.addEventListener('click', () => void openProposedFile(button, proposal()));
  }
}

async function openProposedFile(button: HTMLButtonElement, proposal: { proposalId: string; reviewedDigest: string } | null): Promise<void> {
  const packageId = button.dataset.packageId ?? '', path = button.dataset.packageRead ?? '';
  if (proposal === null || button.disabled) return;
  const note = button.parentElement?.querySelector<HTMLElement>('[data-package-read-note]') ?? null;
  button.disabled = true;
  if (note !== null) note.textContent = 'Reading…';
  try {
    const file = await readProposedFile({ ...proposal, packageId, path }, (method, payload) => client.request(method, payload));
    if (note !== null) note.textContent = '';
    const dialog = document.createElement('dialog');
    dialog.className = 'record-delete-dialog package-file-dialog';
    dialog.setAttribute('aria-labelledby', 'package-file-heading');
    dialog.innerHTML = proposedFileMarkup(path, file);
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector<HTMLButtonElement>('[data-copy]')?.addEventListener('click', (event) => {
      const copy = event.currentTarget as HTMLButtonElement;
      void navigator.clipboard.writeText(file.text ?? '').then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; });
    });
    dialog.showModal();
  } catch (error) {
    if (note !== null) note.textContent = messageFor(error);
  } finally {
    button.disabled = false;
  }
}
