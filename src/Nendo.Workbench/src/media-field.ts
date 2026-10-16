import { refreshAfterOutcome, showFailure } from './actions';
import { state } from './app-state';
import { client } from './client';
import { refuseWhileDirty } from './draft-guard';
import { escapeAttribute, mutationKey } from './format';
import type { DesktopMutationView, RecordPlan } from './host';
import { loadsWebPictures, mediaUrl, parseMediaAddress, setLoadsWebPictures } from './media-model';
import { setBusy, showError, showOutcome } from './shell';

/**
 * Picture fields at work on a record page (ADR-0031); media-markup.ts draws them. The field's
 * value travels in a hidden input, so the form saves it like any text; the picture actions write
 * at once, through the host, which reads every file, the clipboard and the web itself.
 */
export { mediaCoverMarkup, mediaFieldMarkup, mediaThumbMarkup } from './media-markup';

/** What the host answers a picture action with: the address now held and the write, or a cancel. */
export interface MediaActionView {
  cancelled: boolean;
  address: string | null;
  write: DesktopMutationView | null;
}

function targetOf(container: HTMLElement, entityId: string, record: RecordPlan): Record<string, unknown> {
  return { entityId, recordId: record.semanticId, fieldId: container.dataset.mediaField!, expectedRecordVersion: record.version };
}

