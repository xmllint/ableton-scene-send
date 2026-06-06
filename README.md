# Ableton SceneSend

Ableton Live 12 Extension — right-click any Scene row and copy every clip in
that row into the Arrangement at a chosen locator. Session clips stay put.

## Features

- Right-click a Scene → pick a named locator → all clips in that row land in Arrangement
- Works with both MIDI and audio clips
- Open-ended session clips handled (derives duration from note content)
- Single undo step for the entire scene drop
- Warns if no named locators exist on startup

## Install

Drag `scene-send.ablx` onto Ableton Live 12 Beta.
Developer Mode is only needed when building from source — turn it off for normal use.

## Usage

1. **First:** install [ableton-cue-templates](https://github.com/xmllint/ableton-cue-templates)
   to quickly drop genre-specific locators into your arrangement.
2. Right-click any Scene row → **Send to «Chorus»**
3. All clips in that row appear in Arrangement at the locator position

## Build from source

```bash
npm install
npm run build       # tsc + esbuild
npm run package     # creates .ablx
```

Requires the Ableton Extensions SDK v1.0.0-beta.0 (Centercode beta program).

## License

MIT
