// The address file a fixture server writes for the lane that started it. The lanes read it
// the moment it exists, and a plain write creates the file empty before it fills it, so a
// lane could read nothing and fail for no reason of the product's. Written beside its final
// name and renamed into place, it exists only once it is whole.
import { promises as defaultFs } from 'node:fs';

export async function writeInfoFile(file, text, fs = defaultFs) {
  const partial = `${file}.${process.pid}.partial`;
  await fs.writeFile(partial, text, 'utf8');
  await fs.rename(partial, file);
}