async function runMediaAction(request: () => Promise<MediaActionView>, success: string, redraw: () => void): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const result = await request();
    if (result.cancelled || result.write === null) return;
    if (result.write.session !== null) state.session = result.write.session;
    await refreshAfterOutcome(result.write);
    redraw();
    showOutcome(success);
  } catch (error) {
    showFailure(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

async function setAddress(container: HTMLElement, entityId: string, record: RecordPlan, value: string | null, success: string, redraw: () => void): Promise<void> {
  await runMediaAction(async () => {
    const write = await client.request<DesktopMutationView>('data.setField', {
      ...targetOf(container, entityId, record), value, idempotencyKey: mutationKey(),
    });
    return { cancelled: false, address: value, write };
  }, success, redraw);
}

/** The larger view: the picture alone over the page, closed by its button, Escape or a click outside it. */
export function openMediaLightbox(url: string, label: string): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'media-lightbox';
  dialog.setAttribute('aria-label', label);
  dialog.innerHTML = `<button type="button" class="media-lightbox-close" aria-label="Close">✕</button><img src="${escapeAttribute(url)}" alt="${escapeAttribute(label)}" />`;
  const close = (): void => { dialog.close(); dialog.remove(); };
  dialog.querySelector('button')!.addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
}

function closeMenus(root: ParentNode, except: HTMLElement | null = null): void {
  for (const menu of root.querySelectorAll<HTMLElement>('.media-menu')) {
    if (menu === except) continue;
    menu.hidden = true;
    menu.parentElement?.querySelector('[data-media-menu-button]')?.setAttribute('aria-expanded', 'false');
  }
}

/** Wires every picture field in a record form; nothing is wired for a record not saved yet. */
export function wireMediaFields(form: HTMLElement, entityId: string, record: RecordPlan | null, redraw: () => void): void {
  // A picture that does not load is not there: the quiet row says so, with its address.
  form.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches('[data-media-img]')) return;
    const frame = image.closest('.media-frame');
    image.closest('[data-media-open]')?.setAttribute('hidden', '');
    frame?.querySelector<HTMLElement>('[data-media-missing]')?.removeAttribute('hidden');
  }, true);
  for (const container of form.querySelectorAll<HTMLElement>('[data-media-field]')) {
    const address = parseMediaAddress(container.dataset.mediaAddress ?? '');
    container.querySelector('[data-media-open]')?.addEventListener('click', () => {
      const url = address === null ? null : mediaUrl(address, state.session.mediaOrigin);
      if (url !== null) openMediaLightbox(url, container.querySelector('.media-field-label')?.textContent ?? 'Picture');
    });
    const menuButton = container.querySelector<HTMLButtonElement>('[data-media-menu-button]');
    const menu = container.querySelector<HTMLElement>('.media-menu');
    menuButton?.addEventListener('click', () => {
      if (menu === null) return;
      closeMenus(form, menu);
      menu.hidden = !menu.hidden;
      menuButton.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    });
    menu?.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeMenus(form);
      menuButton?.focus();
    });
    if (record === null) continue;
    const saved = record;
    const webForm = container.querySelector<HTMLElement>('[data-media-web-form]');
    const act = (action: string): void => {
      closeMenus(form);
      if (action === 'web-on') { setLoadsWebPictures(true); redraw(); return; }
      if (action === 'web-off') { setLoadsWebPictures(false); redraw(); showOutcome('Pictures from the internet are no longer loaded on this device.'); return; }
      if (action === 'web') { if (webForm) { webForm.hidden = false; webForm.querySelector<HTMLInputElement>('input')?.focus(); } return; }
      if (action === 'web-cancel') { if (webForm) webForm.hidden = true; return; }
      if (action === 'save') {
        void runMediaAction(() => client.request<MediaActionView>('media.saveCopy', { address: address?.value }), 'Picture saved.', () => {});
        return;
      }
      if (action === 'reveal') { void client.request('media.reveal', { address: address?.value }).catch(error => showFailure(error)); return; }
      // Everything else writes the record, which unsaved typing would then be a version behind.
      if (refuseWhileDirty('changing the picture')) return;
      const target = targetOf(container, entityId, saved);
      switch (action) {
        case 'pick': void runMediaAction(() => client.request<MediaActionView>('media.embed', { ...target, source: 'pick' }), 'Picture embedded.', redraw); break;
        case 'paste': void runMediaAction(() => client.request<MediaActionView>('media.embed', { ...target, source: 'paste' }), 'Picture pasted.', redraw); break;
        case 'link': void runMediaAction(() => client.request<MediaActionView>('media.link', target), 'Picture linked.', redraw); break;
        case 'embed-copy': void runMediaAction(() => client.request<MediaActionView>('media.embedCopy', { ...target, address: address?.value }), 'A copy is now in the file.', redraw); break;
        case 'remove': void setAddress(container, entityId, saved, null, 'Picture removed from the record.', redraw); break;
        case 'web-save': {
          const value = webForm?.querySelector<HTMLInputElement>('input')?.value.trim() ?? '';
          const parsed = parseMediaAddress(value);
          if (parsed?.source !== 'web') { showError('Use an https: address, such as https://example.org/cover.jpg.'); return; }
          void setAddress(container, entityId, saved, value, 'Picture linked from the web.', redraw);
          break;
        }
      }
    };
    container.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-media-action]');
      if (button === null || button.disabled || !container.contains(button)) return;
      act(button.dataset.mediaAction!);
    });
    // Paste a picture while the field has the focus: the host reads the clipboard itself.
    container.addEventListener('paste', event => {
      if ((event.target as Element).closest('input[type="url"]')) return;
      event.preventDefault();
      act('paste');
    });
    for (const zone of container.querySelectorAll<HTMLElement>('[data-media-drop]')) {
      zone.addEventListener('dragover', event => {
        if (!state.session.capabilities.mutate) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        zone.classList.add('is-drop-target');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-drop-target'));
      zone.addEventListener('drop', event => {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove('is-drop-target');
        const file = event.dataTransfer?.files[0];
        if (file === undefined) return;
        if (refuseWhileDirty('changing the picture')) return;
        if (client.embedDroppedPicture === undefined) { showError('This Nendo cannot take a dropped picture. Use Choose picture… instead.'); return; }
        void runMediaAction(() => client.embedDroppedPicture!<MediaActionView>({ ...targetOf(container, entityId, saved), source: 'drop' }, file),
          'Picture embedded.', redraw);
      });
    }
  }
  form.addEventListener('click', event => {
    if (!(event.target as Element).closest('[data-media-menu-button], .media-menu')) closeMenus(form);
  });
}

/** A thumbnail that does not load is marked missing, wherever it is drawn; wired once for the document. */
export function wireMediaThumbnails(root: Document): void {
  root.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches('[data-media-thumb]')) return;
    image.parentElement?.classList.add('is-missing');
    image.remove();
  }, true);
}

/** Whether this device shows web pictures; exported for the list and gallery thumbnails. */
export { loadsWebPictures };
