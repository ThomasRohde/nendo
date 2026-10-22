import { pastedName, pictureAccept, pictureChunks, picturesMarkup, takePictures, type HeldPicture } from './agent-image-model';
import { composerNote } from './agent-mention';
import { announce } from './shell';

/**
 * Pictures in the agent tab's message box: pasted into it, dropped on it, or picked with its
 * picture button. They are kept here, as the person's own files, until the message goes; then
 * each is staged with the host in chunks and the message names it. A message the host refuses
 * keeps them, and the next send stages them again under new keys.
 */

let held: Array<HeldPicture & { file: Blob }> = [];
let pasted = 0;

/** The agent the box writes to: whether it reads pictures, and its name for the line that says it does not. */
export interface PictureAgent { takesImages: boolean; name: string }

export function heldPictureCount(): number {
  return held.length;
}

/** Forget every picture: a new file or a new session is a new conversation. */
export function resetPictures(): void {
  held = [];
  pasted = 0;
}

export function clearPictures(page: ParentNode): void {
  resetPictures();
  drawPictures(page);
}

function drawPictures(page: ParentNode): void {
  const row = page.querySelector<HTMLElement>('#chat-pictures');
  if (row === null) return;
  row.innerHTML = picturesMarkup(held);
  row.hidden = held.length === 0;
}

function add(page: ParentNode, files: readonly File[], from: 'paste' | 'drop' | 'pick', agent: PictureAgent): void {
  const named = files.map((file) => ({
    file,
    name: from === 'paste' || file.name === '' ? pastedName(file.type, ++pasted) : file.name,
    type: file.type,
    size: file.size,
  }));
  const { accepted, note } = takePictures(held, named, agent.takesImages, agent.name);
  for (const index of accepted) {
    const { file, name, type, size } = named[index];
    held.push({ key: `picture-${crypto.randomUUID()}`, name, type, size, file });
  }
  drawPictures(page);
  composerNote(page, note, 'mention');
  if (accepted.length > 0)
    announce(accepted.length === 1 ? `${named[accepted[0]].name} goes with this message.` : `${accepted.length} pictures go with this message.`);
}

function draggedFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && [...transfer.items].some((item) => item.kind === 'file');
}

/** Wire the box, the picture button and the chips of a freshly drawn tab. */
export function wirePictures(page: HTMLElement, agent: () => PictureAgent): void {
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  const composer = page.querySelector<HTMLFormElement>('#chat-composer')!;
  const picker = page.querySelector<HTMLInputElement>('#chat-picture-input')!;
  picker.accept = pictureAccept;
  page.querySelector<HTMLButtonElement>('#chat-add-picture')!.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    add(page, [...picker.files ?? []], 'pick', agent());
    picker.value = '';
    prompt.focus();
  });
  // A copied picture comes as a file; text copied with it (a page's picture and its caption)
  // is still pasted as text.
  prompt.addEventListener('paste', (event) => {
    const files = [...event.clipboardData?.files ?? []];
    if (files.length === 0) return;
    if (!(event.clipboardData?.types.includes('text/plain') ?? false)) event.preventDefault();
    add(page, files, 'paste', agent());
  });
  // The composer carries data-media-drop, so the window's own drop (open a .nendo file) leaves a
  // file let go over it to this one.
  composer.addEventListener('dragover', (event) => {
    if (!draggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
    composer.classList.add('is-drop-target');
  });
  composer.addEventListener('dragleave', (event) => {
    if (!(event.relatedTarget instanceof Node && composer.contains(event.relatedTarget))) composer.classList.remove('is-drop-target');
  });
  composer.addEventListener('drop', (event) => {
    composer.classList.remove('is-drop-target');
    if (!draggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    add(page, [...event.dataTransfer?.files ?? []], 'drop', agent());
    prompt.focus();
  });
  page.querySelector<HTMLElement>('#chat-pictures')!.addEventListener('click', (event) => {
    const remove = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-remove-picture]') : null;
    if (remove === null) return;
    const gone = held.find((picture) => picture.key === remove.dataset.removePicture);
    held = held.filter((picture) => picture.key !== remove.dataset.removePicture);
    drawPictures(page);
    composerNote(page, null, 'mention');
    prompt.focus();
    if (gone !== undefined) announce(`${gone.name} no longer goes with this message.`);
  });
  drawPictures(page);
}

/**
 * Stage every picture with the host, chunk by chunk, under a key of its own for this send, and
 * answer what the message names. A failed chunk throws, and the message is not sent.
 */
export async function stagePictures(stage: (payload: Record<string, unknown>) => Promise<unknown>): Promise<Array<{ uploadKey: string; name: string }>> {
  const named: Array<{ uploadKey: string; name: string }> = [];
  for (const picture of held) {
    const uploadKey = `picture-${crypto.randomUUID()}`;
    for (const chunk of pictureChunks(new Uint8Array(await picture.file.arrayBuffer()))) await stage({ uploadKey, ...chunk });
    named.push({ uploadKey, name: picture.name });
  }
  return named;
}
