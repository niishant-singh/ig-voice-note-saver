# IG Voice Note Saver (v0.1)

Saves voice notes from an Instagram DM chat you have open, into
`Downloads/IG Voice Notes/<chat name>/001.m4a, 002.m4a, ...` (oldest first).

## Install (unpacked)
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open instagram.com, open a DM chat, click the extension icon.
4. Click **Save all voice notes in this chat**.

## How it works
1. Scrolls the chat to the top so the full history loads.
2. Walks back down; for each voice note it clicks play (tab is muted).
3. The background worker catches the audio file's CDN URL and downloads it.

## If it finds 0 voice notes
Instagram's markup changes. Right-click a voice note's play button ->
Inspect, read its `aria-label`, and update `PRIMARY_LABEL` at the top of
`content.js`. Reload the extension and the Instagram tab.

## If it doesn't scroll
The scroll container detection is a heuristic (`getScroller` in content.js).
Check in the console which element it picks.

## Notes
- Only saves permanent voice notes you can already replay. It does not touch
  view-once / vanishing-mode messages.
- Personal backup use only; keep the speed gentle (don't lower the delays a lot).
- Files are saved as .m4a (AAC audio).
