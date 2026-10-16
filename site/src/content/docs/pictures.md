---
title: Pictures
description: Picture fields, the three places a picture can come from, and what Nendo does with each.
group: Use
order: 25
---

A record can carry a picture: a cover for an album, a photo of a plant, a scan of a
receipt. A picture field holds an address, and the address says where the picture
is. This page covers adding one, the three places a picture can come from, and the
limits. The repository's `workspace/Herbarium.nendo` shows all of it in seven
plants.

## Add a picture field

In **Studio → Structure**, add a field of type **Picture**. A text field whose
values are all picture addresses can also be shown as a picture. A gallery can use
a picture field as its **cover**, so each card is topped with the record's picture.
Lists and boards show a small preview in the field's column.

## Where a picture comes from

| Source | Address | What it means |
| --- | --- | --- |
| In file | `media:` and a SHA-256 hash | The picture is stored in the `.nendo` file once, however many records name it. It travels with the file. |
| Linked file | A path such as `C:\Photos\fern.jpg`, or `.\Pictures\fern.jpg` beside the file | The picture stays on this computer. A path that starts with `.\` is read from the folder that holds the `.nendo` file, so the file and its folder of pictures can move together. |
| Web | An `https:` address | The picture is shown from the internet while this device loads web pictures. |

Nendo stores PNG, JPEG, GIF, WebP, AVIF and SVG pictures, and reads a picture's
type from its first bytes rather than from its name. `http:` addresses and network
shares are refused.

## On a record page

An empty picture field is a drop zone. Drop a picture file on it, paste one from
the clipboard, or choose **Choose picture…**, **Link a file…** or **Web address…**.
The picture's menu (**⋯**) saves a copy, brings a linked or web picture into the
file with **Embed a copy**, shows a linked file in its folder, and removes the
picture from the record. Each of these is saved at once, as one change in History,
so it waits while the record has unsaved typing.

Click a picture to see it larger. A picture that cannot be shown says so and shows
its address. Web pictures load unless you turn **Load pictures from the internet**
off from a web picture's menu; that choice belongs to this device.

A Markdown field shows `![a description](address)` as the picture when the address
is a picture's address. Any other address stays as its description.

## Limits

- A picture is at most **64 MiB**.
- A file holds at most **2 GiB** of pictures. Opening a file reads none of them; the
  explicit integrity check in Health reads every one.
- A picture taken out of a record stays in the file while its change can still be
  undone. **Studio → History** shows how much the file's pictures weigh and how much
  no record names any more. Once older history is folded, **Remove unused pictures…**
  backs the file up beside itself, removes them and makes the file smaller.

## CSV, agents and views

A CSV export writes a picture field's address. **Export with pictures** also writes
the file's pictures into a `Media` folder beside the CSV, and names each there by its
path. Import that CSV into a file in the same folder, then choose **File → Embed
linked pictures…** to bring the pictures into the file. A CSV that names a picture
the file does not hold is refused at review, naming the row.

An agent embeds a picture with `nendo.data.put_media` and reads one through
`nendo://application/media/{sha256}`; see [Agents](/nendo/docs/agents). A custom
view uses `nendo.media`; see [Custom views](/nendo/docs/custom-views).
