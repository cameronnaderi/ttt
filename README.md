# DialTone

A 1990s-style desktop in the browser: instant messenger with buddy lists, chat rooms,
a web browser (WebSurfer) with message boards and a guestbook, and a radio.

## Run it on your computer

1. Install Node.js 18 or newer from https://nodejs.org
2. In this folder, run:

       node server.js

3. Open http://localhost:3000

There is nothing else to install. Accounts, buddy lists, saved chats, the guestbook and the
message boards are stored in `data/dialtone.json`, which is created on first run. Photos
posted to the message boards are stored in `data/uploads/`.

## Put it online

Any host that runs a Node.js web service will work. The requirements are:

- **Start command:** `node server.js`
- **Port:** the server reads the `PORT` environment variable (default 3000).
- **A persistent disk.** Set `DATA_DIR` to a folder on a disk that survives restarts.
  Without one, every account and message is erased whenever the host restarts the app.
- **HTTPS.** Use the host's HTTPS address. People type passwords into this app.
- **One instance only.** Live messaging is held in the server's memory, so do not scale to
  more than one copy of the app.

Back up the whole `data` folder regularly. It holds the database and the uploaded photos.

## DialMail

Members choose a handle such as `name@dialtone.web` and can mail each other with photo
attachments. Mail is internal only; it cannot reach or receive outside email addresses.
Messages and photos are encrypted in the sender's browser, so the server, and you as its
operator, store only scrambled text. The server can still see who mailed whom and when.
Each mailbox key is stored on the server under the member's account; if it is lost, that
member's old mail cannot be opened.

## Owner commands

Stop the server before running these, then start it again.

    node server.js emails                          # list screen names and email addresses
    node server.js reset "Screen Name" newpassword # reset a forgotten password

## Radio presets

Edit `public/stations.json`.

- `embeds` are web pages shown inside the Radio window (the ten AccuRadio year channels).
- `streams` are direct audio stream addresses that the Radio plays itself.

The stream addresses that ship in this file were written from memory and have **not** been
tested. Try each button after you deploy and correct any that show NO SIGNAL. Before a public
launch, check each station's terms to confirm it permits its stream or player in another app.

## What to expect from the live web and radio

- WebSurfer shows a real site inside its window when that site allows it. Many large sites
  (banks, Google, most sign-in pages) refuse to be shown inside another page. For those,
  WebSurfer explains and offers a link that opens a normal browser tab.
- Once a real site is showing, links you click inside it do not update the Address bar or
  the Back button, because browsers hide that from the surrounding page.
- A site served over plain `http://` will not display when DialTone itself is on HTTPS.
- A year button on the Radio shows that station's own player, with its own layout, ads and
  controls. If the station refuses to be shown inside another window, the Radio offers a
  new-tab link instead.

## Limits

- Email addresses are collected but not verified. The app does not send email.
- Messages are delivered only to people who are signed on. Each person's own copy of a
  conversation is saved to their account.
- Storage is a single JSON file, which suits a small community. A large public service
  should move to a real database.
- There are no moderator tools in the app. To remove a post, stop the server and edit
  `data/dialtone.json`.
